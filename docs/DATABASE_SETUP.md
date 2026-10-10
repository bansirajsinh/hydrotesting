# MongoDB Setup — Beginner Guide

## 1. MongoDB concepts
- **Server:** the MongoDB process accepting connections.
- **Database:** named space containing application data (`fuelflux_cng_demo`).
- **Collection:** group of similar documents, such as `vehicles` or `hydrotests`.
- **Document:** one JSON-like record.
- **ObjectId:** unique identifier generated for a record.
- **Index:** speeds query lookup and may enforce uniqueness.
- **CRUD:** Create, Read, Update and Delete/deactivate operations.

## 2. Start a local database
Install Docker Desktop, then from the repository root run:

```bash
docker compose up -d mongodb
docker ps
```

The Compose service binds MongoDB to `127.0.0.1:27017` for local development only. It creates a persistent named volume. For a native MongoDB installation, ensure the service is running and reachable on the same URI.

## 3. Environment configuration
Copy `.env.example` to `.env` and use:

```env
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB_NAME=fuelflux_cng_demo
```

`MONGODB_URI` tells the official Node.js driver where to connect. `MONGODB_DB_NAME` selects the application database. The project loads `.env` with `dotenv`. Never commit `.env` or place live credentials in frontend code.

## 4. Connect flow
`src/db.js` creates one reusable `MongoClient`, calls `connect()`, sends `ping`, selects the configured database and creates indexes. `src/server.js` waits for this before opening the HTTP port. On shutdown, the client is closed.

```text
Browser -> Express API -> getDb() -> MongoDB collection
                 <- JSON response <--- document/query result
```

The frontend must not connect directly to MongoDB because browser code is visible to users and must not contain database credentials. The backend is the single authority for validation and decision logic.

## 5. Seed demo data
After dependencies are installed and MongoDB is running:

```bash
npm run seed
```

The seed script upserts clearly synthetic example records and can be run repeatedly. It adds 8 synthetic vehicles, 8 CNG assets and 12 synthetic hydrotest records covering valid, due-soon, overdue, failed and pending scenarios. One vehicle is intentionally left without hydrotest records. It also adds clearly labelled synthetic scan/verification fixtures to populate dashboard, history and review views; these have no source media and are not real OCR results. Plate strings are test fixtures—not actual numbers extracted from video.

To reset only demo test records, first set `ALLOW_DEMO_RESET=true` in `.env`, inspect `scripts/seed-demo.js`, and run `node scripts/seed-demo.js --reset`. Do not use the reset command on a database containing operational records.

## 6. Collections
- `vehicles`: normalized registration, category, optional make/model, station, source, timestamps.
- `cngAssets`: asset/cylinder identifiers and reference to `vehicles._id`.
- `hydrotests`: test dates/results and reference to `cngAssets._id`/vehicle.
- `mediaFiles`: file metadata, SHA-256, storage path/key; video bytes remain on disk.
- `scans`: scan job state, candidates, selected plate and verification summary.
- `verifications`: decision, reason codes, linked vehicle/assets and evidence references.
- `cameras`: camera name/station and server-side stream URL; public APIs redact the URL.
- `auditLogs`: append-style history of record/decision changes.

## 7. Indexes
Indexes are created when the application connects. Plate normalization and uniqueness are enforced by `vehicles.plateNumberNormalized`; `assetCode` is unique; serial/certificate indexes prevent applicable duplicates; lookup indexes cover asset-to-vehicle relationships, hydrotest history, due dates, scan status and verification history.

## 8. Example queries in mongosh

```javascript
use fuelflux_cng_demo
show collections
db.vehicles.find({ plateNumberNormalized: 'GJ01AB1234' })
db.cngAssets.find({ assetCode: 'CNG-DEMO-001' })
db.hydrotests.find({ certificateReference: 'DEMO-CERT-001-CURRENT' })
db.scans.find().sort({ createdAt: -1 }).limit(5)
```

Use MongoDB Compass to inspect a database visually: connect to `mongodb://127.0.0.1:27017`, choose `fuelflux_cng_demo`, and open the collections.

## 9. CRUD example in Node.js

```javascript
const db = require('../src/db').getDb();
const vehicle = await db.collection('vehicles').findOne({ plateNumberNormalized: 'GJ01AB1234' });
```

For updates, the API uses `updateOne({ _id }, { $set: changes })`; server-controlled `createdAt` remains unchanged while `updatedAt` changes. All actual endpoint validation is in `src/app.js` and the shared rule functions in `src/domain.js`.

## 10. Atlas setup (optional)
1. Create a MongoDB Atlas project/cluster.
2. Create a database user with only required privileges.
3. Restrict network access to the development/deployment environment.
4. Copy the Atlas URI into local `.env`.
5. URL-encode special characters in credentials if required by URI parsing.
6. Keep the URI out of Git and logs.

Example placeholder:

```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=fuelflux_cng_demo
```

## 11. Troubleshooting
- **ECONNREFUSED:** MongoDB is not running or host/port is incorrect.
- **Authentication failed:** verify database user and URI credentials.
- **Atlas network error:** check network access/IP allowlist and outbound connectivity.
- **Missing environment configuration:** check `.env` file name and `MONGODB_URI`/`MONGODB_DB_NAME` spelling.
- **Duplicate record:** expected unique index caught a repeated plate, asset code, serial or certificate.
- **API returns 503:** inspect server terminal for connection health; do not bypass the database check.

The supplied project is a local demo scaffold. Use secret management, least-privilege accounts, authenticated APIs, TLS and approved retention policies before operational use.
