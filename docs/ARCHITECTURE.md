# Architecture

```text
Vanilla HTML/CSS/JavaScript
   │ same-origin HTTP, JSON, multipart upload
   ▼
Node.js / Express
   ├── REST routes and request validation
   ├── MongoDB driver + indexes
   ├── vehicle/asset/test/scan repositories
   ├── status and verification services
   ├── audit log
   └── worker orchestration
          │ stdin config / stdout JSON or JSONL
          ▼
Python 3 worker
   ├── OpenCV media decoding and frame sampling
   ├── FastALPR ONNX primary detector/OCR
   └── optional EasyOCR fallback during initialization

MongoDB collections:
vehicles, cngAssets, hydrotests, mediaFiles, scans,
verifications, cameras, auditLogs
```

## Boundaries
- The browser sends inputs to Express and displays results. It has no MongoDB credentials.
- Express owns data validation, status calculation and verification decisions.
- Python returns recognition evidence only. It does not query or decide hydrotest compliance.
- A scan record is persisted before processing begins. Processing updates it through queued/processing/final states.
- CCTV monitoring uses a long-lived Python child process. Stream configuration is sent over stdin rather than command-line arguments.
- File paths are generated/stored server-side; uploaded original filenames are metadata only.

## Failures
Database outage, worker timeout, decoding failure, low confidence, contradictory candidates, unknown vehicle, missing test, or a failing/overdue/pending test must never be silently converted into an allowed result.

## Model note
FastALPR supports replaceable detector and OCR models with ONNX runtime options. Current defaults are a generic plate-recognition configuration, not a model validated on the project's Indian CNG-station footage. Evaluate on a representative labelled dataset and review all software and weight licenses before commercial deployment.
