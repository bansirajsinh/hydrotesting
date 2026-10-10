# Security Notes

- This is a local development/demo application, not a production-certified station control system.
- Never commit `.env`, camera passwords, database credentials, videos or crops.
- Uploaded files are stored with UUID-based filenames under `storage/uploads`; original names are treated as display metadata.
- The server allowlists file extensions, applies upload byte limits, and the worker attempts to decode media. Production should additionally inspect MIME signatures, sandbox codecs, malware-scan files, enforce duration limits before long processing, and store media outside web-root.
- The Python child process is started with `spawn` and a fixed script path, without `shell: true`; input paths are generated/stored by the server.
- Camera URLs are not included in camera-list responses. Local demo camera URLs are stored in MongoDB and therefore are not suitable for an untrusted shared database.
- All API requests pass server-side validation and unique constraints. Database errors do not become a positive verification decision.
- The scanner returns uncertain candidates for review. Do not use OCR as government identity verification or certificate authenticity proof.
- The application does not control a real dispenser. Real equipment control would require independent safety engineering, fail-safe design, authorised interfaces, cybersecurity review and certification.
- Add authentication, RBAC, CSRF protection where applicable, TLS, rate limits, secure headers, media retention policy, encrypted secrets and a hardened deployment before any shared or production use.
