#!/usr/bin/env python3
"""FastALPR-first image/video/RTSP scanner used by the FuelFlux demo.

This module detects plate candidates. Hydrotest decisions are made by Express
from MongoDB records. OCR is uncertain evidence and must not be treated as
proof of registration or hydrotest compliance.
"""
from __future__ import annotations
import argparse
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict, deque
from pathlib import Path
from typing import Any

import cv2

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp'}
VIDEO_EXTS = {'.mp4', '.avi', '.mov', '.mkv', '.m4v', '.webm'}
PLATE_RE = re.compile(r'^(?:[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}|\d{2}BH\d{4}[A-HJ-NP-Z]{1,2})$')
ENGINE = None
ENGINE_NAME = 'unavailable'
ENGINE_WARNING = None
CASCADE = None
INFERENCE_FAILURES = 0
LAST_INFERENCE_FAILURE = None


def normalize_plate(value: str) -> str:
    return re.sub(r'[^A-Z0-9]', '', str(value or '').upper())


def shape_score(value: str) -> float:
    p = normalize_plate(value)
    if not 7 <= len(p) <= 11:
        return 0.0
    if PLATE_RE.fullmatch(p):
        return 1.0
    # OCR can return a plausible but unsupported legacy/special format. Keep it
    # as a review candidate rather than throwing away potentially useful evidence.
    if sum(ch.isalpha() for ch in p) >= 2 and sum(ch.isdigit() for ch in p) >= 2:
        return 0.45
    return 0.0


def _get(obj: Any, *names: str, default=None):
    for name in names:
        if isinstance(obj, dict) and name in obj:
            return obj[name]
        if hasattr(obj, name):
            return getattr(obj, name)
    return default


def _bbox(box: Any):
    if box is None:
        return None
    if isinstance(box, dict):
        x = box.get('x', box.get('left', 0)); y = box.get('y', box.get('top', 0))
        if 'width' in box and 'height' in box:
            return {'x': int(x), 'y': int(y), 'width': int(box['width']), 'height': int(box['height'])}
        x2 = box.get('x2', box.get('right', x)); y2 = box.get('y2', box.get('bottom', y))
        return {'x': int(x), 'y': int(y), 'width': max(0, int(x2-x)), 'height': max(0, int(y2-y))}
    if all(hasattr(box, key) for key in ('x1', 'y1', 'x2', 'y2')):
        x1, y1, x2, y2 = box.x1, box.y1, box.x2, box.y2
        return {'x': int(x1), 'y': int(y1), 'width': max(0, int(x2-x1)), 'height': max(0, int(y2-y1))}
    try:
        values = list(box)
        if len(values) == 4:
            # Detect corner pairs [[x1,y1],[x2,y2]] vs [x,y,w,h].
            if isinstance(values[0], (list, tuple)):
                x1, y1 = values[0][:2]; x2, y2 = values[1][:2]
                return {'x': int(x1), 'y': int(y1), 'width': max(0, int(x2-x1)), 'height': max(0, int(y2-y1))}
            x, y, w, h = values
            return {'x': int(x), 'y': int(y), 'width': int(w), 'height': int(h)}
    except Exception:
        pass
    return None


