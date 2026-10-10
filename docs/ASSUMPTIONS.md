# Assumptions and Limitations

1. CNG cylinders/tanks/equipment are modeled as CNG assets linked to a vehicle.
2. One vehicle can have multiple active CNG assets; every required active linked asset must have an applicable current passing test for an allowed demo decision.
3. A video/photo identifies the plate candidate; hydrotest result is retrieved from application records.
4. Latest applicable test is selected by `testDate` descending and then `createdAt` descending.
5. `FAIL`, `OVERDUE`, `PENDING`, `NO_RECORD`, conflicting data and low-confidence OCR cannot produce an allowed result.
6. Due-soon results require review under the default demo policy.
7. The date rule currently uses the Node process UTC date. Production rules should use an explicitly approved station timezone/date policy.
8. Example plate values and all seed vehicles/assets/hydrotests are synthetic test fixtures; they were not extracted from video.
9. No actual user video was present in the generation environment. The extraction report explicitly records that no media was available.
10. FastALPR with default configurable ONNX models is the primary proposed ALPR engine. Its Indian-plate performance has not been benchmarked in this artifact.
11. EasyOCR is an optional fallback when installed and available during engine initialization; no fallback is claimed to be equally accurate.
12. Live CCTV requires a configured authorized stream and the installed OpenCV/FFmpeg capabilities.
13. Camera stream URLs are redacted from API list responses but the local demo database stores them as regular fields. Production requires secret protection.
14. Registration validation is approximate format screening only, not official government registry verification.
15. The software provides an advisory decision and no pump/dispenser integration.
16. No production authentication/role management has been implemented.
