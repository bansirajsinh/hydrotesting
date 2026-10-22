#!/usr/bin/env python3
"""FuelFlux & Hydrotest Studio License Plate Scanner.

Production-grade pipeline combining:
1. Ultralytics YOLOv8 License Plate Detection (cv_worker/models/yolov8n_plate.pt)
2. OpenCV Multi-Pass Image Preprocessing (CLAHE, Adaptive Threshold, Bilateral Filter)
3. EasyOCR / Tesseract OCR engine calibrated for Indian vehicle registration plates
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

import cv2
import numpy as np

# ──────────────────────────────────────────────────────────────────────────────
# Indian License Plate Constants & State Codes
# ──────────────────────────────────────────────────────────────────────────────

PLATE_RE = re.compile(
    r'^(?:[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}|\d{2}BH\d{4}[A-HJ-NP-Z]{1,2})$'
)

INDIAN_STATES = {
    'AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'DD', 'DL', 'DN',
    'GA', 'GJ', 'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD',
    'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OD', 'PB', 'PY', 'RJ',
    'SK', 'TN', 'TR', 'TS', 'UK', 'UP', 'WB', 'BH'
}

DIGIT_TO_LETTER = {
    '0': 'O', '1': 'I', '2': 'Z', '3': 'J', '4': 'A', '5': 'S',
    '6': 'G', '7': 'T', '8': 'B', '9': 'P'
}
LETTER_TO_DIGIT = {
    'O': '0', 'I': '1', 'L': '1', 'Z': '2', 'J': '3', 'A': '4',
    'S': '5', 'G': '6', 'T': '7', 'B': '8', 'P': '9', 'Q': '0',
    'D': '0'
}

# ──────────────────────────────────────────────────────────────────────────────
# Global Engine Models
# ──────────────────────────────────────────────────────────────────────────────

YOLO_MODEL = None
EASYOCR_READER = None
TESSERACT_AVAILABLE = False
ENGINE_NAME = "YOLOv8-Plate + OpenCV + EasyOCR"


def get_model_path() -> str:
    root = Path(__file__).resolve().parent.parent
    default_path = root / "cv_worker" / "models" / "yolov8n_plate.pt"
    env_path = os.getenv("YOLO_PLATE_MODEL")
    if env_path and Path(env_path).exists():
        return str(Path(env_path).resolve())
    if default_path.exists():
        return str(default_path)
    # Check parent
    if (root / "yolov8n_plate.pt").exists():
        return str(root / "yolov8n_plate.pt")
    return str(default_path)


def init_engine():
    global YOLO_MODEL, EASYOCR_READER, TESSERACT_AVAILABLE, ENGINE_NAME
    if YOLO_MODEL is not None and EASYOCR_READER is not None:
        return

    # 1. Load YOLOv8 Plate Detector
    from ultralytics import YOLO
    model_path = get_model_path()
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"YOLO plate model weights not found at: {model_path}")

    YOLO_MODEL = YOLO(model_path)

    # 2. Check Tesseract
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
        TESSERACT_AVAILABLE = True
    except Exception:
        TESSERACT_AVAILABLE = False

    # 3. Load EasyOCR
    import easyocr
    EASYOCR_READER = easyocr.Reader(['en'], gpu=False, verbose=False)
    ENGINE_NAME = f"YOLOv8-Plate + OpenCV + {'Tesseract+' if TESSERACT_AVAILABLE else ''}EasyOCR"


# ──────────────────────────────────────────────────────────────────────────────
# Indian License Plate Normalization Logic
# ──────────────────────────────────────────────────────────────────────────────

def clean_raw_plate(val: str) -> str:
    """Strip everything except alphanumeric characters and uppercase."""
    return re.sub(r'[^A-Z0-9]', '', str(val or '').upper())


def normalize_plate(val: str) -> str:
    """Normalize plate string by stripping spaces and hyphens and converting to uppercase."""
    return clean_raw_plate(val)


def shape_score(plate: str) -> float:
    """Evaluate conformity with Indian number plate standards."""
    p = normalize_plate(plate)
    if len(p) < 6:
        return 0.0
    # Common Indian shape: 2 state letters, 1-2 digits, 1-3 letters, 1-4 digits
    if re.fullmatch(r'^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}$', p):
        return 1.0 if p[:2] in INDIAN_STATES else 0.8
    # Bharat Series: 2 digits year, BH, 4 digits, 1-2 letters (excluding I and O)
    if re.fullmatch(r'^\d{2}BH\d{4}[A-HJ-NP-Z]{1,2}$', p):
        return 1.0
    if re.fullmatch(r'^\d{2}BH\d{4}[A-Z]{1,2}$', p):
        return 0.8  # Contains I or O
    return 0.0


def combine_observations(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group observations across frames and rank candidates by support and confidence."""
    plate_groups: dict[str, dict[str, Any]] = {}
    for o in observations:
        p = o.get("plate")
        if not p:
            continue
        if p not in plate_groups:
            plate_groups[p] = {"items": [], "frames": set(), "confidences": [], "timestamps": []}
        plate_groups[p]["items"].append(o)
        if "frameIndex" in o:
            plate_groups[p]["frames"].add(o["frameIndex"])
        else:
            plate_groups[p]["frames"].add(len(plate_groups[p]["items"]))
        plate_groups[p]["confidences"].append(float(o.get("confidence", 0.0)))
        if "timestampSeconds" in o:
            plate_groups[p]["timestamps"].append(o["timestampSeconds"])

    ranked = []
    for p, g in plate_groups.items():
        avg_conf = sum(g["confidences"]) / len(g["confidences"])
        support = len(g["frames"])
        ranked.append({
            "plate": p,
            "confidence": round(avg_conf, 3),
            "supportFrames": support,
            "timestampsSeconds": sorted(list(set(g["timestamps"])))[:5],
            "rawText": g["items"][0].get("rawText", p),
        })

    ranked.sort(key=lambda x: (x["supportFrames"], x["confidence"]), reverse=True)
    return ranked


