#!/usr/bin/env python3
"""Download Awiros Indian-plate OCR weights and PaddleOCR source for local use.

The 149 MB model weights and PaddleOCR source are intentionally kept out of Git.
Run from the repository root: python scripts/setup-indian-ocr.py
"""
from __future__ import annotations
import argparse
import hashlib
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "cv_worker" / "models" / "awiros_anpr"
PADDLE_DIR = ROOT / "cv_worker" / "vendor" / "PaddleOCR"
MODEL_REVISION = "844ce1f10cdf84db0f974fd4c048c7b99ffb92d1"
BASE = f"https://huggingface.co/Awiros/anpr-ocr/resolve/{MODEL_REVISION}/"
MODEL_SHA256 = "f9f1264e0c115a239ca6d6700a74ceffab17168b75dafc6c169c232012c68e47"
FILES = {
    "model.safetensors": BASE + "model.safetensors?download=true",
    "en_dict.txt": BASE + "en_dict.txt?download=true",
}


def download(url: str, destination: Path) -> None:
    minimum_size = 100_000_000 if destination.name == "model.safetensors" else 100
    if destination.exists() and destination.stat().st_size > minimum_size:
        print(f"Already present: {destination}")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "FuelFlux-ANPR-setup/1.0"})
    print(f"Downloading {destination.name} (the model weights are approximately 150 MB)...")
    try:
        with urllib.request.urlopen(request, timeout=90) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        if temporary.stat().st_size < minimum_size:
            raise RuntimeError(f"Downloaded file looks too small: {destination.name} ({temporary.stat().st_size} bytes)")
        temporary.replace(destination)
    finally:
        if temporary.exists():
            temporary.unlink()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-paddleocr-clone", action="store_true", help="Do not clone PaddleOCR source")
    parser.add_argument("--paddleocr-dir", type=Path, default=PADDLE_DIR, help="Where to clone/find PaddleOCR")
    parser.add_argument("--model-dir", type=Path, default=MODEL_DIR, help="Where to save the model weights and dictionary")
    args = parser.parse_args()

    try:
        for filename, url in FILES.items():
            destination = args.model_dir / filename
            download(url, destination)
            if filename == "model.safetensors":
                digest = hashlib.sha256(destination.read_bytes()).hexdigest()
                if digest != MODEL_SHA256:
                    destination.unlink(missing_ok=True)
                    raise RuntimeError("Awiros model weight checksum did not match the published artifact. Delete partial downloads and retry.")
        if not args.skip_paddleocr_clone:
            paddle_dir = args.paddleocr_dir.resolve()
            if (paddle_dir / "ppocr" / "__init__.py").is_file():
                print(f"PaddleOCR source already present: {paddle_dir}")
            else:
                if paddle_dir.exists() and any(paddle_dir.iterdir()):
                    raise RuntimeError(f"Directory exists but is not a PaddleOCR checkout: {paddle_dir}")
                paddle_dir.parent.mkdir(parents=True, exist_ok=True)
                subprocess.run(
                    ["git", "clone", "--depth", "1", "https://github.com/PaddlePaddle/PaddleOCR.git", str(paddle_dir)],
                    check=True,
                )
        print("\nModel files are ready.")
        print("Use Python 3.10/3.11 in the same environment as Node's PYTHON_EXECUTABLE.")
        print("ALPR_ENGINE=fast_alpr_india is the default in .env.example; restart Express after setup.")
        print("The first inference may take longer while ONNX detector assets are cached.")
        return 0
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
