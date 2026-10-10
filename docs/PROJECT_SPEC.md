# Project Specification

## Goal
Identify vehicle registration plate candidates from an authorized user-uploaded image/video or CCTV stream, retrieve vehicle-linked CNG asset/hydrotest records, and produce an auditable advisory decision.

## Users
- Station operator: upload media, review candidates and acknowledge outcomes.
- Data/inspection clerk: create and update vehicles, assets and test records.
- Supervisor: review ambiguous cases and inspect history.

## Scope
- Manual photo/video upload and asynchronous scanning.
- Batch scan of `data/supplied-media/`.
- Vehicle, CNG asset and hydrotest CRUD.
- Dashboard metrics, scan history, review queue and reports/export.
- CCTV stream configuration, connection test and monitoring worker.
- MongoDB seed data with explicit `DEMO` provenance.

## Out of scope
- Direct connection to a fuel dispenser, valve, PLC or pump controller.
- Government registration lookup or certification authenticity verification.
- Full identity/role-management platform.
- Production-certified safety interlocking.

## Acceptance criteria
- Plate extraction returns candidates, confidence, frame indexes and timestamps.
- Uncertain OCR does not produce an automatic positive match.
- All application reads/writes pass through Express; the browser does not connect directly to MongoDB.
- Each vehicle may link to multiple CNG assets; each asset can have historical hydrotest records.
- Current decisions are computed server-side using one rule service.
- Demo records are visibly labelled and idempotently seeded.
- Source media inventory and extraction reporting are generated without fabricated OCR data.