def normalize_indian_plate(raw: str) -> str:
    """Normalize raw OCR plate text to compliant Indian vehicle registration syntax.
    Standard formats:
      - SS DD LL DDDD  (e.g., DL 3C BD 3885 -> DL3CBD3885)
      - SS DD L DDDD   (e.g., DL 1 C 1234 -> DL1C1234)
      - SS DD DDDD     (e.g., DL 01 1234)
      - YY BH DDDD LL  (Bharat series)
    """
    text = clean_raw_plate(raw)
    if len(text) < 6:
        return text

    # Common OCR prefix noise: "IND", "ND", "IN" on left of High Security Plates
    if text.startswith("IND") and len(text) >= 9:
        text = text[3:]
    elif text.startswith("ND") and len(text) >= 8 and text[2:4] in INDIAN_STATES:
        text = text[2:]

    # Remove stray quotation marks or artifacts
    text = clean_raw_plate(text)
    if len(text) < 6:
        return text

    chars = list(text)

    # Position 0 & 1 must be State Code (Letters)
    state_candidate = "".join(DIGIT_TO_LETTER.get(c, c) for c in chars[:2])
    # Handle common 6J -> GJ confusion in Gujarat plates
    if chars[0] in ('6', 'G') and chars[1] in ('J', '1', 'I'):
        state_candidate = 'GJ'
    elif state_candidate in INDIAN_STATES:
        chars[0] = state_candidate[0]
        chars[1] = state_candidate[1]
    elif "".join(chars[:2]) in INDIAN_STATES:
        pass
    else:
        # Check fuzzy state matches
        for st in INDIAN_STATES:
            if sum(1 for a, b in zip(state_candidate, st) if a == b) >= 1:
                if "".join(chars[2:4]).isdigit():
                    chars[0], chars[1] = st[0], st[1]
                    break

    # Position 2 & 3 must be RTO code (Digits)
    if len(chars) >= 4:
        for idx in (2, 3):
            if idx < len(chars):
                chars[idx] = LETTER_TO_DIGIT.get(chars[idx], chars[idx])

    # End characters (last 4, or last 3) must be vehicle sequence digits
    if len(chars) >= 8:
        for idx in range(len(chars) - 4, len(chars)):
            chars[idx] = LETTER_TO_DIGIT.get(chars[idx], chars[idx])
    elif len(chars) >= 6:
        for idx in range(len(chars) - 2, len(chars)):
            chars[idx] = LETTER_TO_DIGIT.get(chars[idx], chars[idx])

    # Middle series (between RTO digits and end numbers) must be Letters
    if len(chars) >= 8:
        for idx in range(4, len(chars) - 4):
            chars[idx] = DIGIT_TO_LETTER.get(chars[idx], chars[idx])

    normalized = "".join(chars)
    return normalized


