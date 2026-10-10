# Testing and Verification

## Automated tests included

Node unit tests (`npm test`) exercise:
- registration normalization and supported format screening;
- date-only parsing;
- status calculations for missing/pass/due-soon/overdue/failed/pending cases;
- conservative vehicle decision rules.

Python unit tests (`python -m unittest discover -s cv_worker/tests -v`) exercise:
- plate normalization without dangerous character substitutions;
- common Indian registration-shaped strings and BH-shaped strings;
- candidate aggregation across frames.

## Commands

```bash
npm test
npm run check
python -m unittest discover -s cv_worker/tests -v
python -m py_compile cv_worker/scan_media.py
```

## Manual integration checklist
- Start MongoDB and run `npm run seed`.
- Run `npm run dev`; verify `/api/health` responds with database connected.
- Add a vehicle and verify it appears after reload.
- Add a CNG asset linked to that vehicle.
- Add passing/failed/pending hydrotests and test status precedence.
- Upload a valid sample photo/video and poll its scan until terminal state.
- Confirm candidates, confidence, frames and decisions are stored in MongoDB.
- Try a missing plate and a plate not present in the vehicle database.
- Test duplicate plates and certificate references.
- Add an authorized camera URL, test frame decode and start/stop monitoring if a reachable stream is available.
- Confirm a database/worker failure cannot return `DISPENSING_ALLOWED`.

## Results from this artifact-generation environment
- Node syntax checks passed for the files checked during generation.
- 5 Node unit tests passed.
- 6 Python unit tests passed.
- Python compile check passed.
- Full Express/MongoDB API integration was not run because MongoDB and Node package dependencies were not installed/available in this environment.
- ALPR inference was not run because `fast-alpr`/ONNX models and EasyOCR were not installed here.
- No vehicle videos or photos were present in `data/supplied-media/`, so no actual plate has been extracted in this environment.
- No live CCTV stream was available; hardware-stream behavior must be verified by the user with authorized camera details.

Passing unit tests validate covered rules only; they do not establish recognition accuracy, camera availability, all-pages runtime correctness or production readiness.
