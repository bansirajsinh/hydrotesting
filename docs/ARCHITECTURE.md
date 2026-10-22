# FuelFlux Architecture & Data Model Documentation

This document describes the architectural design, entity relationships, computer vision pipeline, and safety interlock decision logic for the **FuelFlux Hydrotesting Management & Inspection System**.

---

## 1. System Overview

```
                          ┌──────────────────────────────────────────────┐
                          │         Station Operator Web Interface       │
                          │   (HTML5, Vanilla CSS Design System, JS)     │
                          └──────┬────────────────────────────────┬──────┘
                                 │                                │
                     Live Camera │ Base64               REST HTTP │ JSON API
                     Frame Post  │                             │
                                 ▼                                ▼
┌──────────────────────────────────────────────┐   ┌───────────────────────────────────────────┐
│     In-Memory Python Computer Vision Worker  │   │       Express.js Core Application         │
│   - Flask daemon on port 5050                │   │   - Hydrotesting & Asset API Contract     │
│   - YOLOv8 License Plate Detector            │   │   - Dispenser Safety Interlock Engine     │
│   - OpenCV Multi-Pass Adaptive Preprocessing │   │   - Audit Trail & State Validation        │
│   - EasyOCR calibrated for Indian Plates     │   └─────────────────────┬─────────────────────┘
└──────────────────────────────────────────────┘                         │
                                                                         ▼
                                                   ┌───────────────────────────────────────────┐
                                                   │   Dual-Engine High Availability Storage   │
                                                   │   - Primary: MongoDB Community Server     │
                                                   │   - Fallback: Zero-Config Embedded Engine │
                                                   │     (Atomic disk persistence, zero downtime│
                                                   └───────────────────────────────────────────┘
```

---

## 2. Entity Relational Model

The database schema connects four core collections to ensure complete traceability:

```
┌─────────────────────────┐          1:N          ┌─────────────────────────┐
│      vehicles           │ ───────────────────── │       cngAssets         │
├─────────────────────────┤                       ├─────────────────────────┤
│ _id (ObjectId / UUID)   │                       │ _id (ObjectId / UUID)   │
│ plateNumber (indexed)   │                       │ assetCode (indexed)     │
│ vehicleCategory         │                       │ vehicleId (FK)          │
│ make / model            │                       │ assetType               │
│ stationId               │                       │ serialNumber            │
│ active (boolean)        │                       │ installationDate        │
│ createdAt / updatedAt   │                       │ stationId               │
└─────────────────────────┘                       │ active (boolean)        │
                                                  │ createdAt / updatedAt   │
                                                  └───────────┬─────────────┘
                                                              │ 1:N
                                                              ▼
┌─────────────────────────┐          1:N          ┌─────────────────────────┐
│         scans           │ ───────────────────── │       hydrotests        │
├─────────────────────────┤                       ├─────────────────────────┤
│ _id                     │                       │ _id (ObjectId / UUID)   │
│ originalFilename        │                       │ assetId (FK)            │
│ selectedPlate           │                       │ vehicleId (FK denorm)   │
│ confidence              │                       │ testDate                │
│ verificationDecision    │                       │ nextDueDate             │
│ status                  │                       │ performedBy (Provider)  │
│ candidates []           │                       │ result (PASS/FAIL/PEND) │
│ createdAt / updatedAt   │                       │ certificateReference    │
└─────────────────────────┘                       │ notes                   │
                                                  │ createdAt / updatedAt   │
                                                  └─────────────────────────┘
```

### Entity Schema Details

#### A. Vehicles (`vehicles`)
- `_id`: Unique identifier
- `plateNumber`: Normalized registration string (e.g. `RJ14CV0002`). Indexed, uppercase, whitespace stripped.
- `vehicleCategory`: Enum (`CNG_CAR`, `CNG_VAN`, `CNG_BUS`, `CNG_COMMERCIAL`, `OTHER_CNG`)
- `stationId`: Dispensing facility identifier
- `make` / `model`: Vehicle make and model (e.g. Kia Seltos, Maruti Wagon R)
- `owner`: Registered fleet owner
- `active`: Boolean flag
- `createdAt` / `updatedAt`: ISO timestamps