def init_engine():
    """Initialize the best available ALPR engine, with explicit, visible fallbacks.

    The India-specific OCR model is preferred. If its weights/dependencies are not
    installed, the scanner can still run using FastALPR's general OCR and then
    EasyOCR (if installed), unless ALPR_STRICT_ENGINE=true. Every fallback is
    surfaced in `warnings`; it is never presented as Indian-model accuracy.
    """
    global ENGINE, ENGINE_NAME, ENGINE_WARNING, CASCADE, INFERENCE_FAILURES, LAST_INFERENCE_FAILURE
    if ENGINE is not None:
        return

    INFERENCE_FAILURES = 0
    LAST_INFERENCE_FAILURE = None
    ENGINE_WARNING = None
    configured = os.getenv('ALPR_ENGINE', 'fast_alpr_india').strip().lower()
    detector = os.getenv('ALPR_DETECTOR_MODEL', 'yolo-v9-s-608-license-plate-end2end')
    try:
        detector_confidence = float(os.getenv('ALPR_DETECTOR_CONFIDENCE', '0.22'))
    except (TypeError, ValueError):
        detector_confidence = 0.22
        ENGINE_WARNING = 'Invalid ALPR_DETECTOR_CONFIDENCE; using 0.22.'
    detector_confidence = max(0.05, min(detector_confidence, 0.95))
    strict_engine = os.getenv('ALPR_STRICT_ENGINE', 'false').strip().lower() == 'true'
    init_errors = []

    # 1. Preferred pipeline: a license-plate detector plus the India-specific OCR.
    if configured in ('fast_alpr_india', 'india', 'auto'):
        try:
            from fast_alpr import ALPR
            from awiros_ocr import AwirosIndianOCR
            recognizer = AwirosIndianOCR(
                retry_below=float(os.getenv('AWIROS_RETRY_BELOW', '0.82')),
                device=os.getenv('AWIROS_DEVICE', 'cpu'),
            )
            ENGINE = ALPR(
                detector_model=detector,
                detector_conf_thresh=detector_confidence,
                ocr=recognizer,
            )
            ENGINE_NAME = f'FastALPR/{detector} + Awiros Indian OCR'
        except Exception as exc:
            message = f'{type(exc).__name__}: {exc}'
            init_errors.append(f'India-specific OCR unavailable ({message})')
            if strict_engine:
                raise RuntimeError(
                    'ALPR_STRICT_ENGINE=true and the India-specific pipeline failed: '
                    + message + '. Install cv_worker/requirements-india.txt and run '
                    'python scripts/setup-indian-ocr.py, or unset strict mode to allow fallback.'
                ) from exc
            ENGINE_WARNING = (
                'India-specific OCR could not initialize; trying a general OCR fallback. '
                'Do not treat fallback output as confirmed identity without review. '
                + message
            )
            configured = 'fast_alpr'

    # 2. First fallback: FastALPR detector + general-purpose bundled OCR.
    if ENGINE is None and configured == 'fast_alpr':
        try:
            from fast_alpr import ALPR
            ocr_model = os.getenv('ALPR_OCR_MODEL', 'cct-s-v2-global-model')
            ENGINE = ALPR(
                detector_model=detector,
                detector_conf_thresh=detector_confidence,
                ocr_model=ocr_model,
            )
            ENGINE_NAME = f'FastALPR/{detector} + generic OCR/{ocr_model}'
            warning = 'Using general-purpose OCR; accuracy on Indian plates is not calibrated. Low-confidence or inconsistent results require review.'
            ENGINE_WARNING = f'{ENGINE_WARNING}; {warning}' if ENGINE_WARNING else warning
        except Exception as exc:
            message = f'{type(exc).__name__}: {exc}'
            init_errors.append(f'FastALPR initialization failed ({message})')
            ENGINE_WARNING = f'{ENGINE_WARNING}; {init_errors[-1]}' if ENGINE_WARNING else init_errors[-1]
            if strict_engine:
                raise RuntimeError(ENGINE_WARNING) from exc

    # 3. Last-resort fallback, only when the package is installed. This is not
    # preferred for accuracy, but it avoids failing merely because model assets
    # have not been downloaded. The API/UI receive a warning with each result.
    should_try_easyocr = ENGINE is None and not strict_engine and configured in (
        'fast_alpr_india', 'india', 'auto', 'fast_alpr', 'easyocr'
    )
    if should_try_easyocr:
        try:
            import easyocr
            ENGINE = easyocr.Reader(
                ['en'], gpu=os.getenv('ALPR_GPU', 'false').lower() == 'true', verbose=False
            )
            ENGINE_NAME = 'EasyOCR fallback (general-purpose; use manual review for uncertain plates)'
            warning = 'Using EasyOCR fallback; Indian registration performance has not been calibrated.'
            ENGINE_WARNING = f'{ENGINE_WARNING}; {warning}' if ENGINE_WARNING else warning
        except Exception as exc:
            message = f'{type(exc).__name__}: {exc}'
            init_errors.append(f'EasyOCR initialization failed ({message})')
            ENGINE_WARNING = f'{ENGINE_WARNING}; {init_errors[-1]}' if ENGINE_WARNING else init_errors[-1]

    cascade_path = os.getenv('PLATE_HAAR_CASCADE') or str(Path(cv2.data.haarcascades) / 'haarcascade_russian_plate_number.xml')
    if os.path.exists(cascade_path):
        cascade = cv2.CascadeClassifier(cascade_path)
        if not cascade.empty():
            CASCADE = cascade

    if ENGINE is None:
        available_hint = (
            'Install backend dependencies with the same interpreter used by Node: '
            '`python -m pip install -r cv_worker/requirements.txt`. For India-specific OCR, '
            'also install `cv_worker/requirements-india.txt` and run '
            '`python scripts/setup-indian-ocr.py`. Set PYTHON_EXECUTABLE to that environment '
            'Python. To require only the selected model, set ALPR_STRICT_ENGINE=true.'
        )
        detail = ' | '.join(init_errors) or ENGINE_WARNING or f'Unsupported ALPR_ENGINE value: {configured}'
        raise RuntimeError(f'No plate-recognition engine could be initialized. {detail}. {available_hint}')


