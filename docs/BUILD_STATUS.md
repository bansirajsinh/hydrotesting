# Build and Verification Status

Generated for handoff: 2026-10-10.

## Checks actually executed in this environment

| Check | Result | Notes |
|---|---|---|
| Node.js source syntax | PASS | `node --check` passed for server, app, domain, scanner, camera manager, verification service, browser JS and scripts |
| Node.js unit tests | PASS (13/13) | 8 domain tests + 5 verification-service tests using an in-memory fake database; Node dependency imports were provided through temporary test-only stubs because npm dependencies were not installed |
| Python scanner tests | PASS (8/8) | Plate normalization, Indian/BH-shaped formats, ambiguous OCR preservation, and multi-frame consensus rules |
| Python bytecode compilation | PASS | Scanner, Awiros adapter, model setup and benchmark scripts compile |
| ZIP integrity | To be checked at packaging | Run `unzip -t fuelflux-cng-verification.zip` after creating the final archive |

## Checks not run or blocked

| Check | Status | Why |
|---|---|---|
| Real Express/MongoDB integration | NOT RUN | MongoDB service was not available and npm dependency installation timed out in this environment |
| Database startup/index migration | NOT RUN | Requires the official installed MongoDB Node.js driver and a reachable MongoDB server |
| Seed execution against MongoDB | NOT RUN | Requires installed Node dependencies and a running database |
| Actual FastALPR/Awiros inference | NOT RUN | Model libraries/weights were not installed here |
| EasyOCR fallback inference | NOT RUN | Optional fallback dependencies were not installed |
| Actual video recognition accuracy | NOT MEASURED | No vehicle video/photo files or labelled ground-truth plate list were available in the source-media directory |
| Live CCTV integration | NOT RUN | No authorized, reachable CCTV/RTSP stream was supplied |
| Browser end-to-end/UI test | NOT RUN | The app could not be started with real dependencies in this environment |

## Database-driven verification updates

- Plate verification now looks up an indexed normalized plate and includes a compatibility fallback for legacy vehicle records with formatted plates or missing normalized fields.
- A registered vehicle can be surfaced with its linked active CNG assets and latest hydrotest record even when the OCR candidate does not meet automatic-approval confidence. In that case, the identity decision remains on hold/review; the UI does not treat it as approved.
- The scan detail response exposes `vehicleRegistered`, `linkedAssetCount`, `hydrotestStatus`, `allRequiredAssetsValid`, `fuelingEligibility`, and per-asset evaluations.
- A reverify endpoint rechecks a saved candidate against the current database without repeating OCR.
- Legacy date/datetime values from older records are normalized before due-date evaluation.
- The initial database connection performs a ping, normalized-plate backfill and index checks before marking the database available.
- Seed records carry demo provenance and include PASS, FAIL, OVERDUE and NO_RECORD cases.
- A read-only `npm run check:plate -- GJ01AB1234` diagnostic helps inspect the existing database's current vehicle, asset and hydrotest records once MongoDB is running.

## Scanner/model status

- FastALPR and the Indian-specific Awiros OCR adapter are configured by the project, with model setup documented separately.
- OCR model weights are downloaded during setup and are not bundled in the ZIP.
- The labelled benchmark script is available at `scripts/benchmark_alpr.py`; provide a ground-truth CSV to measure exact plate matches, coverage, false automatic accepts and per-file latency.
- The published model benchmark is not a guarantee of accuracy on this station's moving-vehicle footage. Do not claim a project accuracy number before measuring it against verified plate labels.

## Before calling the project end-to-end verified

1. Install the documented Node and Python dependencies.
2. Start MongoDB or configure a trusted MongoDB URI.
3. Run `npm run seed` and confirm the demo records exist.
4. Run the real `npm test`, `npm run test:python`, and `npm run check` commands without test-only stubs.
5. Put authorized source videos/photos in `data/supplied-media/` and run the scanner.
6. Manually verify their true plate numbers, then run the benchmark.
7. Test a supported, authorized CCTV stream and confirm reconnect/error handling.
8. Verify all database integration scenarios and browser workflows.

The currently passing unit tests validate business/normalization logic; they are not evidence of live MongoDB, actual OCR inference, CCTV connectivity, or end-to-end UI operation.