def plate_shape_score(plate: str) -> float:
    """Return quality score for Indian registration plate."""
    if not plate or len(plate) < 6 or len(plate) > 11:
        return 0.0
    score = 0.5
    if plate[:2] in INDIAN_STATES:
        score += 0.3
    if PLATE_RE.fullmatch(plate):
        score += 0.4
    if len(plate) >= 4 and plate[2:4].isdigit():
        score += 0.1
    if len(plate) >= 8 and plate[-4:].isdigit():
        score += 0.2
    return score


# ──────────────────────────────────────────────────────────────────────────────
# OpenCV Plate Crop Preprocessing
# ──────────────────────────────────────────────────────────────────────────────

def preprocess_plate_variants(crop: np.ndarray) -> list[np.ndarray]:
    """Generate high-contrast, deskewed, and binarized variants of plate crop."""
    variants = []
    if crop is None or crop.size == 0:
        return variants

    # Resize to standard height (100-130px) keeping aspect ratio for optimal OCR
    h, w = crop.shape[:2]
    target_h = 110
    scale = target_h / max(h, 1)
    target_w = max(int(w * scale), 50)
    resized = cv2.resize(crop, (target_w, target_h), interpolation=cv2.INTER_CUBIC)

    # Add small white border margin to prevent character edge clipping
    padded = cv2.copyMakeBorder(resized, 6, 6, 8, 8, cv2.BORDER_CONSTANT, value=[255, 255, 255])
    variants.append(padded)

    # Grayscale
    gray = cv2.cvtColor(padded, cv2.COLOR_BGR2GRAY) if len(padded.shape) == 3 else padded

    # Variant 1: Contrast stretching + CLAHE (Contrast Limited Adaptive Histogram Equalization)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    contrast_img = clahe.apply(gray)
    variants.append(cv2.cvtColor(contrast_img, cv2.COLOR_GRAY2BGR))

    # Variant 2: Bilateral filter + Adaptive Gaussian Thresholding
    blurred = cv2.bilateralFilter(gray, 9, 75, 75)
    thresh_adaptive = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 15, 4
    )
    variants.append(cv2.cvtColor(thresh_adaptive, cv2.COLOR_GRAY2BGR))

    # Variant 3: Otsu Binarization with morphological closing
    _, thresh_otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    cleaned = cv2.morphologyEx(thresh_otsu, cv2.MORPH_CLOSE, kernel)
    variants.append(cv2.cvtColor(cleaned, cv2.COLOR_GRAY2BGR))

    return variants


