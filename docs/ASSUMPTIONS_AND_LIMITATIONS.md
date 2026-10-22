# FuelFlux Assumptions, Limitations & Future Improvements

This document outlines the operational assumptions, technical limitations, and roadmap for future enhancements for the FuelFlux Hydrotesting Management & Inspection System.

---

## 1. Core System Assumptions

### A. Synthetic & Demo Data
- **Zero Production Access**: Per candidate assignment constraints, all vehicle registrations, asset codes, serial numbers, and test certificates are entirely synthetic. No FuelFlux production databases or credentials are accessed.
- **Safety Interlock Fail-Safe**: In the event of system ambiguity (e.g. unreadable plate, unlinked cylinders, or network latency), the fuel dispenser interlock defaults to **FAIL-CLOSED (LOCKED)**. Dispensing cannot be authorized without a positive verified PASS record.

### B. Regulatory & Domain Standards
- **Inspection Interval**: Under standard Indian regulations (PESO / Chief Controller of Explosives & IS 15490 / ISO 11439 standards), vehicular CNG composite/steel cylinders undergo mandatory hydrostatic re-testing every **3 years** (or 5 years for specialized cascade tanks).
- **Due-Soon Window**: Set to **30 days**. Cylinders expiring within 30 days trigger an operator advisory alert (`DUE_SOON`) while permitting current refueling, giving fleet owners time to schedule inspection.
- **Indian HSRP Standards**: High-Security Registration Plates (HSRP) feature an "IND" international country code on the left edge. The computer vision normalization pipeline automatically detects and strips this prefix to avoid corrupting registration string queries.

### C. Storage & Database Architecture
- **Dual-Mode Persistence**: The application supports standard MongoDB instances via `mongodb://127.0.0.1:27017`. If MongoDB is not active or experiences connectivity issues on the host environment, the system automatically engages an embedded zero-config JSON data engine, guaranteeing zero downtime and complete persistence of all operator inputs.

---

## 2. Technical Limitations

1. **Physical Occlusion & Extreme Weather**:
   - Severe mud, physical damage, or extreme camera backlight may prevent optical character recognition from reaching the 80% confidence threshold.
   - *Mitigation*: The UI provides an instantaneous **Manual Plate Lookup** input directly below the live monitor.
2. **Hardware Dispenser Interface**:
   - The current demonstration simulates the dispenser interlock relay via software state flags (`DISPENSING_ALLOWED` vs `FUEL_DISPENSING_LOCKED`).
3. **Single Station Tenancy**:
   - The current demonstration focuses on station-level operations with configurable `stationId`. Multi-tenant organizational partitioning is modeled at the database field level.

---

## 3. Future Improvements & Roadmap

1. **Physical Dispenser Interlock (PLC / Modbus TCP)**:
   - Integrate an industrial Modbus TCP / MQTT driver to control electrical solenoid valves on physical fuel dispensers (e.g. Wayne, Gilbarco, or Tokheim dispensers).
2. **Automated WhatsApp / SMS Notification Engine**:
   - Trigger automated reminder alerts to registered vehicle owners when their cylinder status enters `DUE_SOON` (30 days prior to expiration).
3. **Inspector Mobile Field Companion**:
   - Build a Progressive Web App (PWA) for authorized testing centers to upload hydrostatic pressure-time expansion curve graphs, certificate scans, and digital signatures.
4. **Edge ALPR Deployment**:
   - Export YOLOv8 models to ONNX Runtime with TensorRT / OpenVINO acceleration for deployment on low-cost edge appliances (e.g., NVIDIA Jetson Orin Nano).
