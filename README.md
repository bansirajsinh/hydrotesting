# FuelFlux CNG Hydrotest Verification System

A local-first demo application using **Vanilla HTML/CSS/JavaScript, Node.js/Express, MongoDB, and a Python ALPR worker**. It supports manual image/video uploads, database-backed vehicle and hydrotest records, scan history, and configurable CCTV stream monitoring.

> **Important:** The application produces an advisory verification result only. It does not connect to or control a real CNG dispenser. Do not treat seeded hydrotests as real compliance evidence. The seeded plates and vehicle records are synthetic demo fixtures. Actual accuracy must be tested on labelled Indian-plate footage before any operational use.

## Architecture

```text
Browser (Vanilla HTML/CSS/JS)
       │ HTTP/JSON + multipart upload
       ▼
Node.js + Express API ─── MongoDB
       │                    vehicles / cngAssets / hydrotests
       │                    scans / verifications / cameras / auditLogs
       ▼
Python worker (OpenCV + FastALPR plate detector + Awiros Indian-plate OCR)
       │ plate candidates, confidence, frame index, timestamp
       ▼
Backend verification service ── vehicle → active CNG assets → latest hydrotest
```

## Primary scanning engine

The accuracy-first configuration combines the higher-resolution FastALPR/Open Image Models `yolo-v9-s-608-license-plate-end2end` detector with the Indian-specific Awiros-ANPR-OCR recognizer via `cv_worker/awiros_ocr.py`. The scanner evaluates multiple frames, aggregates candidate support and sends uncertain cases for review. Its default is to fail clearly if the India-specific OCR model is not installed instead of silently falling back to the weaker generic OCR.

Install the base worker requirements and India-specific dependencies in the same Python virtual environment used by Node, then run `python scripts/setup-indian-ocr.py` to download and checksum-verify the model weights. The 149 MB weights and PaddleOCR source are intentionally not included in the project archive. Read [`docs/MODEL_SELECTION.md`](docs/MODEL_SELECTION.md) for configuration, compatibility and benchmark limitations. The publisher's reported benchmark is not a guaranteed result for FuelFlux videos; actual exact-plate accuracy must be measured on labelled station footage.

## Requirements

- Node.js 20+ and npm
- Python 3.10+
- MongoDB 7 (local or Atlas)
- Internet on the first model initialization if model weights need to be downloaded
- Optional: accessible RTSP camera stream and permission to monitor it

## Quick start (Windows PowerShell)

```powershell
# 1. From this folder, create a local env file
Copy-Item .env.example .env

# 2. Start local MongoDB (Docker required)
docker compose up -d mongodb

# 3. Install Node packages
npm install

# 4. Install Python worker packages
py -3.11 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r cv_worker/requirements.txt
pip install -r cv_worker/requirements-india.txt
python scripts/setup-indian-ocr.py

# 5. Seed synthetic demo data (idempotent)
npm run seed

# 6. Run the app
npm run dev
```

Open http://localhost:3000. The app binds to `127.0.0.1` by default because the demo does not include a complete authentication system. Keep it local; only change `HOST` after adding suitable authentication, firewall rules and deployment security. If Python is invoked as `python` but your environment uses `py -3.11`, set `PYTHON_EXECUTABLE` in `.env` to the full path of your virtual environment's Python executable, for example `.venv\\Scripts\\python.exe`.

## Quick start (macOS/Linux)

```bash
cp .env.example .env
docker compose up -d mongodb
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r cv_worker/requirements.txt
pip install -r cv_worker/requirements-india.txt
python scripts/setup-indian-ocr.py
npm run seed
npm run dev
```

## Try the workflow

1. Open **Scan Vehicle** and upload a short MP4/MOV/AVI/MKV/WebM video or image.
2. The API stores a media/scan record and runs the Python worker asynchronously.
3. The scan panel polls for status, shows OCR candidates, then queries MongoDB by the normalized plate. The result separates **registration match**, **per-asset hydrotest status**, and **fueling eligibility**. A valid database record is shown even when OCR needs review, but that uncertain identity remains on HOLD.
4. A vehicle that is not found can be registered through **Vehicle Database → Add Vehicle**. No unseen vehicle details are invented automatically.
5. Use **CCTV** to configure an authorized RTSP stream, test it, and start/stop monitoring. Streams require an actual reachable camera; no fake feed is used.
6. Browse assets, hydrotests, entry history and the review queue.

The scanner accepts upload field `files` and saves each scan and verification result. Each saved result includes `vehicleRegistered`, `hydrotestStatus`, `allRequiredAssetsValid`, `fuelingEligibility`, linked asset evaluations and decision reasons. Use **Refresh database check** on Scan Details after vehicle/test records change; it re-evaluates the saved plate candidate against current MongoDB records without re-running OCR. All source files uploaded in the app are stored locally; MongoDB stores metadata and decision records.

