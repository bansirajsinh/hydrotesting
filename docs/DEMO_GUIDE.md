# FuelFlux 3–5 Minute Evaluation Demo Walkthrough

This guide provides an evaluator or reviewer with a structured, 3–5 minute demonstration script showcasing the core capabilities of the FuelFlux Hydrotesting Management & Inspection System.

---

## 🎬 Demo Scenario Script (Total Time: ~4 Minutes)

### Phase 1: Station Overview & Compliance Dashboard (0:00 – 0:45)
1. **Navigate to Dashboard** (`http://localhost:3000/#dashboard`).
2. **Key Highlights to Show**:
   - **Compliance Metrics**: 8 core KPI cards displaying *Total Vehicles*, *Valid Hydrotests*, *Due Within 30 Days*, *Overdue Assets*, *Failed Tests*, and *Pending Tests*.
   - **Real-Time Compliance Ratio**: Circular/linear compliance ratio showing percentage of station fleet compliant with hydrostatic safety standards.
   - **Recent Scan Events**: Immediate chronological log of vehicle entry and scan events.

---

### Phase 2: Live Camera Scan & Dispenser Safety Interlock (0:45 – 2:00)
1. **Switch to Live Camera** (`#live` via top navigation or Dashboard button).
2. **Start Camera**:
   - Click **`📷 Start Webcam`** to connect the workstation camera.
   - Point the camera at a printed or displayed license plate, or click **`Upload Photo`** to submit a frame manually.
   - Note the real-time animated reticle (`[ PLACE NUMBER PLATE HERE ]`), scan laser beam, and dynamic neon green bounding box with confidence percentage.
3. **Show Authorized Refueling (`DISPENSING_ALLOWED`)**:
   - Test plate: `RJ14CV0002` (Kia Seltos).
   - **Result**: Neon green interlock banner appears: **`✓ DISPENSING ALLOWED — Dispenser safety interlock unlocked. All CNG cylinders compliant.`**
   - Note the authentic Indian HSRP badge `[IND] RJ14CV0002`, vehicle technical specifications, and linked cylinder table displaying active test validity.
4. **Show Safety Interlock Lockout (`FUEL DISPENSING LOCKED`)**:
   - Test plate: `DL3CBD3885` (Maruti Wagon R - Overdue) or `HR26CE7674` (Hyundai i20 - Failed).
   - **Result**: Bright red lockout banner engages: **`🔒 FUEL DISPENSING LOCKED — Safety interlock engaged. Vehicle cylinder hydrotest is OVERDUE.`**
   - Point out that dispensing is strictly blocked until a new test is logged.

---

### Phase 3: Manual Plate Lookup & Fast Verification (2:00 – 2:45)
1. **Demonstrate Manual Input Card**:
   - Underneath the camera monitor, enter `GJ06QA2032` (Auto-rickshaw) or `GJ01AB1234` into the **Verify Plate** field.
   - Click **`Verify Plate`**.
   - Show instantaneous database retrieval (<10ms) showing all linked cylinders, expiration dates, and interlock clearance without waiting for camera optical conditions.

---

### Phase 4: Asset Register & Logging a Hydrotest (2:45 – 3:45)
1. **Navigate to Hydrotests** (`#hydrotests`).
   - Filter by status (`PASS`, `FAIL`, `PENDING`).
   - Click **`＋ Add Hydrotest`** to open the inspection form.
2. **Demonstrate Date Validation**:
   - Select a cylinder asset.
   - Set Test Date to `2026-10-15` and Next Due Date to `2025-10-15` (earlier).
   - Click Submit: Notice instant validation alert **`Next due date cannot be earlier than test date.`**
3. **Log a Valid Test**:
   - Set Next Due Date to `2029-10-15`.
   - Enter Certificate Reference: `PESO-DEMO-2026-771`.
   - Result: `PASS`.
   - Click **`Create Hydrotest`**.
   - Show that the cylinder status updates immediately to **`VALID`** across the entire application, updating the Dashboard stats and unblocking live dispensing!

---

### Phase 5: Automated Testing & Architecture Review (3:45 – 4:30)
1. **Open Terminal and execute**:
   ```bash
   npm test
   ```
   - Show **18 Node.js tests** passing in ~2 seconds verifying API contracts, domain validation, and interlock logic.
2. **Execute Python ALPR tests**:
   ```bash
   npm run test:python
   ```
   - Show **8 Python tests** passing verifying normalization, regex matching, and multi-frame consensus.
