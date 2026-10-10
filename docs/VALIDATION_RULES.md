# Validation Rules and Indian Registration Formats

## Registration-number syntax
The backend normalizes values by trimming whitespace, converting to uppercase and removing separators from the matching key. It preserves the original plate in scan evidence. The current regular-expression implementation supports common state/RTO registration shapes and a BH-series-shaped format; it is **not an exhaustive legal validator** for every legacy, diplomatic, military, temporary, trade, special or state-specific registration.

The regular-series expression is an input-quality guard, not an authoritative registration check. A text string can pass this pattern but still be unregistered, cancelled, incorrectly assigned, duplicated in local demo data or read incorrectly by OCR.

## BH-series note
The Ministry of Road Transport and Highways' 2021 BH-series notification describes a mark with the last two digits of the registration year, `BH`, four numerals, and one or more letters, with `I` and `O` excluded from the letter sequence. See the official [G.S.R. 594(E) notification](https://morth.nic.in/sites/default/files/notifications_document/GSR%20594%28E%29%2026%20.08.2021%20BH%20series%20registration%20mark%20Rules.pdf). The project's simple regex is only format screening and should be improved alongside a verified current rules review before operational use.

## Validations in this project
- Empty plate rejected.
- Normalized plate length screened (7–11 letters/digits).
- Supported conventional/BH-shaped pattern required for automatic matching.
- Duplicate normalized plate rejected by unique index.
- Vehicle category must be in the allowed enum.
- Asset code required and unique; asset must reference an existing vehicle.
- Hydrotest must refer to an active asset; selected vehicle/asset relationship must match.
- Test and due dates require valid `YYYY-MM-DD` calendar dates; due date cannot precede test date.
- Result must be `PASS`, `FAIL` or `PENDING`.
- Provider required; certificate reference uniqueness checked when present and enforced with an index for non-empty values.
- Camera stream URL must parse and use RTSP/RTSPS/HTTP/HTTPS.
- Uploaded file extension is allowlisted, file size is limited by Multer, worker attempts actual image/video decoding, video duration is limited in the worker, and stored filenames are server-generated on manual upload.
- Server-controlled `createdAt` and `updatedAt` timestamps.

## Government verification
There is no live Parivahan/Vahan registration lookup in this demo. Do not claim that a vehicle is government-verified from a successful regular expression. Government rule references are available at [Parivahan](https://parivahan.gov.in/), [MoRTH](https://morth.nic.in/) and [India Code](https://www.indiacode.nic.in/). Review the latest applicable Central Motor Vehicles Rules and amendments with appropriate expertise before production deployment.