def parse_fast_results(frame) -> list[dict]:
    raw_results = ENGINE.predict(frame)
    output = []
    if raw_results is None:
        return output
    if not isinstance(raw_results, (list, tuple)):
        raw_results = [raw_results]
    for item in raw_results:
        ocr = _get(item, 'ocr', 'recognition', default=None)
        detection = _get(item, 'detection', 'detector', default=None)
        text = _get(ocr, 'text', 'plate_text', 'value', default=None) if ocr is not None else None
        if not text:
            text = _get(item, 'text', 'plate_text', 'license_plate', 'value', default=None)
        confidence = _get(ocr, 'confidence', 'score', default=None) if ocr is not None else None
        if confidence is None:
            confidence = _get(item, 'confidence', 'score', default=0.0)
        box = _get(detection, 'bounding_box', 'bbox', 'box', default=None) if detection is not None else None
        if box is None:
            box = _get(item, 'bounding_box', 'bbox', 'box', default=None)
        normalized = normalize_plate(text or '')
        score = shape_score(normalized)
        if score <= 0:
            continue
        try:
            if isinstance(confidence, (list, tuple)):
                values = [float(v) for v in confidence if v is not None]
                confidence = sum(values) / len(values) if values else 0.0
            else:
                confidence = float(confidence or 0)
            if confidence > 1 and confidence <= 100:
                confidence /= 100
        except (TypeError, ValueError):
            confidence = 0.0
        output.append({'plate': normalized, 'rawText': str(text), 'confidence': max(0, min(1, confidence)), 'shapeScore': score, 'bbox': _bbox(box), 'engine': ENGINE_NAME})
    return output


def preprocess(crop):
    if crop is None or crop.size == 0:
        return []
    h, w = crop.shape[:2]
    target_w = min(720, max(w, 280))
    scale = target_w / max(1, w)
    resized = cv2.resize(crop, (target_w, max(1, int(h*scale))), interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))
    enhanced = clahe.apply(resized)
    binary = cv2.adaptiveThreshold(enhanced, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 9)
    return [enhanced, binary]


def easyocr_fallback(frame) -> list[dict]:
    try:
        import numpy as np
        import easyocr
        # If FastALPR initialization failed, ENGINE may be an EasyOCR reader.
        reader = ENGINE if hasattr(ENGINE, 'readtext') else None
        if reader is None:
            return []
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape[:2]
        regions = []
        if CASCADE is not None:
            scale = min(1.0, 1500 / max(1, w))
            small = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else gray
            found = CASCADE.detectMultiScale(small, scaleFactor=1.1, minNeighbors=4, minSize=(50, 15))
            for x, y, bw, bh in found[:8]:
                x1 = max(0, int(x/scale)-6); y1 = max(0, int(y/scale)-5)
                x2 = min(w, int((x+bw)/scale)+6); y2 = min(h, int((y+bh)/scale)+5)
                regions.append((gray[y1:y2, x1:x2], {'x': x1, 'y': y1, 'width': x2-x1, 'height': y2-y1}))
        if not regions:
            regions.append((gray[int(h*0.3):h, int(w*0.03):int(w*0.97)], None))
        results = []
        for crop, bbox in regions[:6]:
            for variant in preprocess(crop)[:2]:
                try:
                    found = reader.readtext(variant, detail=1, paragraph=False, allowlist='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', decoder='greedy')
                except Exception:
                    continue
                for box, text, conf in found:
                    normalized = normalize_plate(text)
                    score = shape_score(normalized)
                    if score > 0:
                        results.append({'plate': normalized, 'rawText': str(text), 'confidence': max(0, min(1, float(conf))), 'shapeScore': score, 'bbox': bbox, 'engine': ENGINE_NAME})
                if results:
                    break
        return results
    except Exception:
        return []


