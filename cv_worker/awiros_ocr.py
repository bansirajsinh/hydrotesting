"""Indian-plate OCR adapter for FastALPR using the Awiros PP-OCRv5 recognizer.

The recognizer operates on a cropped plate, supplied by FastALPR's detector.
Weights and PaddleOCR source are downloaded separately by scripts/setup-indian-ocr.py.
No weights or PaddleOCR source are vendored into this project.

Model information and reference inference architecture:
https://huggingface.co/Awiros/anpr-ocr
"""
from __future__ import annotations

import copy
import os
import re
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fast_alpr.alpr import BaseOCR, OcrResult

SCRIPT_DIR = Path(__file__).resolve().parent
MODEL_DIR = Path(os.getenv("AWIROS_MODEL_DIR", str(SCRIPT_DIR / "models" / "awiros_anpr"))).expanduser().resolve()
PADDLEOCR_DIR = Path(os.getenv("AWIROS_PADDLEOCR_DIR", str(SCRIPT_DIR / "vendor" / "PaddleOCR"))).expanduser().resolve()
WEIGHTS_PATH = Path(os.getenv("AWIROS_WEIGHTS_PATH", str(MODEL_DIR / "model.safetensors"))).expanduser().resolve()
DICT_PATH = Path(os.getenv("AWIROS_DICT_PATH", str(MODEL_DIR / "en_dict.txt"))).expanduser().resolve()

# Matches the model publisher's model configuration in Awiros/anpr-ocr/test.py.
CTC_NUM_CLASSES = 64
NRTR_NUM_CLASSES = 67  # PP-OCRv5's NRTRHead adds one class internally.
MODEL_CONFIG: dict[str, Any] = {
    "Architecture": {
        "model_type": "rec",
        "algorithm": "SVTR_HGNet",
        "Transform": None,
        "Backbone": {"name": "PPHGNetV2_B4", "text_rec": True},
        "Head": {
            "name": "MultiHead",
            "out_channels_list": {
                "CTCLabelDecode": CTC_NUM_CLASSES,
                "NRTRLabelDecode": NRTR_NUM_CLASSES,
            },
            "head_list": [
                {
                    "CTCHead": {
                        "Neck": {
                            "name": "svtr",
                            "dims": 120,
                            "depth": 2,
                            "hidden_dims": 120,
                            "kernel_size": [1, 3],
                            "use_guide": True,
                        },
                        "Head": {"fc_decay": 1e-5},
                    }
                },
                {"NRTRHead": {"nrtr_dim": 384, "max_text_length": 25}},
            ],
        },
    },
}
IMAGE_SHAPE = (3, 48, 320)


def _normalize_text(text: str) -> str:
    # Preserve potentially ambiguous OCR characters; only remove separators.
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper())


def _looks_like_indian_plate(text: str) -> bool:
    """A ranking aid, not legal validation. Special/legacy formats may differ."""
    plate = _normalize_text(text)
    return bool(
        re.fullmatch(r"[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}", plate)
        or re.fullmatch(r"\d{2}BH\d{4}[A-HJ-NP-Z]{1,2}", plate)
    )


def _resize_for_recognition(image_bgr: np.ndarray) -> np.ndarray:
    _, target_h, target_w = IMAGE_SHAPE
    image_h, image_w = image_bgr.shape[:2]
    if image_h < 1 or image_w < 1:
        raise ValueError("Empty plate crop")
    ratio = target_h / float(image_h)
    new_w = max(1, min(int(round(image_w * ratio)), target_w))
    resized = cv2.resize(
        image_bgr,
        (new_w, target_h),
        interpolation=cv2.INTER_CUBIC if ratio > 1 else cv2.INTER_AREA,
    )
    padded = np.zeros((target_h, target_w, 3), dtype=np.uint8)
    padded[:, :new_w, :] = resized
    return padded


def _preprocess_for_paddle(image_bgr: np.ndarray) -> np.ndarray:
    image = _resize_for_recognition(image_bgr).astype(np.float32) / 255.0
    image = (image - 0.5) / 0.5
    return image.transpose((2, 0, 1))


