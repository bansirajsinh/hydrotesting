#!/usr/bin/env python3
"""Persistent Live Camera Scanning Server for FuelFlux & Hydrotest Studio.

Keeps YOLOv8 plate detector and EasyOCR in memory for lightning-fast (100-200ms)
live camera frame scanning via HTTP.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import cv2
import numpy as np

# Import detection functions from scan_media
sys.path.insert(0, str(Path(__file__).resolve().parent))
from scan_media import detect_plate_in_frame, init_engine, normalize_indian_plate

HOST = "127.0.0.1"
PORT = int(os.getenv("LIVE_SCAN_PORT", "5050"))


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
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "service": "live_camera_scanner"}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/scan-frame":
            self.send_response(404)
            self.end_headers()
            return

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

            body = json.dumps(resp).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            # Client closed connection prematurely
            pass
        except Exception as exc:
            try:
                err_body = json.dumps({"detected": False, "error": str(exc)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(err_body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(err_body)
            except Exception:
                pass


def run():
    print("Pre-warming YOLOv8 plate detector and EasyOCR in memory...")
    init_engine()
    print(f"Live Camera Scanner ready and listening on http://{HOST}:{PORT}")
    server = HTTPServer((HOST, PORT), LiveScanHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