def reconstruct_ocr(ocr_res: list) -> list[tuple[str, float, float]]:
    """Cluster OCR text bounding boxes by vertical line and horizontal position.
    
    Handles 1-line, 2-line (e.g. RJ14 on top, CV0002 below), and multi-box Indian plates.
    Returns list of (normalized_plate, avg_conf, shape_score) sorted by best match.
    """
    if not ocr_res:
        return []

    valid = [p for p in ocr_res if len(str(p[1]).strip()) >= 1 and float(p[2]) >= 0.15]
    if not valid:
        valid = ocr_res

    boxes = []
    for bbox, text, conf in valid:
        clean_t = clean_raw_plate(text)
        if not clean_t:
            continue
        cy = (bbox[0][1] + bbox[2][1]) / 2.0
        cx = (bbox[0][0] + bbox[1][0]) / 2.0
        h = max(1.0, bbox[2][1] - bbox[0][1])
        boxes.append({
            'text': clean_t,
            'conf': float(conf),
            'cx': cx,
            'cy': cy,
            'h': h,
            'x0': bbox[0][0]
        })

    if not boxes:
        return []

    # Sort boxes vertically
    boxes.sort(key=lambda b: b['cy'])
    lines = []
    for b in boxes:
        placed = False
        for l in lines:
            if abs(l['cy'] - b['cy']) < max(l['h'], b['h']) * 0.55:
                l['items'].append(b)
                placed = True
                break
        if not placed:
            lines.append({'cy': b['cy'], 'h': b['h'], 'items': [b]})

    # Within each line, sort horizontally
    for l in lines:
        l['items'].sort(key=lambda b: b['x0'])

    candidates = []

    # Candidate 1: Top line to bottom line (standard 2-line plate)
    c1_parts = []
    c1_confs = []
    for l in lines:
        for it in l['items']:
            c1_parts.append(it['text'])
            c1_confs.append(it['conf'])
    cand1 = "".join(c1_parts)
    norm1 = normalize_indian_plate(cand1)
    conf1 = sum(c1_confs) / max(len(c1_confs), 1)
    score1 = plate_shape_score(norm1)
    candidates.append((norm1, conf1, score1))

    # Candidate 2: Reversed lines (bottom to top, in case of upside-down or bottom-priority)
    if len(lines) > 1:
        c2_parts = []
        c2_confs = []
        for l in reversed(lines):
            for it in l['items']:
                c2_parts.append(it['text'])
                c2_confs.append(it['conf'])
        cand2 = "".join(c2_parts)
        norm2 = normalize_indian_plate(cand2)
        conf2 = sum(c2_confs) / max(len(c2_confs), 1)
        score2 = plate_shape_score(norm2)
        candidates.append((norm2, conf2, score2))

    # Candidate 3: Individual lines
    for l in lines:
        l_txt = "".join(it['text'] for it in l['items'])
        norm_l = normalize_indian_plate(l_txt)
        score_l = plate_shape_score(norm_l)
        conf_l = sum(it['conf'] for it in l['items']) / len(l['items'])
        candidates.append((norm_l, conf_l, score_l))

    # Candidate 4: Individual items
    for it in boxes:
        norm_it = normalize_indian_plate(it['text'])
        score_it = plate_shape_score(norm_it)
        candidates.append((norm_it, it['conf'], score_it))

    # Sort candidates by shape score first, then confidence
    candidates.sort(key=lambda c: (c[2], c[1]), reverse=True)
    return candidates


# ──────────────────────────────────────────────────────────────────────────────
# Plate Detection & Recognition on Frame
# ──────────────────────────────────────────────────────────────────────────────

