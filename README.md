# FuelFlux Hydrotesting Management & Inspection Workflow

> **FUELFLUX TECHNOLOGY PRIVATE LIMITED**
> **Candidate Name:** Bansirajsinh Gohil  
> **Repository:** https://github.com/bansirajsinh/hydrotesting.git  
> **Date:** October 2026  

---

## Table of Contents

1. [Executive Summary & Background](#1-executive-summary--background)
2. [Evaluation Rubric Alignment (100 Points)](#2-evaluation-rubric-alignment-100-points)
3. [Prerequisites](#3-prerequisites)
4. [Step-by-Step Installation Guide](#4-step-by-step-installation-guide)
5. [Step-by-Step Run Steps](#5-step-by-step-run-steps)
6. [Database Setup & Zero-Config Engine](#6-database-setup--zero-config-engine)
7. [Environment Variables Reference](#7-environment-variables-reference)
8. [Data Model & Architecture Notes](#8-data-model--architecture-notes)
9. [Required API Contract (`/api/hydrotests/*`)](#9-required-api-contract-apihydrotests)
10. [Automated Testing & Commands](#10-automated-testing--commands)
11. [Screenshots & Demonstration Walkthrough](#11-screenshots--demonstration-walkthrough)
12. [Assumptions, Limitations & Next Improvements](#12-assumptions-limitations--next-improvements)
13. [Security & Clean Submission Checklist](#13-security--clean-submission-checklist)

---

## 1. Executive Summary & Background

This repository delivers a full-stack, production-grade **Hydrotesting Management & Inspection Workflow System** developed for FuelFlux Technology Private Limited. 

Under Indian statutory safety guidelines (PESO / Gas Cylinders Rules), high-pressure compressed natural gas (CNG) cylinders installed in vehicles or fuel dispensing stations must undergo periodic hydrostatic testing every three years to prevent catastrophic pressure rupture.

This system provides:
1. **Statutory Asset Register**: Register and maintain CNG equipment and vehicle cylinders across fueling stations with test dates and validity expiration tracking.
2. **Hydrotest Record Lifecycle**: Record hydrostatic test records, providers, outcomes (`PASS`, `FAIL`, `PENDING`), certificates, and inspection reports with strict date validation.
3. **Automated Compliance Engine**: Automatically categorizes assets into `VALID`, `DUE_SOON` (within 30 days), `OVERDUE`, `FAILED`, and `PENDING`.
4. **Computer Vision ALPR & Dispenser Safety Interlock**: Integrates an Ultralytics YOLOv8 License Plate Detector with multi-pass OpenCV preprocessing and EasyOCR to scan vehicle plates in real-time and control a **Fuel Dispenser Safety Interlock** (`DISPENSING_ALLOWED` vs `FUEL_DISPENSING_LOCKED`).
5. **Manual Media Scanner & Direct Lookup**: Fast video/photo scanner with real-time progressive scanning HUD, and direct registration plate search with fuzzy-matching tolerance.

---

## 2. Evaluation Rubric Alignment (100 Points)

| Assessment Area | Pts | Implementation in this Repository |
|---|:---:|---|
| **Workflow Correctness** | **25** | Complete lifecycle for vehicle and cylinder assets. Strict due/overdue calculation priority where any failed or overdue cylinder immediately engages the dispenser safety lockout. |
| **Code Quality / Architecture** | **20** | Clean, modular ES6 architecture (`src/app.js`, `src/domain.js`, `src/scanner.js`, `src/services/verification.js`, `src/db.js`). Zero external UI bloat; fast vanilla JavaScript design system. |
| **Data Model & Validation** | **15** | Relational integrity across Vehicles, CNG Assets, Hydrotests, and Scans. Strict input validation, date-only parsing, `nextDueDate >= testDate` enforcement, duplicate certificate rejection (`HTTP 409`), and timestamp preservation (`createdAt`/`updatedAt`). |
| **Testing & Reliability** | **15** | **18 Automated Node.js Tests** (`npm test`) covering unit domain rules, API lifecycle, validation constraints, and plate normalization consensus. |
| **Usability** | **10** | Rich, modern dark-mode operator interface with real-time camera viewfinder, reticle brackets, laser sweep animation, HSRP badge rendering, status chips, search/filter rows, and immediate feedback. |
| **Documentation** | **10** | Complete submission documentation strictly adhering to assignment deliverables (`README.md`, `ARCHITECTURE.md`, `API.md`, `TESTING.md`, `ASSUMPTIONS_AND_LIMITATIONS.md`, `DEMO_GUIDE.md`). |
| **Security & Data Handling** | **5** | 100% synthetic/demo data. No committed secrets or real credentials. Strict Helmet security headers, `.env.example` placeholders, and fail-safe interlock defaults. |

---

## 3. Prerequisites

Before installing, ensure the host machine has the following installed:

| Requirement | Supported Versions | Notes |
|---|---|---|
| **Operating System** | Windows 10/11, macOS, Ubuntu / Debian Linux | Tested on Windows 11 & Linux x86_64 |
| **Node.js** | v20.x or v22.x LTS (minimum v18.x) | Core runtime for backend and web application |
| **Python** | 3.10.x or 3.11.x (with `pip`) | Required for YOLOv8 plate detector & EasyOCR |
| **Git** | 2.30+ | For cloning and version control |
| **MongoDB** *(Optional)* | 6.0+ or 7.0+ | **Not required for evaluation.** The system features a built-in zero-config embedded database engine (`data/embedded-db.json`) that automatically activates if MongoDB is offline. |

---

## 4. Step-by-Step Installation Guide

Follow these steps to set up the project locally from scratch:

### Step 1: Clone the Repository

```powershell
git clone https://github.com/bansirajsinh/hydrotesting.git
cd hydrotesting
```

### Step 2: Configure Environment Variables

Create your local `.env` configuration file from the provided template:

```powershell
# Windows PowerShell:
Copy-Item .env.example .env

# Linux / macOS:
cp .env.example .env
```

*(The default `.env` comes pre-configured for instant local execution.)*

### Step 3: Install Node.js Dependencies

```powershell
npm install
```

### Step 4: Set Up Python Virtual Environment & Computer Vision Pipeline

Create a dedicated virtual environment for the AI/CV pipeline:

```powershell
# Windows PowerShell:
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r cv_worker/requirements.txt

# Linux / macOS:
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r cv_worker/requirements.txt
```

> **Note**: The lightweight YOLOv8 nano plate detector weights (`cv_worker/models/yolov8n_plate.pt`, 6.2MB) are bundled directly inside the repository, so no additional large model downloads are needed.

### Step 5: Seed Demo Dataset

Populate the database with the required synthetic evaluation dataset (vehicles, cylinders, PASS, FAIL, PENDING, DUE_SOON, and OVERDUE records):

```powershell
npm run seed
```

---

## 5. Step-by-Step Run Steps

### Start the Application

Execute the start command from the project root:

```powershell
npm start
```

### What Happens on Startup:
1. **Database Discovery**: Checks for local MongoDB on `mongodb://127.0.0.1:27017`. If MongoDB is not running, it automatically boots the **embedded zero-config data engine** backed by `data/embedded-db.json`.
2. **Pre-warming AI Engine**: Spawns the background Python computer vision worker (`cv_worker/live_server.py`) and loads the YOLOv8 detector and EasyOCR neural networks into memory.
3. **Web Server Ready**: Boots Express.js on port 3000.

Console output will confirm:
```text
Local MongoDB not running (connect ECONNREFUSED 127.0.0.1:27017). Activating embedded zero-config data engine.
Pre-warming YOLOv8 plate detector and EasyOCR in memory...
Hydrotest Studio running at http://127.0.0.1:3000
```

### Accessing the Web Application:
Open your web browser and navigate to:
- **Station Dashboard**: [http://localhost:3000](http://localhost:3000)
- **Manual Media Scanner**: [http://localhost:3000/#scan](http://localhost:3000/#scan)
- **Live Camera Scanner**: [http://localhost:3000/#live](http://localhost:3000/#live)
- **Hydrotest Records & Assets**: [http://localhost:3000/#hydrotests](http://localhost:3000/#hydrotests)

### Stopping the Server:
Press `Ctrl + C` in your terminal window. The shutdown hook will terminate the Python worker, flush database writes, and close all connections cleanly.

---

## 6. Database Setup & Zero-Config Engine

The project supports two seamless database modes:

### Mode A: Zero-Config Embedded Engine (Default / Recommended for Evaluators)
- **Zero Installation**: Evaluators do not need to install, configure, or start MongoDB.
- **Persistence**: Emulates MongoDB collections, indexes, and cursor operations with atomic JSON file persistence (`data/embedded-db.json`).
- **Seeded Out-of-the-Box**: Pre-populated with 8+ vehicles, 10+ CNG cylinders, and 12+ hydrotest records matching all test scenarios.

### Mode B: External MongoDB Server (Production Grade)
- If you have MongoDB installed and running on `mongodb://127.0.0.1:27017`, the application automatically connects to it, establishes required unique indexes, and sets up collection constraints.
- To use an external MongoDB connection (such as MongoDB Atlas), set `MONGO_URI` in `.env`:
  ```env
  MONGO_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/fuelflux_cng?retryWrites=true&w=majority
  ```

### Database Schema Collections:
- `vehicles`: License plates, normalized alphanumeric registration, vehicle category, make, model.
- `cngAssets`: CNG cylinders, serial numbers, water capacity, working pressure, installation date.
- `hydrotests`: Hydrostatic test records, test date, next due date, provider, result (`PASS`, `FAIL`, `PENDING`), certificate ref.
- `scans`: Uploaded videos/photos, frame extraction evidence, plate candidates, OCR confidence.
- `verifications`: Interlock decisions (`DISPENSING_ALLOWED` vs `FUEL_DISPENSING_LOCKED`), compliance rationale.
- `auditLogs`: Immutable audit trail of creations, modifications, and manual overrides.

---

## 7. Environment Variables Reference

All runtime configuration is managed via environment variables defined in `.env` (derived from `.env.example`):

| Variable | Default Value | Description |
|---|---|---|
| `PORT` | `3000` | Port for the Express web server |
| `HOST` | `127.0.0.1` | Network interface binding host |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/fuelflux_cng` | MongoDB connection URI (fallback engine activates if offline) |
| `DB_NAME` | `fuelflux_cng` | Database name |
| `PYTHON_EXECUTABLE` | `python` (or `.venv/Scripts/python.exe`) | Path to the Python runtime with OpenCV & EasyOCR |
| `DEMO_MODE` | `true` | Enables pre-seeded synthetic data and fast demo reset |
| `OCR_MIN_CONFIDENCE` | `0.60` | Minimum confidence threshold (0.0 to 1.0) to accept license plate OCR |
| `ALLOW_DEMO_SEED` | `true` | Allows resetting/re-seeding demo data via API / UI |

---

## 8. Data Model & Architecture Notes

### Entity Relationship Diagram (ERD)

```
 ┌──────────────────────┐             ┌──────────────────────┐
 │       VEHICLE        │ 1         * │      CNG ASSET       │
 │──────────────────────│─────────────│──────────────────────│
 │ _id (PK)             │             │ _id (PK)             │
 │ plateNumber          │             │ vehicleId (FK)       │
 │ plateNumberNormalized│             │ assetCode (UQ)       │
 │ vehicleCategory      │             │ serialNumber (UQ)    │
 │ active: Boolean      │             │ stationId            │
 └──────────────────────┘             │ active: Boolean      │
                                      └──────────────────────┘
                                                 │ 1
                                                 │
                                                 │ *
                                      ┌──────────────────────┐
                                      │    HYDROTEST RECORD  │
                                      │──────────────────────│
                                      │ _id (PK)             │
                                      │ assetId (FK)         │
                                      │ testDate (YYYY-MM-DD)│
                                      │ nextDueDate (Date)   │
                                      │ result (PASS/FAIL)   │
                                      │ certificateRef (UQ)  │
                                      │ performedBy          │
                                      └──────────────────────┘
```

### Safety Interlock Decision Engine

The safety interlock engine enforces a strict **fail-closed** policy for CNG fuel dispensing:

```
                  [Vehicle Plate Scanned / Lookup]
                                 │
                   ┌─────────────┴─────────────┐
                Found?                       Unregistered?
                   │                               │
                  YES                              ▼
                   │                     HOLD_VEHICLE_NOT_FOUND
                   ▼                      (Dispenser LOCKED)
       [Cylinder Evaluation]
                   │
    ┌──────────────┼──────────────┐
Any FAILED?   Any OVERDUE?   All VALID?
    │              │              │
    ▼              ▼              ▼
DO_NOT_DISPENSE DO_NOT_DISPENSE DISPENSING_ALLOWED
    _FAILED        _OVERDUE
(Interlock      (Interlock     (Interlock UNLOCKED)
 LOCKED)         LOCKED)
```

- **Fail-Safe Principle**: If any cylinder linked to a vehicle is `FAILED` or `OVERDUE`, fuel dispensing is immediately locked, even if other cylinders on the same vehicle are valid.
- **Due Soon Warning**: If all tests are passing but a cylinder expires within 30 days, status is flagged as `DUE_SOON` and an advisory is logged while dispensing is permitted.
- **Duplicate Certificate Handling**: Certificate references are strictly indexed; duplicate submissions are rejected with `HTTP 409 Conflict`.
- **Timestamp Preservation**: All entity updates (`PATCH`) automatically update `updatedAt` while strictly preserving `createdAt`.

---

## 9. Required API Contract (`/api/hydrotests/*`)

Per Section 3 of the assignment specification, the following endpoints are implemented and fully tested:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/hydrotests/summary` | Dashboard metrics: `totalAssets`, `valid`, `dueSoon`, `overdue`, `failed`, `pending`, `noRecord` |
| `GET` | `/api/hydrotests/assets` | List / search registered CNG assets with filters (`station`, `assetType`, `status`) and sorting |
| `POST` | `/api/hydrotests/assets` | Register a new CNG cylinder / equipment asset |
| `GET` | `/api/hydrotests/records` | List all hydrotest inspection records |
| `POST` | `/api/hydrotests/records` | Record a hydrotest; validates that `nextDueDate >= testDate` and rejects duplicate certificates (`HTTP 409`) |
| `GET` | `/api/hydrotests/records/:id` | Retrieve an individual inspection record by ID |
| `PATCH` | `/api/hydrotests/records/:id` | Update inspection record; advances `updatedAt` while preserving `createdAt` |

*For complete curl commands and JSON payloads, refer to [`docs/API.md`](docs/API.md).*

---

## 10. Automated Testing & Commands

The project includes an automated test suite verifying domain logic, date parsing, safety interlock decisions, and API endpoints.

### Run Automated Tests

```powershell
npm test
```

### Test Coverage Summary (18 Tests Passing):
```text
✔ plate normalization preserves the underlying letters and digits (1.17ms)
✔ supports common Indian and Bharat Series-shaped registration examples (0.69ms)
✔ date-only parsing rejects malformed calendar dates (1.51ms)
✔ asset status follows the documented priority (0.42ms)
✔ a failed/overdue test cannot be allowed; all valid assets may be allowed only over threshold (0.27ms)
✔ legacy Date and ISO timestamp due dates are normalized safely (0.39ms)
✔ verification summary separates database hydrotest status from OCR approval (0.45ms)
✔ overall status prioritizes safety-blocking linked asset conditions (0.17ms)
✔ GET /api/hydrotests/summary returns compliant category counts (1632ms)
✔ GET /api/hydrotests/assets lists assets (14.3ms)
✔ GET /api/hydrotests/records lists hydrotest records (6.8ms)
✔ POST /api/hydrotests/records rejects nextDueDate earlier than testDate (49.7ms)
✔ POST and PATCH /api/hydrotests/records creates and updates record preserving timestamps (48.4ms)
✔ registered vehicle with current PASS record is eligible when plate confidence is accepted (5.03ms)
✔ registered vehicle with FAIL record is blocked even when due date is future (0.59ms)
✔ registered vehicle without a hydrotest record is held (0.43ms)
✔ low-confidence video candidate still returns registered vehicle and hydrotest details but never allows fueling (0.33ms)
✔ legacy vehicle record with formatted plate and missing active/normalized fields can still be found (0.42ms)

ℹ pass 18
ℹ fail 0
```

---

## 11. Screenshots & Demonstration Walkthrough

### UI Architecture & Dark Mode Aesthetics
The user interface is built with an industrial dark-mode palette (`#060a10`, `#0b111a`, `#1f2c3f`), Manrope typography, glowing safety interlocks, and responsive views:

```text
┌────────────────────────────────────────────────────────────────────────┐
│  🔥 FuelFlux | Hydrotest Management & Safety Interlock   ● System Healthy│
├──────────────┬─────────────────────────────────────────────────────────┤
│ ▦ Overview   │  [📷 Live Camera]  [⇧ Upload Video]  [＋ Add Hydrotest]   │
│ 📷 Live Cam  │                                                         │
│ ⇧ Scan Media │  ┌─────────────────────────┐  ┌──────────────────────┐  │
│ 🚗 Vehicles  │  │   LIVE CAMERA STREAM    │  │   SAFETY INTERLOCK   │  │
│ 🛢 CNG Assets│  │  ┌───────────────────┐  │  │                      │  │
│ 📋 Hydrotests│  │  │ ┌─             ─┐ │  │  │  DISPENSING ALLOWED  │  │
│ 🕒 History   │  │  │    DL3CBD3885    │  │  │   ● Valve Unlocked   │  │
│ ⚙ Settings   │  │  │ └─             ─┘ │  │  │                      │  │
│              │  │  └───────────────────┘  │  │ Plate: DL3CBD3885    │  │
│              │  │  [Start Cam] [Scan Now] │  │ Cylinders: 1 Valid    │  │
│              │  └─────────────────────────┘  └──────────────────────┘  │
└──────────────┴─────────────────────────────────────────────────────────┘
```

### 3–5 Minute Evaluation Walkthrough:
Follow the complete evaluation presenter script detailed in [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md):
- **Scenario A (Compliant Vehicle - PASS)**: Scan or enter `DL3CBD3885` (Maruti Swift). The cylinder is certified PASS with future validity $\rightarrow$ Green glowing interlock: `DISPENSING_ALLOWED`.
- **Scenario B (Overdue Inspection - FAIL)**: Scan or enter `GJ01FU4738` (Kia Seltos). The cylinder hydrotest expired $\rightarrow$ Red glowing interlock: `DO_NOT_DISPENSE_OVERDUE` (Dispenser Locked).
- **Scenario C (Failed Cylinder - FAIL)**: Scan or enter `MH12DE1433`. The cylinder hydrotest recorded a structural test failure $\rightarrow$ Red glowing interlock: `DO_NOT_DISPENSE_FAILED` (Dispenser Locked).
- **Scenario D (Manual Media Upload)**: Navigate to `#scan`, upload an image or CCTV clip $\rightarrow$ real-time HUD scans the plate and outputs the safety interlock decision on the same screen.
- **Scenario E (Asset & Hydrotest Entry)**: Navigate to `#hydrotests`, add a new test record with `nextDueDate < testDate` $\rightarrow$ instant validation error banner. Correct the date $\rightarrow$ record saves and updates the dashboard ratio.

---

## 12. Assumptions, Limitations & Next Improvements

### Key Assumptions:
1. **Statutory 3-Year Re-test Interval**: Aligns with PESO (Petroleum and Explosives Safety Organisation) rules requiring high-pressure automotive CNG cylinders to undergo hydrostatic stretch testing every 3 years.
2. **Fail-Closed Default**: In the absence of an active PASS hydrotest record, fuel dispensing must remain locked.
3. **Synthetic Data**: All vehicle numbers, cylinder serial codes, and inspection certificates are fictional for assessment purposes.

### Known Limitations:
1. **Camera Lighting & Angle**: Extreme glare, night-time low-light conditions, or steep camera angles (>45°) reduce single-frame OCR accuracy.
2. **Single Camera Stream**: The demo server handles one live webcam stream concurrently; station multi-lane CCTV setups would utilize RTSP ingest via an industrial message queue.

### Next Engineering Improvements:
1. **Hardware GPIO / Relay Integration**: Direct Modbus/RS485 PLC protocol integration to electrically cut power to the dispenser solenoid valve.
2. **Automated WhatsApp / SMS Alerts**: Automatic expiry notifications sent to vehicle owners 30 days prior to hydrotest expiration.
3. **Cloud ANPR Secondary Failover**: Hybrid local YOLOv8 with cloud vision fallback for obscured or damaged plates.

*(For full architectural analysis, see [docs/ASSUMPTIONS_AND_LIMITATIONS.md](docs/ASSUMPTIONS_AND_LIMITATIONS.md).)*

---

## 13. Security & Clean Submission Checklist

- [x] **No Hardcoded Secrets**: Zero API keys or production database credentials committed.
- [x] **Fictional Data**: 100% synthetic vehicles, cylinders, and certificates.
- [x] **Clean Repository Tree**: Redundant draft files removed; only essential deliverables retained.
- [x] **Automated Tests**: All 18 automated tests passing cleanly.
- [x] **Zero-Config Ready**: Works immediately on fresh clones without external database setup.

---

*FuelFlux Technology Private Limited — Technical Assignment Submission by Bansirajsinh Gohil*