## Demo data

`npm run seed` inserts/updates synthetic test records and is safe to repeat. Plates such as `GJ01AB1234` are format-shaped examples only and are explicitly tagged `DEMO`; synthetic scan/history fixtures were generated to populate the UI, and these plate candidates were **not extracted from supplied videos**. No video files were attached in the work environment, so there is no actual-plate extraction report yet. Add supplied media to `data/supplied-media/` or use the upload UI.

To remove only demo records, set `ALLOW_DEMO_RESET=true` in `.env`, then run:

```bash
node scripts/seed-demo.js --reset
```

Reset is refused unless demo mode is enabled and this explicit flag is set. Read the script before using it on any non-demo database.

## Test the database decision for a known registered plate

After MongoDB is running and the demo records are seeded, run the read-only lookup smoke test:

```bash
npm run check:plate -- GJ01AB1234
```

The script reads the existing vehicle, active CNG assets and latest test records from MongoDB and prints the calculated decision. With demo data, `GJ01AB1234` is intended to have a passing, in-date record; `GJ18GH4567` demonstrates a failed test; `GJ06EF3456` demonstrates an overdue test; and `GJ18QR8901` has no hydrotest record. These are synthetic fixtures only. The script does not scan a video and assumes its typed plate is correct.

## Tests and checks

```bash
npm test
npm run check
python -m unittest discover -s cv_worker/tests
```

These tests cover pure business rules and validation. End-to-end OCR/CCTV tests need installed Python dependencies, a test media fixture, a running MongoDB instance, and (for live stream testing) an authorized reachable camera. A source check alone does not establish OCR accuracy.

## API

API endpoints are under `/api`:

- `GET /api/health`
- `GET/POST /api/vehicles`, `GET/PATCH /api/vehicles/:id`
- `GET/POST /api/assets`, `GET/PATCH /api/assets/:id`
- `GET/POST /api/hydrotests`, `GET/PATCH /api/hydrotests/:id`
- `GET/POST /api/scans`, `GET /api/scans/:id`, `POST /api/scans/:id/reverify`, `POST /api/scans/:id/review`
- `GET/POST /api/cameras`, `POST /api/cameras/:id/test|start|stop`
- `GET /api/verifications`, `GET /api/dashboard`
- `POST /api/demo/seed` (development demo mode only)

Use the `docs/API.md` and `docs/DATABASE_SETUP.md` for request examples and connectivity details.

## Decision model and safety

The backend applies one shared rule set. No candidate, low confidence, conflicting candidates, unknown vehicle, missing asset/hydrotest, failed/overdue/pending test, due-soon item under the default hold-for-review policy, or unavailable database must not silently become `DISPENSING_ALLOWED`. An allowed result in demo mode only means the **synthetic demo records meet the configured example rules**. Production regulatory rules and certificate acceptance require review by an authorized compliance owner. Do not connect this prototype directly to fuel-pump hardware.

## Model calibration and training

The pretrained India-specific OCR model is integrated into the scan path, but it has **not been retrained on your station footage**. Vehicle/hydrotest database records are lookup ground truth for eligibility, not training examples for computer vision. To fine-tune or claim accuracy for your camera, collect labelled plate crops or clips (file/frame plus verified plate string), separate a held-out test set, and measure exact full-plate accuracy plus false-acceptance/rejection. See `scripts/benchmark_alpr.py` and `docs/MODEL_SELECTION.md`.

## Known limitations

- FastALPR default weights are not specifically validated here on Indian CNG-station footage.
- The code cannot claim actual precision/recall until a labelled, representative dataset has been tested.
- RTSP monitoring has been implemented as a configurable worker workflow, but it cannot be verified without reachable camera details.
- Camera credentials are stored in the local demo database; for production use, put secrets in a secret manager or encrypt them at rest and restrict access.
- There is no government registration lookup. Format validation is syntax checking, not government confirmation.
- Authentication/authorization are not a complete production user-management system; deploy only in a trusted development environment until that is added.

## Official/primary references

- [FastALPR](https://github.com/ankandrew/fast-alpr)
- [FastALPR PyPI package/version and extras](https://pypi.org/project/fast-alpr/)
- [MongoDB Node.js driver](https://www.mongodb.com/docs/drivers/node/current/connect/)
- [Express documentation](https://expressjs.com/en/)
- [OpenCV documentation](https://docs.opencv.org/)
- [Parivahan](https://parivahan.gov.in/) and [MoRTH](https://morth.nic.in/) for official vehicle-registration references; the app does not claim to validate against the government's live registry.