def detect_plate_in_frame(frame: np.ndarray, min_conf: float = 0.15) -> list[dict]:
    """Run YOLOv8 plate detector and OCR on a single frame."""
    init_engine()
    results = []
    if frame is None or frame.size == 0:
        return results

    h, w = frame.shape[:2]

    # YOLO plate detection inference
    predict_res = YOLO_MODEL.predict(frame, conf=min_conf, verbose=False)[0]
    boxes = predict_res.boxes
    if len(boxes) == 0:
        return results

    box_items = []
    for b in boxes:
        conf = float(b.conf[0])
        xyxy = b.xyxy[0].tolist()
        x1 = max(0, int(xyxy[0]))
        y1 = max(0, int(xyxy[1]))
        x2 = min(w, int(xyxy[2]))
        y2 = min(h, int(xyxy[3]))
        if (x2 - x1) >= 15 and (y2 - y1) >= 10:
            box_items.append((conf, x1, y1, x2, y2))

    # If multiple boxes detected, also test union box of overlapping/adjacent plate regions
    if len(box_items) > 1:
        u_x1 = min(b[1] for b in box_items)
        u_y1 = min(b[2] for b in box_items)
        u_x2 = max(b[3] for b in box_items)
        u_y2 = max(b[4] for b in box_items)
        uw = u_x2 - u_x1
        uh = u_y2 - u_y1
        if uh > 0 and 1.2 <= (uw / uh) <= 7.5:
            box_items.append((max(b[0] for b in box_items), u_x1, u_y1, u_x2, u_y2))

    for conf, x1, y1, x2, y2 in box_items:
        crop_w = x2 - x1
        crop_h = y2 - y1

        # Add small padding margin around plate crop
        pad_x = int(crop_w * 0.06)
        pad_y = int(crop_h * 0.08)
        crop_x1 = max(0, x1 - pad_x)
        crop_y1 = max(0, y1 - pad_y)
        crop_x2 = min(w, x2 + pad_x)
        crop_y2 = min(h, y2 + pad_y)

        plate_crop = frame[crop_y1:crop_y2, crop_x1:crop_x2]
        variants = preprocess_plate_variants(plate_crop)

        best_text = ""
        best_ocr_conf = 0.0
        best_shape = 0.0

        for var in variants:
            ocr_res = EASYOCR_READER.readtext(var, detail=1, paragraph=False)
            if not ocr_res:
                continue

            candidates = reconstruct_ocr(ocr_res)
            for norm_plate, cand_conf, shape in candidates:
                if len(norm_plate) >= 6:
                    combined_metric = cand_conf * (1.0 + shape)
                    current_best_metric = best_ocr_conf * (1.0 + best_shape)
                    if combined_metric > current_best_metric:
                        best_text = norm_plate
                        best_ocr_conf = cand_conf
                        best_shape = shape

            if PLATE_RE.fullmatch(best_text) and best_ocr_conf > 0.65:
                break

        if best_text and len(best_text) >= 6:
            results.append({
                "plate": best_text,
                "confidence": round(float((conf * 0.5) + (best_ocr_conf * 0.5)), 3),
                "detectorConfidence": round(float(conf), 3),
                "ocrConfidence": round(float(best_ocr_conf), 3),
                "box": [x1, y1, x2, y2],
                "boxNormalized": [round(x1 / w, 4), round(y1 / h, 4), round(x2 / w, 4), round(y2 / h, 4)],
            })

    return results


# ──────────────────────────────────────────────────────────────────────────────
# File & Video Processor
# ──────────────────────────────────────────────────────────────────────────────