def _tile_boxes(frame_width: int, frame_height: int) -> list[tuple[int, int, int, int]]:
    """Four overlapping tiles for distant/small plates; used only as a fallback."""
    overlap = 0.16
    mid_x = frame_width // 2
    mid_y = frame_height // 2
    dx = int(frame_width * overlap)
    dy = int(frame_height * overlap)
    regions = [
        (0, 0, min(frame_width, mid_x + dx), min(frame_height, mid_y + dy)),
        (max(0, mid_x - dx), 0, frame_width, min(frame_height, mid_y + dy)),
        (0, max(0, mid_y - dy), min(frame_width, mid_x + dx), frame_height),
        (max(0, mid_x - dx), max(0, mid_y - dy), frame_width, frame_height),
    ]
    return [(x1, y1, x2 - x1, y2 - y1) for x1, y1, x2, y2 in regions if x2 > x1 and y2 > y1]


def _run_alpr(frame, offset_x: int = 0, offset_y: int = 0) -> list[dict]:
    found = parse_fast_results(frame)
    if offset_x or offset_y:
        for item in found:
            box = item.get('bbox')
            if box:
                box = dict(box)
                box['x'] = int(box.get('x', 0) + offset_x)
                box['y'] = int(box.get('y', 0) + offset_y)
                item['bbox'] = box
            item['detectionPass'] = 'tiled'
    else:
        for item in found:
            item['detectionPass'] = 'full-frame'
    return found


def detect_frame(frame) -> list[dict]:
    global ENGINE, ENGINE_NAME, INFERENCE_FAILURES, LAST_INFERENCE_FAILURE
    results = []
    try:
        if ENGINE_NAME.startswith('FastALPR'):
            results = _run_alpr(frame)
            height, width = frame.shape[:2]
            enable_tiles = os.getenv('ALPR_TILED_FALLBACK', 'true').lower() == 'true'
            needs_recovery = not results or max(
                (float(x.get('confidence', 0.0)) for x in results), default=0.0
            ) < float(os.getenv('ALPR_TILE_RETRY_CONFIDENCE', '0.72'))
            # Small plates often disappear after resizing an entire 1080p/4K frame
            # to the detector's network input. Only tile larger images when the
            # normal pass did not return strong candidates, preserving speed.
            if enable_tiles and min(width, height) >= 700 and width * height >= 1_000_000 and needs_recovery:
                tile_results = []
                for x, y, w, h in _tile_boxes(width, height):
                    tile = frame[y:y + h, x:x + w]
                    for candidate in _run_alpr(tile, x, y):
                        tile_results.append(candidate)
                results.extend(tile_results)
        else:
            results = easyocr_fallback(frame)
    except Exception as exc:
        INFERENCE_FAILURES += 1
        LAST_INFERENCE_FAILURE = f'{type(exc).__name__}: {exc}'
        results = []
    # Rank format-plausible candidates, but don't equate model confidence with certainty.
    deduped = {}
    for item in results:
        plate = item.get('plate', '')
        key = (plate, (item.get('bbox') or {}).get('x', -1), (item.get('bbox') or {}).get('y', -1))
        old = deduped.get(key)
        if old is None or item.get('confidence', 0) > old.get('confidence', 0):
            deduped[key] = item
    return sorted(deduped.values(), key=lambda x: (x['confidence'] * (0.8 + 0.2 * x['shapeScore'])), reverse=True)