#### B. CNG Assets (`cngAssets`)
- `_id`: Unique identifier
- `assetCode`: Unique identifier per station (e.g. `CNG-CYL-RJ14-01`)
- `vehicleId`: Foreign key reference to parent vehicle
- `assetType`: Equipment classification (`CNG_CYLINDER`, `CNG_TANK`, `CNG_EQUIPMENT`)
- `serialNumber`: Manufacturer serial stamp
- `stationId`: Station location
- `active`: Boolean flag

#### C. Hydrotests (`hydrotests`)
- `_id`: Unique identifier
- `assetId`: Foreign key reference to the inspected cylinder asset
- `vehicleId`: Foreign key reference to vehicle
- `testDate`: Date test was performed (`YYYY-MM-DD`)
- `nextDueDate`: Hydrostatic test validity expiration date (`YYYY-MM-DD`)
- `performedBy`: Certified test center / provider name
- `result`: Test outcome enum (`PASS`, `FAIL`, `PENDING`)
- `certificateReference`: Unique statutory certificate number (e.g. `PESO-CERT-2024-8841`)
- `notes`: Safe text notes and observations

---

## 3. Duplicate Identifier Handling Rule

Per the assignment specification:
1. **Vehicles**: Registration plates are unique per station. If an operator attempts to register a plate that already exists, the server returns **HTTP 409 Conflict** with message: `Vehicle registration already exists.`
2. **CNG Assets**: `assetCode` must be unique. Duplicate attempts return **HTTP 409 Conflict**.
3. **Hydrotest Records**: `certificateReference` must be unique across all test providers. Submitting an existing certificate returns **HTTP 409 Conflict** (`DUPLICATE_CERTIFICATE`), preventing duplicate audit entries while preserving created/updated timestamps.

---

## 4. Dispenser Safety Interlock Decision Engine

Fuel dispensing decisions are strictly calculated by evaluating the vehicle's linked cylinders against the inspection rules:

```
                             [Vehicle Scanned / Queried]
                                          │
                                ┌─────────┴─────────┐
                             Found?               Not Found?
                                │                   │
                               YES                  ▼
                                │         HOLD_VEHICLE_NOT_FOUND
                                │         (Dispensing LOCKED)
                                ▼
                       [Check Linked Cylinders]
                                │
               ┌────────────────┼────────────────┐
         Any FAILED?      Any OVERDUE?     All VALID?
               │                │                │
               ▼                ▼                ▼
     DO_NOT_DISPENSE_   DO_NOT_DISPENSE_   DISPENSING_ALLOWED
          FAILED            OVERDUE
    (Interlock LOCKED) (Interlock LOCKED) (Interlock UNLOCKED)
```

### Safety Rules Priority:
1. **`DO_NOT_DISPENSE_FAILED`**: Engaged if ANY linked cylinder has `result === 'FAIL'`. Safety hazard.
2. **`DO_NOT_DISPENSE_OVERDUE`**: Engaged if ANY cylinder test has expired (`nextDueDate < today`).
3. **`HOLD_PENDING_TEST`**: Engaged if any test is pending laboratory review.
4. **`DO_NOT_DISPENSE_NO_RECORD`**: Engaged if a registered vehicle has no hydrotest records on file.
5. **`REVIEW_REQUIRED`**: Triggered if a cylinder test is due within 30 days (`DUE_SOON`). Operator alert issued.
6. **`DISPENSING_ALLOWED`**: Unlocked ONLY when ALL linked cylinders have an active `PASS` record and `nextDueDate >= today`.

---

## 5. Computer Vision & OCR Architecture

1. **Detection (YOLOv8)**:
   - Ultralytics YOLOv8 nano model (`cv_worker/models/yolov8n_plate.pt`, 6.2MB) detects license plate bounding boxes in camera frames and video uploads.
2. **Preprocessing (OpenCV Multi-Pass)**:
   - Bilateral filtering removes noise while preserving plate character edges.
   - Contrast Limited Adaptive Histogram Equalization (CLAHE) corrects shadows and bright sunlight reflections.
   - Otsu adaptive binarization isolates dark lettering on white/yellow reflective backgrounds.
3. **Recognition (EasyOCR & Tesseract)**:
   - Evaluates characters using Indian license plate syntax rules (State codes: `DL`, `GJ`, `HR`, `MH`, `RJ`, etc.; RTO numbers, vehicle series, sequence digits, and Bharat Series `BH`).