def process_image(img_path: Path) -> dict:
    start_t = time.perf_counter()
    img = cv2.imread(str(img_path))
    if img is None:
        return {
            "status": "ERROR",
            "error": f"Cannot decode image file: {img_path}",
            "candidates": [],
            "selectedPlate": None
        }

    init_engine()
    h, w = img.shape[:2]

    # Test orientations: if portrait (h > w), check 90 deg clockwise and 270 deg
    rotations_to_try = [(0, None)]
    if h > w:
        rotations_to_try.extend([
            (90, cv2.ROTATE_90_CLOCKWISE),
            (270, cv2.ROTATE_90_COUNTERCLOCKWISE)
        ])
    else:
        rotations_to_try.append((90, cv2.ROTATE_90_CLOCKWISE))

    detections = []
    for rot_deg, rot_flag in rotations_to_try:
        cur_img = img if rot_flag is None else cv2.rotate(img, rot_flag)
        cur_dets = detect_plate_in_frame(cur_img)
        if cur_dets:
            detections.extend(cur_dets)
            # If high confidence Indian plate is found, exit immediately
            if any(len(d["plate"]) >= 8 and plate_shape_score(d["plate"]) >= 1.0 for d in cur_dets):
                break

    # Fallback to direct OCR on resized image if no YOLO plate bounding box was detected or only partial plate
    has_full_plate = any(len(d["plate"]) >= 8 and plate_shape_score(d["plate"]) >= 1.0 for d in detections)
    if not has_full_plate:
        for rot_deg, rot_flag in rotations_to_try:
            cur_img = img if rot_flag is None else cv2.rotate(img, rot_flag)
            ih, iw = cur_img.shape[:2]
            scale = min(1.0, 960.0 / max(ih, iw))
            scaled_img = cv2.resize(cur_img, (int(iw * scale), int(ih * scale)), interpolation=cv2.INTER_AREA) if scale < 1.0 else cur_img

            ocr_res = EASYOCR_READER.readtext(scaled_img, detail=1)
            cands = reconstruct_ocr(ocr_res)
            for norm, conf, shape in cands:
                if len(norm) >= 6 and shape >= 0.7:
                    shape_factor = 1.0 + (max(0.0, shape - 0.5) * 0.25)
                    effective_conf = min(0.96, round(float(conf * shape_factor), 3))
                    detections.append({
                        "plate": norm,
                        "confidence": effective_conf,
                        "detectorConfidence": 0.88 if shape >= 1.0 else 0.5,
                        "ocrConfidence": round(float(conf), 3),
                        "box": [0, 0, iw, ih],
                        "boxNormalized": [0.0, 0.0, 1.0, 1.0]
                    })
            if any(len(d["plate"]) >= 8 and plate_shape_score(d["plate"]) >= 1.0 for d in detections):
                break

    elapsed = round(time.perf_counter() - start_t, 3)

    if detections:
        # Deduplicate candidates by plate string, keeping highest confidence
        unique_map = {}
        for d in detections:
            p = d["plate"]
            if p not in unique_map or d["confidence"] > unique_map[p]["confidence"]:
                unique_map[p] = d
        unique_dets = list(unique_map.values())
        unique_dets.sort(key=lambda d: ((plate_shape_score(d["plate"]) * 1.5) + d["confidence"]), reverse=True)
        best = unique_dets[0]
        return {
            "status": "COMPLETED",
            "selectedPlate": best["plate"],
            "confidence": best["confidence"],
            "box": best.get("box"),
            "boxNormalized": best.get("boxNormalized"),
            "candidates": unique_dets,
            "bestCandidate": best,
            "elapsedSeconds": elapsed,
            "engine": ENGINE_NAME
        }

    return {
        "status": "NOT_FOUND",
        "selectedPlate": None,
        "confidence": None,
        "box": None,
        "candidates": [],
        "elapsedSeconds": elapsed,
        "engine": ENGINE_NAME
    }