def worker_warnings() -> list[str]:
    warnings = []
    if ENGINE_WARNING:
        warnings.append(ENGINE_WARNING)
    if INFERENCE_FAILURES:
        warnings.append(f'{INFERENCE_FAILURES} frame inference failure(s); latest: {LAST_INFERENCE_FAILURE}')
    return warnings


def combine_observations(observations: list[dict]) -> list[dict]:
    """Aggregate OCR candidates across distinct frames.

    Repeated support matters more than one isolated high-confidence OCR result.
    Confidence remains an engine score, not a calibrated probability.
    """
    grouped = defaultdict(dict)
    for item in observations:
        plate = item['plate']
        frame = item['frameIndex']
        old = grouped[plate].get(frame)
        if old is None or item['confidence'] > old['confidence']:
            grouped[plate][frame] = item

    candidates = []
    for plate, by_frame in grouped.items():
        seen = list(by_frame.values())
        confidences = [max(0.0, min(1.0, float(item['confidence']))) for item in seen]
        mean_conf = sum(confidences) / max(1, len(confidences))
        max_conf = max(confidences, default=0.0)
        support = len(seen)
        shape = shape_score(plate)
        support_score = min(1.0, support / 3.0)
        # A single standout frame cannot outrank a consistent plate by confidence alone.
        rank = (0.52 * support_score) + (0.32 * mean_conf) + (0.10 * max_conf) + (0.06 * shape)
        best = max(seen, key=lambda item: item['confidence'])
        candidates.append({
            'plate': plate,
            'rawText': best['rawText'],
            'confidence': round(mean_conf, 4),
            'maxConfidence': round(max_conf, 4),
            'supportFrames': support,
            'frameIndices': sorted(by_frame.keys()),
            'timestampsSeconds': sorted(round(float(x['timestampSeconds']), 3) for x in seen),
            'bbox': best.get('bbox'),
            'engine': best.get('engine', ENGINE_NAME),
            'rankScore': round(rank, 4),
        })
    candidates.sort(key=lambda c: (c['rankScore'], c['supportFrames'], c['maxConfidence']), reverse=True)
    return candidates


