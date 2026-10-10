# Business Rules

## Source-of-truth boundaries
- Video/photo/CCTV provides a plate candidate and evidence metadata only.
- Vehicle information comes from the vehicle collection or explicit operator entry.
- CNG asset relationships come from the asset collection.
- Hydrotest status comes from the latest applicable hydrotest document for each required active linked asset.
- OCR output does not prove government registration, physical asset identity, certificate authenticity or legal compliance.

## Status calculation
As implemented in `src/domain.js`:
- No latest test → `NO_RECORD`.
- Latest result `FAIL` → `FAILED` regardless of future due date.
- Latest result `PENDING` → `PENDING`.
- `PASS` with next due date before today → `OVERDUE`.
- `PASS` due today through 30 days from today → `DUE_SOON`.
- `PASS` due more than 30 days away → `VALID`.
- Invalid/missing due date → `REVIEW_REQUIRED`.

Latest record ordering is by `testDate` descending then `createdAt` descending. The date-only comparison uses server UTC date in this prototype. Production should make the station timezone and date semantics an explicitly approved configuration.

## Vehicle decision precedence
1. Invalid/unreadable plate or unsupported input → hold.
2. OCR confidence below configured threshold → hold/manual review.
3. No active vehicle match → hold.
4. No required active linked asset → hold.
5. Any required asset without a test → hold.
6. Any failed test → do not dispense.
7. Any overdue test → do not dispense.
8. Any pending test → hold.
9. Any ambiguous or invalid test history → review.
10. Any due-soon test → review/hold under the default demo policy.
11. Only all-current passing tests plus sufficiently confident identity match can produce `DISPENSING_ALLOWED`.

The order is deliberately conservative. The word `DISPENSING_ALLOWED` is an advisory demo decision only; no real dispenser is controlled. The actual applicable regulatory test intervals, accepted certificates, grace periods, and station operating rules must be approved by qualified personnel before deployment.

## Demo provenance
Every seeded entity includes `recordSource: "DEMO"`; UI badges and README must make this visible. Synthetic test records must never be represented as genuine certificates or actual vehicle records.

## Database result shown for uncertain identity
A plausible OCR candidate is looked up in MongoDB even when the candidate does not satisfy the automatic multi-frame selection policy. The UI can then show `REGISTERED` and the retrieved hydrotest status (for example `VALID` or `FAILED`) alongside `HOLD_LOW_OCR_CONFIDENCE` or `REVIEW_REQUIRED`. This is intentionally not approval: `fuelingEligibility` remains `NOT_ELIGIBLE` unless the final decision is `DISPENSING_ALLOWED`. A user can refresh database verification after records are updated without re-running OCR.

Legacy records with formatted/lowercase `plateNumber` values are normalized at startup before indexes are created. A fallback normalization lookup handles legacy records not captured by the migration. Assets with omitted `active` fields are treated as active for compatibility; explicitly deactivated assets are ignored.