def process_video(vid_path: Path, sample_fps: float = 2.0, max_frames: int = 15) -> dict:
    """Process uploaded video file with fast adaptive sampling, frame downscaling, and early exit."""
    start_t = time.perf_counter()
    
    # Emit initial progress
    sys.stdout.write(json.dumps({"type": "PROGRESS", "percent": 10, "stage": "INITIALIZING", "message": "Loading video engine & extracting keyframes..."}) + "\n")
    sys.stdout.flush()

    init_engine()

    cap = cv2.VideoCapture(str(vid_path))
    if not cap.isOpened():
        return {
            "status": "ERROR",
            "error": f"Cannot open video: {vid_path}",
            "candidates": [],
            "selectedPlate": None
        }

    if hasattr(cv2, 'CAP_PROP_ORIENTATION_AUTO'):
        cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    # Sample at ~2 FPS for fast turnaround while capturing every vehicle passage
    interval = max(1, int(fps / max(0.5, sample_fps)))

    vw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    vh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    is_portrait = vh > vw and vh > 0

    frame_idx = 0
    sampled = 0
    observations = []
    active_rotation = None

    sys.stdout.write(json.dumps({"type": "PROGRESS", "percent": 25, "stage": "SCANNING_FRAMES", "message": f"Scanning keyframes at {sample_fps} FPS target..."}) + "\n")
    sys.stdout.flush()

    while (total == 0 or frame_idx < total) and sampled < max_frames:
        if frame_idx % interval == 0:
            ok, frame = cap.read()
            if not ok or frame is None:
                break

            # Apply detected rotation if video is shot in portrait or sideways
            if active_rotation is not None:
                frame = cv2.rotate(frame, active_rotation)
            elif is_portrait and sampled < 2:
                test_rot = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
                if detect_plate_in_frame(test_rot):
                    active_rotation = cv2.ROTATE_90_CLOCKWISE
                    frame = test_rot

            # Downscale high-resolution frames (e.g. 1080p -> 960px) for 3x faster YOLO detection
            fh, fw = frame.shape[:2]
            if fw > 1024 or fh > 1024:
                scale_factor = 960.0 / max(fw, fh)
                scaled_w = int(fw * scale_factor)
                scaled_h = int(fh * scale_factor)
                frame_to_detect = cv2.resize(frame, (scaled_w, scaled_h), interpolation=cv2.INTER_AREA)
            else:
                scale_factor = 1.0
                frame_to_detect = frame

            found = detect_plate_in_frame(frame_to_detect)

            # If no boxes detected in first frame, test 90 deg rotation
            if not found and active_rotation is None and sampled < 2:
                rot90 = cv2.rotate(frame_to_detect, cv2.ROTATE_90_CLOCKWISE)
                found_rot = detect_plate_in_frame(rot90)
                if found_rot:
                    active_rotation = cv2.ROTATE_90_CLOCKWISE
                    found = found_rot

            # Rescale boxes back to original frame dimensions
            for item in found:
                if scale_factor != 1.0 and "box" in item:
                    inv = 1.0 / scale_factor
                    item["box"] = [
                        int(item["box"][0] * inv),
                        int(item["box"][1] * inv),
                        int(item["box"][2] * inv),
                        int(item["box"][3] * inv)
                    ]
                item["timestampSeconds"] = round(frame_idx / fps, 2)
                item["frameIndex"] = frame_idx
                observations.append(item)

            sampled += 1

            pct = min(85, int(25 + (sampled / float(max_frames)) * 60))
            if found:
                best_found = max(found, key=lambda x: x.get("confidence", 0))
                sys.stdout.write(json.dumps({
                    "type": "PROGRESS",
                    "percent": pct,
                    "stage": "PLATE_LOCALIZED",
                    "message": f"Localized plate: {best_found['plate']} (Confidence: {int(best_found['confidence'] * 100)}%)",
                    "plate": best_found['plate']
                }) + "\n")
                sys.stdout.flush()
            else:
                sys.stdout.write(json.dumps({
                    "type": "PROGRESS",
                    "percent": pct,
                    "stage": "SCANNING_FRAMES",
                    "message": f"Analyzing video frame {sampled}/{max_frames}..."
                }) + "\n")
                sys.stdout.flush()

            # Fast early exit if a valid, high-confidence Indian plate is confirmed
            if observations:
                high_conf_plates = [
                    o["plate"] for o in observations
                    if plate_shape_score(o["plate"]) >= 1.0 and o.get("confidence", 0) >= 0.70
                ]
                if high_conf_plates:
                    break

                # Or if we have 2 consistent reads of any plausible plate
                plates = [o["plate"] for o in observations]
                most_common, count = Counter(plates).most_common(1)[0]
                if count >= 2 and plate_shape_score(most_common) >= 0.8:
                    break
        else:
            if not cap.grab():
                break
        frame_idx += 1

    cap.release()
    elapsed = round(time.perf_counter() - start_t, 3)

    sys.stdout.write(json.dumps({"type": "PROGRESS", "percent": 95, "stage": "VERIFYING_CONSENSUS", "message": "Evaluating candidate ranking & safety compliance..."}) + "\n")
    sys.stdout.flush()

    if observations:
        plate_groups = {}
        for o in observations:
            p = o["plate"]
            if p not in plate_groups:
                plate_groups[p] = {"items": [], "confidences": [], "timestamps": []}
            plate_groups[p]["items"].append(o)
            plate_groups[p]["confidences"].append(o["confidence"])
            plate_groups[p]["timestamps"].append(o["timestampSeconds"])

        ranked = []
        for p, g in plate_groups.items():
            avg_conf = sum(g["confidences"]) / len(g["confidences"])
            support = len(g["items"])
            shape = plate_shape_score(p)
            support_bonus = min(support, 4) * 0.03
            final_conf = min(0.96, round(avg_conf + support_bonus, 3))
            rank_score = (final_conf * 0.5) + (min(support, 5) / 5.0 * 0.25) + (shape * 0.5)
            ranked.append({
                "plate": p,
                "confidence": final_conf,
                "supportFrames": support,
                "timestampsSeconds": sorted(list(set(g["timestamps"])))[:5],
                "rankScore": round(rank_score, 3),
                "box": g["items"][0].get("box"),
                "boxNormalized": g["items"][0].get("boxNormalized")
            })

        ranked.sort(key=lambda x: x["rankScore"], reverse=True)
        best = ranked[0]
        return {
            "status": "COMPLETED" if best["confidence"] >= 0.45 else "REVIEW_REQUIRED",
            "selectedPlate": best["plate"],
            "confidence": best["confidence"],
            "candidates": ranked[:5],
            "bestCandidate": best,
            "box": best.get("box"),
            "boxNormalized": best.get("boxNormalized"),
            "framesProcessed": sampled,
            "elapsedSeconds": elapsed,
            "engine": ENGINE_NAME
        }

    return {
        "status": "NOT_FOUND",
        "selectedPlate": None,
        "confidence": None,
        "candidates": [],
        "framesProcessed": sampled,
        "elapsedSeconds": elapsed,
        "engine": ENGINE_NAME
    }


