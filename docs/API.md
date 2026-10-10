# API Reference

Base path: `/api`. JSON responses use native MongoDB `ObjectId` values serialized as strings.

## Health and dashboard

- `GET /api/health` — verifies API and MongoDB ping; returns database/demo status.
- `GET /api/dashboard` — counts vehicles/assets/scans, computes current hydrotest status per active asset, returns scan volume for the last seven UTC dates and recent scans/verifications.

## Vehicles

- `GET /api/vehicles?q=&active=&stationId=&page=&pageSize=&sortBy=&sortOrder=`
- `POST /api/vehicles`
- `GET /api/vehicles/:id`
- `PATCH /api/vehicles/:id`

Example create body:

```json
{
  "plateNumber": "GJ01AB1234",
  "vehicleCategory": "CNG_CAR",
  "stationId": "STATION-DEMO-001",
  "make": null,
  "model": null,
  "recordSource": "OPERATOR"
}
```

Vehicle categories: `CNG_CAR`, `CNG_VAN`, `CNG_BUS`, `CNG_COMMERCIAL`, `OTHER_CNG`. Plate uniqueness is enforced on `plateNumberNormalized`. Supported-format syntax checking is not government registry verification.

## CNG assets

- `GET /api/assets?q=&active=&stationId=&page=&pageSize=`
- `POST /api/assets`
- `GET /api/assets/:id`
- `PATCH /api/assets/:id`

Example:

```json
{
  "assetCode": "CNG-ASSET-DEMO-001",
  "vehicleId": "<vehicle ObjectId>",
  "assetType": "CNG_CYLINDER",
  "serialNumber": "DEMO-SERIAL-001",
  "stationId": "STATION-DEMO-001"
}
```

Asset types: `CNG_CYLINDER`, `CNG_TANK`, `CNG_EQUIPMENT`.

## Hydrotests

- `GET /api/hydrotests?q=&result=&page=&pageSize=`
- `POST /api/hydrotests`
- `GET /api/hydrotests/:id`
- `PATCH /api/hydrotests/:id`

Example:

```json
{
  "assetId": "<asset ObjectId>",
  "testDate": "2026-10-01",
  "nextDueDate": "2027-10-01",
  "performedBy": "Demo Inspection Services",
  "result": "PASS",
  "certificateReference": "DEMO-CERT-123",
  "notes": "Synthetic demo record"
}
```

Result values: `PASS`, `FAIL`, `PENDING`. Dates must be valid `YYYY-MM-DD`, and next due date must not precede test date. A reference to a non-existent asset is rejected.

## Manual scans

`POST /api/scans` uses `multipart/form-data` with one or more files under the field `files` (maximum 20 in one request). A `202 Accepted` response returns scan IDs:

```json
{
  "items": [
    { "_id": "<scan ObjectId>", "status": "QUEUED", "originalFilename": "entry.mp4" }
  ],
  "message": "Scan jobs queued. Poll /api/scans/:id for actual progress and results."
}
```

Then poll `GET /api/scans/:id` until terminal status. Scan statuses include `QUEUED`, `PROCESSING`, `COMPLETED`, `REVIEW_REQUIRED`, `FAILED` and `UNREADABLE`. `GET /api/scans` returns paginated history. `GET /api/scans/:id/media` serves the stored upload for the local prototype. The scan-detail response includes `vehicleRegistered`, `hydrotestStatus`, `allRequiredAssetsValid`, `fuelingEligibility`, `matchedVehicle`, and `assetEvaluations`, so the UI can show database status independently from OCR confidence.

`POST /api/scans/batch` scans supported files placed by an operator in `data/supplied-media/`. It does not fabricate results if that folder is empty.

`POST /api/scans/:id/reverify` rechecks the saved plate candidate against the **current** vehicle/asset/hydrotest collections without rerunning OCR. It creates a new verification/audit entry and updates the scan's latest decision/status summary. A candidate that did not meet the scanner's consensus policy remains on review/hold.

`POST /api/scans/:id/review` body:

```json
{
  "plateNumber": "GJ01AB1234",
  "reason": "Reviewed against source frame; the OCR candidate was corrected."
}
```

A correction is audited and the record lookup is rerun. It does not alter hydrotest data.

## CCTV

- `GET /api/cameras` — stream URLs/credentials are redacted.
- `POST /api/cameras` — create camera with `cameraName`, `streamUrl`, optional `stationId`.
- `PATCH /api/cameras/:id` — edit settings; `streamUrl` may be omitted to preserve it.
- `POST /api/cameras/:id/test` — opens stream and attempts to decode a frame.
- `POST /api/cameras/:id/start` — starts a Python stream worker and persists stable candidate events/decisions.
- `POST /api/cameras/:id/stop` — requests worker termination.

Only configure camera streams you are authorized to access. An actual hardware camera is required to verify live operation.

## Verification history and demo seed

- `GET /api/verifications` — filters/paginates verification decisions.
- `POST /api/demo/seed` — only enabled if `DEMO_MODE=true` and `ALLOW_DEMO_SEED=true`.

## Errors

Error response:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "A readable error message.",
    "requestId": "<request id>"
  }
}
```

Duplicate keys return `409 Conflict`, oversized uploads `413`, unsupported files are rejected, invalid input returns `400`, and server errors return a safe message. Detailed server errors are logged to the backend terminal with a request ID.