class AwirosIndianOCR(BaseOCR):
    """FastALPR-compatible OCR using the Indian-specific Awiros recognizer.

    One instance loads the 37M-parameter model once per scanner process and is
    reused for all detected plate crops in that process.
    """

    def __init__(self, retry_below: float = 0.82, device: str | None = None) -> None:
        if not WEIGHTS_PATH.is_file():
            raise FileNotFoundError(
                f"Awiros OCR weights not found at {WEIGHTS_PATH}. "
                "Run: python scripts/setup-indian-ocr.py"
            )
        if not DICT_PATH.is_file():
            raise FileNotFoundError(
                f"Awiros character dictionary not found at {DICT_PATH}. "
                "Run: python scripts/setup-indian-ocr.py"
            )
        if not (PADDLEOCR_DIR / "ppocr" / "__init__.py").is_file():
            raise FileNotFoundError(
                f"PaddleOCR source not found at {PADDLEOCR_DIR}. "
                "Run: python scripts/setup-indian-ocr.py"
            )

        paddle_root = str(PADDLEOCR_DIR)
        if paddle_root not in sys.path:
            sys.path.insert(0, paddle_root)

        try:
            import paddle
            from safetensors.numpy import load_file
            # pyrefly: ignore [missing-import]
            from ppocr.modeling.architectures import build_model
            # pyrefly: ignore [missing-import]
            from ppocr.postprocess import build_post_process
        except Exception as exc:
            raise RuntimeError(
                "Awiros OCR dependencies are incomplete. Install cv_worker/requirements-india.txt "
                "in the same Python environment used by the scanner. "
                f"Import error: {type(exc).__name__}: {exc}"
            ) from exc

        self._paddle = paddle
        self.retry_below = max(0.0, min(float(retry_below), 1.0))
        requested_device = (device or os.getenv("AWIROS_DEVICE", "cpu")).lower()
        if requested_device == "gpu" and paddle.is_compiled_with_cuda():
            paddle.set_device("gpu")
            self.device = "gpu"
        else:
            paddle.set_device("cpu")
            self.device = "cpu"

        self._post_process = build_post_process({
            "name": "CTCLabelDecode",
            "character_dict_path": str(DICT_PATH),
            "use_space_char": True,
        })
        self._model = build_model(copy.deepcopy(MODEL_CONFIG)["Architecture"])
        self._model.eval()
        state = load_file(str(WEIGHTS_PATH))
        self._model.set_state_dict({key: paddle.to_tensor(value) for key, value in state.items()})

    def _infer_once(self, crop: np.ndarray) -> tuple[str, float]:
        tensor = self._paddle.to_tensor(np.expand_dims(_preprocess_for_paddle(crop), axis=0))
        with self._paddle.no_grad():
            prediction = self._model(tensor)
        if isinstance(prediction, dict):
            prediction_tensor = prediction["ctc"] if "ctc" in prediction else next(iter(prediction.values()))
        elif isinstance(prediction, (list, tuple)):
            prediction_tensor = prediction[0]
        else:
            prediction_tensor = prediction
        decoded = self._post_process(prediction_tensor.numpy())
        if not isinstance(decoded, (list, tuple)) or not decoded:
            return "", 0.0
        text, confidence = decoded[0]
        try:
            score = float(confidence)
            if score > 1.0 and score <= 100.0:
                score /= 100.0
        except (TypeError, ValueError):
            score = 0.0
        return str(text or "").strip().upper(), max(0.0, min(1.0, score))

    def predict(self, cropped_plate: np.ndarray) -> OcrResult | None:
        if cropped_plate is None or not isinstance(cropped_plate, np.ndarray) or cropped_plate.size == 0:
            return None
        try:
            crop = cropped_plate
            if crop.ndim == 2:
                crop = cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR)
            if crop.shape[2] == 4:
                crop = cv2.cvtColor(crop, cv2.COLOR_BGRA2BGR)

            raw_text, confidence = self._infer_once(crop)
            best_text, best_conf = raw_text, confidence

            # Cheap original-image inference first. Only run additional variants
            # on low-confidence or non-plate-shaped predictions to keep throughput high.
            if confidence < self.retry_below or not _looks_like_indian_plate(raw_text):
                gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
                enhanced_gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
                enhanced = cv2.cvtColor(enhanced_gray, cv2.COLOR_GRAY2BGR)
                alt_text, alt_conf = self._infer_once(enhanced)
                # Prefer a plausible supported Indian format if the primary output
                # is not plate-shaped; otherwise prefer the larger model confidence.
                if _looks_like_indian_plate(alt_text) and not _looks_like_indian_plate(best_text):
                    best_text, best_conf = alt_text, alt_conf
                elif alt_conf > best_conf:
                    best_text, best_conf = alt_text, alt_conf

            best_text = _normalize_text(best_text)
            if not best_text:
                return None
            return OcrResult(text=best_text, confidence=best_conf)
        except Exception:
            # Let the outer scanner handle an OCR failure as missing evidence. Do
            # not return a made-up string and do not block the whole video.
            return None