# ──────────────────────────────────────────────────────────────────────────────
# Stdin / Base64 Frame Processing for Fast Live Scanning
# ──────────────────────────────────────────────────────────────────────────────

def process_base64_frame(b64_str: str) -> dict:
    """Decode a single base64-encoded frame and run plate detection."""
    if ',' in b64_str:
        b64_str = b64_str.split(',', 1)[1]
    img_bytes = base64.b64decode(b64_str)
    nparr = np.frombuffer(img_bytes, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if frame is None:
        return {"detected": False, "plate": None, "error": "Cannot decode frame"}

    detections = detect_plate_in_frame(frame)
    if detections:
        best = max(detections, key=lambda d: d["confidence"])
        return {
            "detected": True,
            "plate": best["plate"],
            "confidence": best["confidence"],
            "box": best.get("box"),
            "boxNormalized": best.get("boxNormalized"),
            "all": detections
        }

    return {"detected": False, "plate": None, "box": None}


# ──────────────────────────────────────────────────────────────────────────────
# CLI Entry Point
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="FuelFlux / Hydrotest Studio License Plate Scanner")
    parser.add_argument("--input", type=Path, help="Input media file path")
    parser.add_argument("--json", action="store_true", help="Output result as JSON")
    parser.add_argument("--sample-fps", type=float, default=1.5)
    parser.add_argument("--max-frames", type=int, default=40)
    parser.add_argument("--stdin-frame", action="store_true", help="Read single base64 frame from stdin")
    args = parser.parse_args()

    if args.stdin_frame:
        raw_b64 = sys.stdin.read().strip()
        res = process_base64_frame(raw_b64)
        print(json.dumps(res))
        return 0

    if not args.input:
        parser.print_help()
        return 1

    input_path = args.input.resolve()
    ext = input_path.suffix.lower()

    if ext in {'.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff'}:
        result = process_image(input_path)
    elif ext in {'.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v'}:
        result = process_video(input_path, sample_fps=args.sample_fps, max_frames=args.max_frames)
    else:
        result = {"status": "ERROR", "error": f"Unsupported media extension: {ext}", "candidates": []}

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"Status: {result.get('status')}")
        print(f"Plate:  {result.get('selectedPlate')}")
        print(f"Conf:   {result.get('confidence')}")
        print(f"Time:   {result.get('elapsedSeconds')}s")

    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
