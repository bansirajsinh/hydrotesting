#!/usr/bin/env python3
"""Benchmark the configured ALPR pipeline against a manually labelled CSV.

CSV columns:
    file,plate

`file` is an image/video path relative to the repository root or an absolute
path. `plate` is the independently checked ground-truth string. This script
measures the configured pretrained pipeline; it does not train model weights.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "cv_worker"
sys.path.insert(0, str(WORKER))

import scan_media as scanner  # noqa: E402


def normalize(value: str) -> str:
    return scanner.normalize_plate(value or "")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", required=True, help="CSV with file,plate columns")
    parser.add_argument("--output", default="docs/benchmark-results.csv", help="Per-file output CSV")
    parser.add_argument("--sample-fps", type=float, default=float(os.getenv("VIDEO_SAMPLE_FPS", "5")))
    parser.add_argument("--max-frames", type=int, default=int(os.getenv("MAX_VIDEO_FRAMES", "240")))
    parser.add_argument("--min-confidence", type=float, default=float(os.getenv("OCR_MIN_CONFIDENCE", "0.80")))
    args = parser.parse_args()

    labels_path = Path(args.labels).expanduser().resolve()
    if not labels_path.is_file():
        print(f"Label CSV not found: {labels_path}", file=sys.stderr)
        return 2

    with labels_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or not {"file", "plate"}.issubset(reader.fieldnames):
            print("CSV must contain headers: file,plate", file=sys.stderr)
            return 2
        labels = [row for row in reader if (row.get("file") or "").strip()]

    if not labels:
        print("No labelled media rows found.", file=sys.stderr)
        return 2

    try:
        scanner.init_engine()
    except Exception as exc:
        print(f"Scanner initialization failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 3

    output_rows = []
    for index, row in enumerate(labels, start=1):
        file_value = (row.get("file") or "").strip()
        expected_raw = (row.get("plate") or "").strip()
        media_path = Path(file_value).expanduser()
        if not media_path.is_absolute():
            media_path = (ROOT / media_path).resolve()
        expected = normalize(expected_raw)
        started = time.perf_counter()
        if not expected:
            result = {"status": "INVALID_GROUND_TRUTH", "selectedPlate": None, "bestCandidate": None, "candidates": []}
        else:
            result = scanner.process_file(
                media_path,
                sample_fps=max(0.25, min(args.sample_fps, 15)),
                max_frames=max(1, min(args.max_frames, 2000)),
                min_confidence=max(0.1, min(args.min_confidence, 0.99)),
            )
        selected = normalize(result.get("selectedPlate") or "")
        best_candidate_obj = result.get("bestCandidate") or (result.get("candidates") or [None])[0]
        top_candidate = normalize((best_candidate_obj or {}).get("plate") or (best_candidate_obj or {}).get("normalizedText") or "")
        top_correct = bool(expected and top_candidate and top_candidate == expected)
        auto_selected = bool(selected)
        auto_correct = bool(auto_selected and selected == expected)
        false_accept = bool(auto_selected and selected != expected)
        output_rows.append({
            "file": str(media_path),
            "expectedPlate": expected,
            "selectedPlate": selected,
            "topCandidate": top_candidate,
            "topCandidateExact": top_correct,
            "automaticSelection": auto_selected,
            "automaticSelectionExact": auto_correct,
            "falseAutomaticAccept": false_accept,
            "status": result.get("status", "UNKNOWN"),
            "confidence": (best_candidate_obj or {}).get("confidence", ""),
            "supportFrames": (best_candidate_obj or {}).get("supportFrames", ""),
            "elapsedSeconds": result.get("elapsedSeconds", round(time.perf_counter() - started, 3)),
            "error": result.get("error", ""),
        })
        print(f"[{index}/{len(labels)}] {media_path.name}: expected={expected} top={top_candidate or 'NONE'} selected={selected or 'NONE'} status={result.get('status')}")

    total = len(output_rows)
    top_correct_count = sum(row["topCandidateExact"] for row in output_rows)
    auto_count = sum(row["automaticSelection"] for row in output_rows)
    auto_correct_count = sum(row["automaticSelectionExact"] for row in output_rows)
    false_accepts = sum(row["falseAutomaticAccept"] for row in output_rows)
    output_path = Path(args.output).expanduser()
    if not output_path.is_absolute():
        output_path = (ROOT / output_path).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(output_rows[0].keys()))
        writer.writeheader()
        writer.writerows(output_rows)

    metrics = {
        "labelledFiles": total,
        "topCandidateExactMatches": top_correct_count,
        "topCandidateExactAccuracy": round(top_correct_count / total, 4),
        "automaticSelections": auto_count,
        "automaticSelectionExactMatches": auto_correct_count,
        "automaticSelectionCoverage": round(auto_count / total, 4),
        "automaticSelectionExactAccuracyAmongAllFiles": round(auto_correct_count / total, 4),
        "falseAutomaticAccepts": false_accepts,
        "perFileReport": str(output_path),
        "engine": scanner.ENGINE_NAME,
        "note": "Run on representative, manually labelled data. This evaluates inference and does not train the model or establish regulatory compliance.",
    }
    print(json.dumps(metrics, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
