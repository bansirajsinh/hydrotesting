#!/usr/bin/env python3
"""Persistent Live Camera & File Scanning Server for FuelFlux & Hydrotest Studio.

Keeps YOLOv8 plate detector and EasyOCR in memory for lightning-fast scanning:
  - /scan-frame  : Live camera base64 frame (100-200ms)
  - /scan-file   : Manual upload file path  (1-5s with warm models vs 15-25s cold)
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import cv2
import numpy as np

# Import detection functions from scan_media
sys.path.insert(0, str(Path(__file__).resolve().parent))
from scan_media import (
    detect_plate_in_frame, init_engine, normalize_indian_plate,
    process_image, process_video, plate_shape_score, ENGINE_NAME
)

HOST = "127.0.0.1"
PORT = int(os.getenv("LIVE_SCAN_PORT", "5050"))


def _send_json(handler, code: int, data: dict):
    """Helper to send a JSON response."""
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


class LiveScanHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress noisy HTTP request logging
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            _send_json(self, 200, {
                "status": "ok",
                "service": "live_camera_scanner",
                "capabilities": ["scan-frame", "scan-file"],
            })
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/scan-frame":
            self._handle_scan_frame()
        elif self.path == "/scan-file":
            self._handle_scan_file()
        else:
            self.send_response(404)
            self.end_headers()

    # ── Live camera frame scan (unchanged logic) ──────────────────────────

    def _handle_scan_frame(self):
        t0 = time.perf_counter()
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len)

        try:
            data = json.loads(body.decode("utf-8"))
            b64_str = data.get("image", "")
            if "," in b64_str:
                b64_str = b64_str.split(",", 1)[1]

            img_bytes = base64.b64decode(b64_str)
            nparr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if frame is None:
                resp = {"detected": False, "plate": None, "error": "Invalid image payload"}
            else:
                detections = detect_plate_in_frame(frame)
                elapsed_ms = int((time.perf_counter() - t0) * 1000)

                if detections:
                    best = max(detections, key=lambda d: d["confidence"])
                    resp = {
                        "detected": True,
                        "plate": best["plate"],
                        "confidence": best["confidence"],
                        "box": best.get("box"),
                        "boxNormalized": best.get("boxNormalized"),
                        "elapsedMs": elapsed_ms,
                        "candidates": detections
                    }
                else:
                    resp = {
                        "detected": False,
                        "plate": None,
                        "box": None,
                        "elapsedMs": elapsed_ms
                    }

            _send_json(self, 200, resp)

        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        except Exception as exc:
            try:
                _send_json(self, 500, {"detected": False, "error": str(exc)})
            except Exception:
                pass

    # ── Manual upload file scan (new: uses warm models in memory) ─────────

    def _handle_scan_file(self):
        content_len = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_len)

        try:
            data = json.loads(raw_body.decode("utf-8"))
            file_path = data.get("filePath", "")
            sample_fps = float(data.get("sampleFps", 2.0))
            max_frames = int(data.get("maxFrames", 20))

            if not file_path or not Path(file_path).exists():
                _send_json(self, 400, {
                    "status": "ERROR",
                    "error": f"File not found: {file_path}",
                    "candidates": [],
                    "selectedPlate": None,
                })
                return

            p = Path(file_path)
            ext = p.suffix.lower()

            if ext in {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}:
                result = process_image(p)
            elif ext in {".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v"}:
                result = process_video(p, sample_fps=sample_fps, max_frames=max_frames)
            else:
                result = {
                    "status": "ERROR",
                    "error": f"Unsupported media extension: {ext}",
                    "candidates": [],
                    "selectedPlate": None,
                }

            _send_json(self, 200, result)

        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        except Exception as exc:
            try:
                _send_json(self, 500, {
                    "status": "ERROR",
                    "error": str(exc),
                    "candidates": [],
                    "selectedPlate": None,
                })
            except Exception:
                pass


def run():
    print("Pre-warming YOLOv8 plate detector and EasyOCR in memory...")
    init_engine()
    print(f"Live & Upload Scanner ready on http://{HOST}:{PORT}  [/scan-frame, /scan-file]")
    server = HTTPServer((HOST, PORT), LiveScanHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
