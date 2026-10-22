# FuelFlux API Specification

This document details the RESTful HTTP API contract for the FuelFlux Hydrotesting & Inspection Workflow, including request/response schemas, validation rules, and status codes.

---

## 1. Hydrotesting Contract Endpoints (Assignment Specification)

### A. Dashboard Summary
- **Endpoint**: `GET /api/hydrotests/summary`
- **Description**: Returns aggregated metrics across all registered assets and inspection records.
- **Response**: `200 OK`
```json
{
  "totalAssets": 15,
  "valid": 9,
  "dueSoon": 2,
  "overdue": 2,
  "failed": 1,
  "pending": 1,
  "noRecord": 0
}
```

---

### B. List / Search CNG Assets
- **Endpoint**: `GET /api/hydrotests/assets`
- **Query Parameters**:
  - `q` (optional): Free-text search matching `assetCode`, `serialNumber`, or `stationId`
  - `stationId` (optional): Filter by station identifier
  - `status` (optional): Filter by computed status (`VALID`, `DUE_SOON`, `OVERDUE`, `FAILED`, `PENDING`)
  - `pageSize` (optional): Maximum results (default: 50)
- **Response**: `200 OK`
```json
{
  "items": [
    {
      "_id": "6716a12b48d21c320e8b4567",
      "assetCode": "CNG-CYL-RJ14-01",
      "vehicleId": "6716a10048d21c320e8b4501",
      "assetType": "CNG_CYLINDER",
      "serialNumber": "EKC-2021-998214",
      "stationId": "STATION-DEMO-001",
      "active": true,
      "createdAt": "2026-10-21T18:00:00.000Z",
      "updatedAt": "2026-10-21T18:00:00.000Z"
    }
  ]
}
```

---

### C. Create CNG Asset
- **Endpoint**: `POST /api/hydrotests/assets`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
```json
{
  "assetCode": "CNG-CYL-NEW-01",
  "vehicleId": "6716a10048d21c320e8b4501",
  "assetType": "CNG_CYLINDER",
  "serialNumber": "SN-2024-88412",
  "stationId": "STATION-DEMO-001"
}
```
- **Validation**:
  - `assetCode`: Required string (max 80 chars)
  - `vehicleId`: Required valid ID referencing an existing vehicle
  - `assetType`: Must be one of `CNG_CYLINDER`, `CNG_TANK`, `CNG_EQUIPMENT`
- **Response**: `201 Created`

---

### D. List Hydrotest Records
- **Endpoint**: `GET /api/hydrotests/records`
- **Query Parameters**:
  - `q` (optional): Search certificate reference or provider
  - `result` (optional): `PASS`, `FAIL`, `PENDING`
  - `pageSize` (optional): Maximum items returned
- **Response**: `200 OK`
```json
{
  "items": [
    {
      "_id": "6716a13c48d21c320e8b4601",
      "assetId": "6716a12b48d21c320e8b4567",
      "vehicleId": "6716a10048d21c320e8b4501",
      "testDate": "2024-03-15",
      "nextDueDate": "2027-03-15",
      "performedBy": "Apex Gas Testing Authority",
      "result": "PASS",
      "certificateReference": "PESO-CERT-2024-8841",
      "notes": "Hydrostatic stretch test passed at 300 bar.",
      "createdAt": "2026-10-21T18:00:00.000Z",
      "updatedAt": "2026-10-21T18:00:00.000Z"
    }
  ]
}
```

---

### E. Record Hydrotest
- **Endpoint**: `POST /api/hydrotests/records`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
```json
{
  "assetId": "6716a12b48d21c320e8b4567",
  "testDate": "2026-05-10",
  "nextDueDate": "2029-05-10",
  "performedBy": "National Gas Inspection Lab",
  "result": "PASS",
  "certificateReference": "CERT-2026-9021",
  "notes": "Cylinder wall thickness verified. Expansion within 3%."
}
```
- **Validation**:
  - `assetId`: Required ID referencing existing cylinder
  - `testDate`: Valid ISO date (`YYYY-MM-DD`)
  - `nextDueDate`: Valid ISO date; **must NOT be earlier than `testDate`**
  - `result`: Must be `PASS`, `FAIL`, or `PENDING`
  - `certificateReference`: Unique statutory certificate number. Duplicate returns `409 Conflict`.
- **Response**: `201 Created`

---

### F. Get Record by ID
- **Endpoint**: `GET /api/hydrotests/records/:id`
- **Response**: `200 OK` (or `404 Not Found`)

---

### G. Update Hydrotest Record
- **Endpoint**: `PATCH /api/hydrotests/records/:id`
- **Headers**: `Content-Type: application/json`
- **Request Body**: (Any updatable fields, e.g. `result`, `notes`, `nextDueDate`)
- **Behavior**: Preserves original `createdAt` timestamp while advancing `updatedAt`.
- **Response**: `200 OK`

---

## 2. Vehicle Verification & ALPR Endpoints

### A. Plate Lookup & Interlock Check
- **Endpoint**: `GET /api/vehicles/lookup?plate=RJ14CV0002`
- **Description**: Direct lookup in vehicle database and cylinder assets.
- **Response**: `200 OK`
```json
{
  "detected": true,
  "plate": "RJ14CV0002",
  "decision": "DISPENSING_ALLOWED",
  "hydrotestStatus": "VALID",
  "explanation": "Vehicle registered. All 1 linked CNG cylinder(s) have valid hydrotest records.",
  "vehicle": {
    "plateNumber": "RJ14CV0002",
    "vehicleCategory": "CNG_CAR",
    "make": "Kia",
    "model": "Seltos CNG",
    "owner": "Rajesh Sharma",
    "stationId": "STATION-DEMO-001"
  },
  "assets": [
    {
      "assetCode": "CNG-CYL-RJ14-01",
      "serialNumber": "EKC-2021-998214"
    }
  ],
  "hydrotests": [
    {
      "certificateReference": "PESO-CERT-2024-8841",
      "testDate": "2024-03-15",
      "nextDueDate": "2027-03-15",
      "result": "PASS"
    }
  ]
}
```

---

### B. Live Camera Frame Scan
- **Endpoint**: `POST /api/scan/live-frame`
- **Request Body**:
```json
{
  "image": "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
}
```
- **Description**: Fast in-memory YOLOv8 plate detection (<50ms) + EasyOCR + vehicle database verification.
- **Response**: `200 OK` (includes bounding box, confidence, plate, and interlock decision).

---

### C. Manual Media Upload & Scan
- **Endpoint**: `POST /api/scans`
- **Headers**: `multipart/form-data`
- **Body**: File field `files` (videos or photographs, up to 200MB)
- **Response**: `202 Accepted` with queued scan IDs. Poll `GET /api/scans/:id` for progress and results.
