# Plate Recognition Model Selection and Setup

## Configured default

The scanner is configured for a two-stage pipeline:

1. **Detection:** FastALPR / Open Image Models `yolo-v9-s-608-license-plate-end2end` to find plate regions. Its larger 608-pixel model is selected to help retain small/distant plate detail; it costs more inference than smaller models. The model publisher lists detection metrics on its benchmark, but those are not Indian CCTV end-to-end recognition metrics.
2. **Recognition:** the Awiros-ANPR-OCR model (PP-OCRv5 / `SVTR_HGNet`, 37.3M parameters) through `cv_worker/awiros_ocr.py`. This OCR model is tuned for Indian plate text and supports non-standard/two-row examples. Its publisher reports 98.42% exact text accuracy on its held-out test data, but that figure is a publisher result on its own test set, not a guarantee for the station camera or for moving cars.
3. **Temporal evidence:** candidates are aggregated across separate video frames. A consistent result is preferred to an isolated high score. If results disagree or confidence is insufficient, the scanner returns a review status and does not silently pick a guessed plate.
4. **Verification:** Express looks up a matched active vehicle and its linked CNG asset/hydrotest records in MongoDB. OCR never independently proves hydrotest compliance.

## Installation

Use Python 3.10 or 3.11 to avoid common compatibility friction in the PaddlePaddle dependency chain. In the same virtual environment that Express calls through `PYTHON_EXECUTABLE`, run:

```powershell
py -3.11 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r cv_worker/requirements.txt
pip install -r cv_worker/requirements-india.txt
python scripts/setup-indian-ocr.py
```

On macOS/Linux, create/activate `.venv` using `python3 -m venv .venv` and `source .venv/bin/activate`, then use the same `pip` commands. The setup script downloads the approx. 149 MB OCR weights, verifies the expected SHA-256, downloads the character dictionary and fetches PaddleOCR source. Model weights and vendored model code are intentionally not packed in the source ZIP.

In `.env`, confirm:

```env
ALPR_ENGINE=fast_alpr_india
ALPR_DETECTOR_MODEL=yolo-v9-s-608-license-plate-end2end
ALPR_DETECTOR_CONFIDENCE=0.22
ALPR_ALLOW_GENERIC_FALLBACK=false
AWIROS_DEVICE=cpu
```

If your shell's `python` is not the environment Node uses, set `PYTHON_EXECUTABLE` to the exact virtual-environment Python path, e.g. `.venv\Scripts\python.exe` on Windows. Restart Express after changing environment variables or model files. The detector's ONNX model is downloaded/cached the first time it runs.

## Compatibility and fallback policy

The Awiros adapter implements FastALPR's custom `BaseOCR` interface. If its dependencies/weights cannot initialise, the default is to report a scanner initialization error—not to silently downgrade to generic OCR. To explicitly use the general-purpose FastALPR OCR, set `ALPR_ENGINE=fast_alpr` or set `ALPR_ALLOW_GENERIC_FALLBACK=true`, then benchmark and label those results differently. EasyOCR is an optional fallback mode (`ALPR_ENGINE=easyocr`), not the accuracy-first configuration.

## Tuning

- Improve camera focus, shutter speed, exposure, angle and plate pixels before trying increasingly expensive models. Motion blur and small plate crops usually dominate OCR mistakes.
- `VIDEO_SAMPLE_FPS` and `MAX_VIDEO_FRAMES` trade processing time against opportunities to find a clear frame. Test with actual clips.
- `ALPR_TILED_FALLBACK=true` retries high-resolution frames as overlapping regions only when the full-frame result is absent or weak. This can recover small distant plates at additional cost.
- `MIN_CONSENSUS_FRAMES` controls how many distinct frames must support a video plate candidate. Adjacent near-identical frames are not truly independent; avoid treating repeated reads as proof.
- Do not weaken confidence or consensus thresholds solely to increase the number of automatic matches. Measure false accepts, false rejects and manual-review rates.

## Required accuracy benchmark

Before operational use, build a manually labelled dataset from the intended station's representative day/night, distance, angle and moving-vehicle footage. Keep capture sessions separate between tuning and final test data. Record exact full-plate accuracy, detector precision/recall, false-acceptance rate, false-rejection rate, review rate, and processing latency. Do not claim a numeric application accuracy until this has been run.

## References

- FastALPR custom OCR and detector APIs: https://github.com/ankandrew/fast-alpr
- Open Image Models detector model list: https://github.com/ankandrew/open-image-models
- Awiros Indian ANPR OCR model and publisher's benchmark: https://huggingface.co/Awiros/anpr-ocr
- Awiros source inference script at pinned revision: https://huggingface.co/Awiros/anpr-ocr/blob/844ce1f10cdf84db0f974fd4c048c7b99ffb92d1/test.py

Review software, model-weight and runtime licenses before commercial use. A model's benchmark should not be presented as the project's own measured result.

## Local labelled-data benchmark

After installing the model, build a manually checked CSV based on `data/ground_truth.example.csv` with headers `file,plate`. Put image/video paths relative to the repository root in `file`, and the plate transcribed by a human who reviewed the source in `plate`. Keep the final test set separate from any tuning set. Then run:

```bash
python scripts/benchmark_alpr.py --labels data/ground_truth.csv --output docs/benchmark-results.csv
```

The benchmark reuses the configured model in one process and reports top-candidate exact accuracy, automatic-selection coverage, false automatic accepts and per-file processing details. It does **not** train the model. A MongoDB vehicle list can validate/resolve recognized strings but cannot train visual recognition by itself: model fine-tuning requires labelled plate images/crops and a separate validation/test split. No measured accuracy should be claimed until the benchmark has been run on representative media.