def process_file(path: Path, sample_fps: float, max_frames: int, min_confidence: float) -> dict:
    start = time.perf_counter()
    ext = path.suffix.lower()
    if not path.is_file():
        return {'file': str(path), 'status': 'ERROR', 'error': 'File not found.', 'candidates': [], 'selectedPlate': None}
    observations = []
    if ext in IMAGE_EXTS:
        frame = cv2.imread(str(path))
        if frame is None:
            return {'file': str(path), 'mediaType': 'IMAGE', 'status': 'ERROR', 'error': 'Image decode failed.', 'candidates': [], 'selectedPlate': None}
        detections = detect_frame(frame)
        for candidate in detections:
            candidate = dict(candidate); candidate['frameIndex'] = 0; candidate['timestampSeconds'] = 0.0
            observations.append(candidate)
        candidates = combine_observations(observations)
        best = candidates[0] if candidates else None
        selected = best['plate'] if best and best['confidence'] >= min_confidence and shape_score(best['plate']) >= 1.0 else None
        status = 'PLATE_CANDIDATE_FOUND' if selected else ('REVIEW_REQUIRED' if best else 'NOT_FOUND')
        return {'file': str(path), 'mediaType': 'IMAGE', 'status': status, 'selectedPlate': selected, 'bestCandidate': best, 'candidates': candidates[:10], 'framesProcessed': 1, 'elapsedSeconds': round(time.perf_counter()-start, 3), 'engine': ENGINE_NAME, 'warnings': worker_warnings()}
    if ext not in VIDEO_EXTS:
        return {'file': str(path), 'status': 'UNSUPPORTED_MEDIA', 'error': f'Unsupported extension: {ext}', 'candidates': [], 'selectedPlate': None}
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        cap.release(); return {'file': str(path), 'mediaType': 'VIDEO', 'status': 'ERROR', 'error': 'Video could not be opened/decoded.', 'candidates': [], 'selectedPlate': None}
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    if not 0 < fps <= 240: fps = 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = total/fps if total > 0 else None
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0); height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    max_duration = int(os.getenv('MAX_VIDEO_SECONDS', '120'))
    if duration is not None and duration > max_duration:
        cap.release()
        return {'file': str(path), 'mediaType': 'VIDEO', 'status': 'ERROR', 'error': f'Video duration ({duration:.1f}s) exceeds configured limit ({max_duration}s).', 'candidates': [], 'selectedPlate': None, 'video': {'durationSeconds': round(duration, 3), 'fps': round(fps, 3), 'frameCount': total}, 'elapsedSeconds': round(time.perf_counter()-start, 3)}
    # Sequential decoding avoids the repeated random seeks that slow down many
    # compressed MP4/AVI files. Only selected frames are fully retrieved for OCR.
    if total > 0:
        desired = min(max_frames, max(1, int(round((duration or 1) * sample_fps))))
        interval = max(1, int((total + desired - 1) // desired))
        frame_idx = 0
        sampled_frames = 0
        while frame_idx < total and sampled_frames < max_frames:
            if frame_idx % interval == 0:
                ok, frame = cap.read()
                if not ok or frame is None:
                    break
                for item in detect_frame(frame):
                    item = dict(item)
                    item['frameIndex'] = frame_idx
                    item['timestampSeconds'] = float(frame_idx / fps)
                    observations.append(item)
                sampled_frames += 1
            else:
                if not cap.grab():
                    break
            frame_idx += 1
    else:
        interval = max(1, int(round(fps / sample_fps)))
        frame_idx = 0
        sampled_frames = 0
        while sampled_frames < max_frames:
            if frame_idx % interval == 0:
                ok, frame = cap.read()
                if not ok or frame is None:
                    break
                for item in detect_frame(frame):
                    item = dict(item)
                    item['frameIndex'] = frame_idx
                    item['timestampSeconds'] = float(frame_idx / fps)
                    observations.append(item)
                sampled_frames += 1
            else:
                if not cap.grab():
                    break
            frame_idx += 1
    cap.release()
    candidates = combine_observations(observations)
    best = candidates[0] if candidates else None
    second = candidates[1] if len(candidates) > 1 else None
    ambiguous = bool(best and second and second['supportFrames'] >= best['supportFrames'] and abs(second['rankScore']-best['rankScore']) < 0.08)
    min_consensus_frames = max(2, min(int(os.getenv('MIN_CONSENSUS_FRAMES', '3')), 10))
    consensus = bool(best and best['supportFrames'] >= min_consensus_frames and best['confidence'] >= min_confidence and shape_score(best['plate']) >= 1.0 and not ambiguous)
    selected = best['plate'] if consensus else None
    status = 'CONSISTENT_CANDIDATE' if selected else ('REVIEW_REQUIRED' if best else 'NOT_FOUND')
    return {'file': str(path), 'mediaType': 'VIDEO', 'status': status, 'selectedPlate': selected, 'bestCandidate': best, 'candidates': candidates[:10], 'ambiguous': ambiguous, 'video': {'fps': round(fps, 3), 'frameCount': total or None, 'durationSeconds': round(duration, 3) if duration is not None else None, 'width': width, 'height': height}, 'framesProcessed': sampled_frames, 'elapsedSeconds': round(time.perf_counter()-start, 3), 'engine': ENGINE_NAME, 'warnings': worker_warnings()}


def emit(payload):
    print(json.dumps(payload, separators=(',', ':'), ensure_ascii=False), flush=True)


def stream_mode(test_only=False):
    """Read stream config from stdin, keeping RTSP credentials out of command args."""
    line = sys.stdin.readline()
    if not line:
        emit({'type': 'error', 'status': 'ERROR', 'message': 'Missing stream configuration on stdin.'}); return 2
    try: cfg = json.loads(line)
    except Exception:
        emit({'type': 'error', 'status': 'ERROR', 'message': 'Invalid stream configuration JSON.'}); return 2
    url = str(cfg.get('streamUrl') or '')
    if not url.startswith(('rtsp://', 'rtsps://', 'http://', 'https://')):
        emit({'type': 'error', 'status': 'ERROR', 'message': 'Unsupported stream scheme.'}); return 2
    try: init_engine()
    except Exception as exc:
        emit({'type': 'error', 'status': 'ERROR', 'message': f'ALPR initialization failed: {exc}'}); return 3
    cap = cv2.VideoCapture(url)
    if not cap.isOpened():
        cap.release(); emit({'type': 'error', 'status': 'DISCONNECTED', 'message': 'Could not open stream.'}); return 4
    if test_only:
        ok, frame = cap.read(); cap.release()
        if not ok or frame is None:
            emit({'type': 'test_result', 'ok': False, 'message': 'Stream opened but no frame could be decoded.'}); return 5
        found = detect_frame(frame)
        emit({'type': 'test_result', 'ok': True, 'frameDecoded': True, 'candidates': found[:5], 'engine': ENGINE_NAME})
        return 0
    interval = max(0.3, min(float(cfg.get('sampleIntervalSeconds', 1)), 30))
    cooldown = max(5, min(float(cfg.get('eventCooldownSeconds', 20)), 600))
    threshold = float(os.getenv('OCR_MIN_CONFIDENCE', '0.80'))
    history = deque(maxlen=4)
    last_event_at = {}
    emit({'type': 'status', 'status': 'CONNECTED', 'message': 'Stream opened; sampling frames.'})
    next_sample = time.monotonic()
    frame_index = 0
    while True:
        ok, frame = cap.read()
        if not ok or frame is None:
            emit({'type': 'status', 'status': 'DISCONNECTED', 'message': 'Stream stopped delivering frames.'})
            break
        frame_index += 1
        now = time.monotonic()
        if now < next_sample: continue
        next_sample = now + interval
        current = detect_frame(frame)
        history.append({x['plate']: x for x in current[:5]})
        counts = Counter(plate for group in history for plate in group.keys())
        if not counts: continue
        plate, votes = counts.most_common(1)[0]
        observations = [group[plate] for group in history if plate in group]
        confidence = sum(x['confidence'] for x in observations)/max(1, len(observations))
        min_votes = max(2, min(int(os.getenv('CCTV_MIN_CONSENSUS_VOTES', '3')), 4))
        if votes < min_votes or confidence < threshold: continue
        if now - last_event_at.get(plate, -1e9) < cooldown: continue
        last_event_at[plate] = now
        emit({'type': 'plate_event', 'status': 'CONSISTENT_CANDIDATE' if shape_score(plate) >= 1.0 else 'REVIEW_REQUIRED', 'selectedPlate': plate if shape_score(plate) >= 1.0 else None, 'candidatePlate': plate, 'confidence': round(confidence, 4), 'frameIndex': frame_index, 'timestampSeconds': None, 'framesProcessed': len(history), 'candidates': [{'plate': plate, 'confidence': round(confidence, 4), 'supportFrames': votes, 'engine': ENGINE_NAME}], 'engine': ENGINE_NAME})
    cap.release()
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', help='Path to image/video file')
    parser.add_argument('--json', action='store_true', help='Output one JSON result')
    parser.add_argument('--stream', action='store_true', help='Read authorized stream config from stdin and emit JSON Lines events')
    parser.add_argument('--test-stream', action='store_true', help='Open stream, decode one frame, return JSON Lines test result')
    args = parser.parse_args()
    if args.stream or args.test_stream:
        return stream_mode(test_only=args.test_stream)
    if not args.input:
        emit({'status': 'ERROR', 'error': 'Pass --input <media-path>.', 'candidates': [], 'selectedPlate': None}); return 2
    try:
        init_engine()
        min_confidence = float(os.getenv('OCR_MIN_CONFIDENCE', '0.80'))
        sample_fps = max(0.25, min(float(os.getenv('VIDEO_SAMPLE_FPS', '5')), 15))
        max_frames = max(1, min(int(os.getenv('MAX_VIDEO_FRAMES', '240')), 2000))
        result = process_file(Path(args.input).resolve(), sample_fps, max_frames, min_confidence)
        result['statusCode'] = result.get('status')
        emit(result)
        return 0
    except Exception as exc:
        emit({'status': 'INIT_ERROR', 'error': f'{type(exc).__name__}: {exc}', 'candidates': [], 'selectedPlate': None, 'engine': ENGINE_NAME})
        return 3

if __name__ == '__main__':
    raise SystemExit(main())
