# Requirements Traceability

| Requirement | Source | Implementation location | Verification status |
|---|---|---|---|
| Asset register create/list/update | Candidate task document, Hydrotesting MVP | `/api/assets`, UI CNG Assets, `src/app.js` | Unit/business rules checked; API integration not run |
| Hydrotest records with date/provider/result/notes/report reference | Candidate task document | `/api/hydrotests`, Hydrotest modal, MongoDB `hydrotests` | Validation code present; API integration not run |
| Required fields and due-date validation | Candidate task document | `validateHydrotestBody`, `src/domain.js` | Node unit tests cover dates/status; API integration not run |
| Dashboard counts and due states | Candidate task document | `GET /api/dashboard`, `renderDashboard` | Logic present; requires MongoDB runtime to verify data totals |
| Search/filter records | Candidate task document and user requirements | list endpoints, filter UI | Search handlers present; UX regression testing still needed |
| Manual video/photo scanning | User workflow | Scan UI, `/api/scans`, `cv_worker/scan_media.py` | Syntax/unit tests only; OCR not executed |
| Live CCTV monitoring | User workflow | CCTV UI, `/api/cameras/*`, Python stream worker | Requires authorized stream test |
| Database retrieval by plate | User workflow | `src/services/verification.js` | Logic present; full DB integration not run |
| Indian plate input checks | User requirements | `src/domain.js`, `docs/VALIDATION_RULES.md` | Syntax fixtures tested; not official exhaustive validation |
| Demo seed | User request | `src/seed.js`, `scripts/seed-demo.js` | Code created; seed not run without MongoDB |
| Documentation | User request / assessment | `README.md`, `docs/*.md` | Files present |
| Supplied original video plate results | User request | `docs/VIDEO_EXTRACTION_REPORT.md` | Not verifiable: no media files available |

The original candidate task states demo/synthetic data is required for the assignment and forbids production-system/customer-data access. Seed data is therefore marked synthetic and not claimed as actual inspection evidence.
