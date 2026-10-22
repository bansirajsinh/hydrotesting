# FuelFlux Automated Testing Documentation

This document describes the automated testing strategy, execution commands, and test suites verifying system correctness, data validation, and safety interlock behavior.

---

## 1. Test Suite Summary

The repository includes **26 automated test cases** across Node.js and Python test runners, requiring no third-party test framework installations (built on Node.js native test runner and Python `unittest`).

| Test Suite | File | Count | Focus |
|---|---|:---:|---|
| **Domain Logic** | `tests/domain.test.js` | 8 | Plate normalization, date parsing, safety status hierarchy, decision matrix |
| **Hydrotests API** | `tests/hydrotests.test.js` | 5 | Endpoints (`/api/hydrotests/*`), date validation, 409 conflict, timestamp preservation |
| **Verification Engine** | `tests/verification.test.js` | 5 | Interlock decision engine, safety blocks for overdue/failed tests, OCR consensus |
| **Python Computer Vision** | `cv_worker/tests/test_scanner.py` | 8 | Plate regex matching, Bharat series scoring, multi-frame OCR consensus |

---

## 2. Test Execution Commands

### Run Full Node.js Suite
```bash
npm test
```

### Run Full Python Unit Tests
```bash
npm run test:python
```

### Full Project Code Check & Tests
```bash
npm run check
```

---

## 3. Detailed Test Suite Coverage

### A. Domain & Business Rules (`tests/domain.test.js`)
- **Plate Normalization**: Confirms that whitespace, lowercase, and hyphens are normalized while preserving valid characters (`gj 01 ab 1234` -> `GJ01AB1234`).
- **Syntax Validation**: Tests standard Indian vehicle registration formats and Bharat Series (`21BH1234AA` passes; invalid characters like `21BH1234IO` fail).
- **Date-Only Parsing**: Confirms rejection of malformed or impossible dates (e.g. `2026-02-31`).
- **Asset Status Priority**:
  - `FAILED` takes absolute precedence over future expiration dates.
  - `OVERDUE` triggers immediately when `nextDueDate < today`.
  - `DUE_SOON` triggers when expiration is within 30 days.
  - `VALID` requires active test date and future expiration.

### B. Hydrotesting API Contract (`tests/hydrotests.test.js`)
- **GET `/api/hydrotests/summary`**: Validates summary counts schema (`totalAssets`, `valid`, `dueSoon`, `overdue`, `failed`, `pending`, `noRecord`).
- **GET `/api/hydrotests/assets`**: Verifies asset register contains at least 8 fictional assets.
- **GET `/api/hydrotests/records`**: Verifies at least 12 hydrotest records across Pass, Fail, Pending, due-soon, and overdue.
- **POST `/api/hydrotests/records` (Validation Rule)**: Asserts HTTP 400 Bad Request when `nextDueDate` is earlier than `testDate`.
- **Duplicate Certificate Handling**: Asserts HTTP 409 Conflict when attempting to create a hydrotest with an existing `certificateReference`.
- **Timestamp Integrity**: Asserts that `PATCH /api/hydrotests/records/:id` updates `updatedAt` while strictly preserving `createdAt`.

### C. Safety Interlock Engine (`tests/verification.test.js`)
- **Refueling Authorization**: Only allows dispensing when all linked cylinders have `PASS` and valid future dates.
- **Safety Blocking**: Verifies that any failed cylinder locks the dispenser (`DO_NOT_DISPENSE_FAILED`) even if the expiration date is far in the future.
- **Overdue Locking**: Verifies that expired tests immediately engage interlock lock (`DO_NOT_DISPENSE_OVERDUE`).
- **Unregistered Vehicles**: Issues `HOLD_VEHICLE_NOT_FOUND` hold state.

### D. Python ALPR & Consensus (`cv_worker/tests/test_scanner.py`)
- **Shape Scoring**: Verifies high shape scores for authentic Indian plates (`GJ01AB1234`, `21BH1234AA`) and rejects short non-plate text.
- **Multi-Frame Consensus**: Confirms that candidates seen across multiple distinct video frames outrank single-frame false positives.
