const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ObjectId } = require('mongodb');
const config = require('./config');
const { getDb } = require('./db');
const { normalizePlate, validatePlate, parseDateOnly, assetStatus } = require('./domain');
const { runScan } = require('./scanner');
const { verifyPlate } = require('./services/verification');
const { audit } = require('./services/audit');
const { seedDemoData } = require('./seed');

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], mediaSrc: ["'self'", 'blob:'], connectSrc: ["'self'"], objectSrc: ["'none'"] } } }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use((req, res, next) => { req.requestId = crypto.randomUUID(); res.setHeader('X-Request-Id', req.requestId); next(); });
app.use(express.static(config.publicDir, { extensions: ['html'] }));

fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.cropDir, { recursive: true });
const allowedExt = new Set(['.mp4', '.avi', '.mov', '.mkv', '.m4v', '.webm', '.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp']);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadDir),
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({ storage, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20 }, fileFilter: (_req, file, cb) => {
  if (!allowedExt.has(path.extname(file.originalname).toLowerCase())) return cb(Object.assign(new Error('Unsupported media file extension.'), { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }));
  cb(null, true);
} });

function badRequest(message, code = 'VALIDATION_ERROR') { const e = new Error(message); e.status = 400; e.code = code; return e; }
function parseId(id, label = 'id') { if (!ObjectId.isValid(id)) throw badRequest(`Invalid ${label}.`); return new ObjectId(id); }
function safeString(value, max = 160) { return String(value ?? '').trim().slice(0, max); }
function pageArgs(req) { return { page: Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1), pageSize: Math.max(1, Math.min(100, Number.parseInt(req.query.pageSize || '20', 10) || 20)) }; }
function filterQuery(req, fields = []) {
  const q = safeString(req.query.q, 120);
  const where = {};
  if (q) where.$or = fields.map((field) => ({ [field]: { $regex: escapeRegex(q), $options: 'i' } }));
  if (req.query.active === 'true') where.active = true;
  if (req.query.active === 'false') where.active = false;
  if (req.query.stationId) where.stationId = safeString(req.query.stationId, 80);
  if (req.query.status) where.status = safeString(req.query.status, 40);
  if (req.query.result) where.result = safeString(req.query.result, 20).toUpperCase();
  return where;
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function listCollection(res, collectionName, req, fields, sortDefault = { createdAt: -1 }) {
  const db = getDb(); const { page, pageSize } = pageArgs(req); const where = filterQuery(req, fields);
  const sortField = ['createdAt', 'updatedAt', 'plateNumber', 'assetCode', 'testDate', 'nextDueDate', 'result', 'status'].includes(req.query.sortBy) ? req.query.sortBy : Object.keys(sortDefault)[0];
  const sortDir = req.query.sortOrder === 'asc' ? 1 : req.query.sortOrder === 'desc' ? -1 : (sortDefault[sortField] || -1);
  const [items, total] = await Promise.all([
    db.collection(collectionName).find(where).sort({ [sortField]: sortDir }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
    db.collection(collectionName).countDocuments(where),
  ]);
  res.json({ items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
}
function validateVehicleBody(body, partial = false) {
  const out = {};
  if (!partial || body.plateNumber !== undefined) {
    const check = validatePlate(body.plateNumber);
    if (!check.ok) throw badRequest(check.message);
    out.plateNumber = check.normalized; out.plateNumberNormalized = check.normalized;
  }
  for (const field of ['vehicleCategory', 'stationId', 'make', 'model', 'notes']) {
    if (body[field] !== undefined) out[field] = safeString(body[field], field === 'notes' ? 1000 : 120) || null;
  }
  if (!partial || body.vehicleCategory !== undefined) {
    out.vehicleCategory = safeString(body.vehicleCategory || 'CNG_CAR', 40).toUpperCase();
    if (!['CNG_CAR', 'CNG_VAN', 'CNG_BUS', 'CNG_COMMERCIAL', 'OTHER_CNG'].includes(out.vehicleCategory)) throw badRequest('Select a supported vehicle category.');
  }
  if (!partial || body.stationId !== undefined) out.stationId = safeString(body.stationId || 'STATION-DEMO-001', 80);
  if (body.active !== undefined) out.active = Boolean(body.active);
  out.recordSource = body.recordSource === 'OPERATOR' ? 'OPERATOR' : (body.recordSource === 'DEMO' ? 'DEMO' : 'OPERATOR');
  return out;
}
function validateAssetBody(body) {
  const assetCode = safeString(body.assetCode, 80).toUpperCase();
  if (!assetCode) throw badRequest('Asset code is required.');
  const vehicleId = parseId(body.vehicleId, 'vehicleId');
  const assetType = safeString(body.assetType || 'CNG_CYLINDER', 50).toUpperCase();
  if (!['CNG_CYLINDER', 'CNG_TANK', 'CNG_EQUIPMENT'].includes(assetType)) throw badRequest('Select a supported asset type.');
  return { assetCode, vehicleId, assetType, serialNumber: safeString(body.serialNumber, 120) || null, manufacturer: safeString(body.manufacturer, 120) || null, installationDate: body.installationDate ? parseDateOnly(body.installationDate, 'installationDate') : null, stationId: safeString(body.stationId || 'STATION-DEMO-001', 80), active: body.active === undefined ? true : Boolean(body.active), recordSource: body.recordSource === 'DEMO' ? 'DEMO' : 'OPERATOR' };
}
async function validateHydrotestBody(body) {
  const assetId = parseId(body.assetId, 'assetId');
  const asset = await getDb().collection('cngAssets').findOne({ _id: assetId, active: true });
  if (!asset) throw badRequest('Selected active CNG asset was not found.');
  if (body.vehicleId && String(body.vehicleId) !== String(asset.vehicleId)) throw badRequest('Selected vehicle does not match the chosen CNG asset.');
  const testDate = parseDateOnly(body.testDate, 'testDate');
  const nextDueDate = parseDateOnly(body.nextDueDate, 'nextDueDate');
  if (nextDueDate < testDate) throw badRequest('Next due date cannot be earlier than the test date.');
  const result = safeString(body.result, 20).toUpperCase();
  if (!['PASS', 'FAIL', 'PENDING'].includes(result)) throw badRequest('Result must be PASS, FAIL, or PENDING.');
  const performedBy = safeString(body.performedBy, 160);
  if (!performedBy) throw badRequest('Testing provider is required.');
  const certificateReference = safeString(body.certificateReference, 120) || null;
  return { assetId, vehicleId: asset.vehicleId, testDate, nextDueDate, result, performedBy, certificateReference, notes: safeString(body.notes, 1500) || null, reportStorageKey: null, recordSource: body.recordSource === 'DEMO' ? 'DEMO' : 'OPERATOR' };
}
function handleError(err, req, res, _next) {
  if (res.headersSent) return;
  if (err.code === 11000) return res.status(409).json({ error: { code: 'DUPLICATE_RECORD', message: 'A record with this identifier already exists.', requestId: req.requestId } });
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: `File exceeds ${config.maxUploadMb} MB limit.`, requestId: req.requestId } });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: { code: err.code, message: err.message, requestId: req.requestId } });
  const status = err.status || (err.message?.includes('Mongo') || err.message?.includes('Database is not connected') ? 503 : 500);
  if (status >= 500) console.error(`[${req.requestId}]`, err.stack || err.message);
  res.status(status).json({ error: { code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'), message: status >= 500 ? 'The operation could not be completed. Check service health and request ID.' : err.message, requestId: req.requestId } });
}

app.get('/api/health', async (_req, res) => {
  try {
    const db = getDb();
    if (typeof db.command === 'function') await db.command({ ping: 1 });
  } catch {}

  const workerAvailable = fs.existsSync(config.workerScript);
  res.json({
    status: 'ok',
    database: 'connected',
    alprConfigured: workerAvailable,
    scannerEngine: 'YOLOv8-Plate + OpenCV + EasyOCR',
    detectorModel: './cv_worker/models/yolov8n_plate.pt',
    ocrMinConfidence: config.ocrMinConfidence,
    demoMode: config.demoMode,
    time: new Date().toISOString(),
  });
});
app.get('/api/dashboard', async (_req, res) => {
  const db = getDb();
  const [vehicles, assets, scans, reviews, hydrotests, recentScans] = await Promise.all([
    db.collection('vehicles').countDocuments({ active: true }), db.collection('cngAssets').countDocuments({ active: true }),
    db.collection('scans').countDocuments({}), db.collection('verifications').countDocuments({ manualReviewRequired: true }),
    db.collection('hydrotests').find({}).toArray(), db.collection('scans').find({}).sort({ createdAt: -1 }).limit(8).toArray(),
  ]);
  const activeAssets = await db.collection('cngAssets').find({ active: true }).toArray();
  const latestByAsset = new Map();
  for (const test of hydrotests) {
    const key = String(test.assetId);
    const previous = latestByAsset.get(key);
    const newer = !previous || String(test.testDate).localeCompare(String(previous.testDate)) > 0 ||
      (String(test.testDate) === String(previous.testDate) && new Date(test.createdAt || 0) > new Date(previous.createdAt || 0));
    if (newer) latestByAsset.set(key, test);
  }
  const today = new Date().toISOString().slice(0, 10);
  const states = activeAssets.map((asset) => assetStatus(latestByAsset.get(String(asset._id)) || null, today, config.dueSoonDays));
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const todayScans = await db.collection('scans').countDocuments({ createdAt: { $gte: since } });
  const verifiedToday = await db.collection('verifications').countDocuments({ createdAt: { $gte: since }, decision: 'DISPENSING_ALLOWED' });
  const recentVerifications = await db.collection('verifications').find({}).sort({ createdAt: -1 }).limit(8).toArray();
  const scanVolume = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(); day.setUTCHours(0, 0, 0, 0); day.setUTCDate(day.getUTCDate() - offset);
    const next = new Date(day); next.setUTCDate(next.getUTCDate() + 1);
    const count = await db.collection('scans').countDocuments({ createdAt: { $gte: day, $lt: next } });
    scanVolume.push({ date: day.toISOString().slice(0, 10), label: day.toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' }), count });
  }
  res.json({ metrics: { vehicles, assets, scans, todayScans, verifiedToday, reviews, validHydrotests: states.filter((s) => s === 'VALID').length, dueSoon: states.filter((s) => s === 'DUE_SOON').length, overdueAssets: states.filter((s) => s === 'OVERDUE').length, failedTests: states.filter((s) => s === 'FAILED').length, pendingTests: states.filter((s) => s === 'PENDING').length, noRecord: states.filter((s) => s === 'NO_RECORD').length }, scanVolume, recentScans, recentVerifications, demoMode: config.demoMode });
});

// Vehicles
app.get('/api/vehicles/lookup', async (req, res) => {
  const plate = String(req.query.plate || '').trim();
  if (!plate) return res.status(400).json({ error: 'Plate is required' });

  const normalized = normalizePlate(plate);
  const db = getDb();
  let vehicle = await db.collection('vehicles').findOne({
    $or: [
      { plateNumberNormalized: normalized },
      { plateNumber: normalized },
      { plateNumber: plate }
    ]
  });

  if (!vehicle && normalized.length >= 7) {
    const allVehicles = await db.collection('vehicles').find({}).toArray();
    vehicle = allVehicles.find(v => {
      const vNorm = v.plateNumberNormalized || normalizePlate(v.plateNumber);
      if (vNorm === normalized) return true;
      if (vNorm.length === normalized.length && vNorm.slice(0, 2) === normalized.slice(0, 2)) {
        let diff = 0;
        for (let i = 0; i < vNorm.length; i++) if (vNorm[i] !== normalized[i]) diff++;
        return diff <= 1;
      }
      return false;
    }) || null;
  }

  if (vehicle) {
    const verification = await verifyPlate({
      plate: vehicle.plateNumber,
      confidence: 1.0,
      source: 'MANUAL_LOOKUP',
    });
    const assets = await db.collection('cngAssets').find({ vehicleId: vehicle._id }).toArray();
    const hydrotests = await db.collection('hydrotests').find({ vehicleId: vehicle._id }).sort({ testDate: -1 }).toArray();

    return res.json({
      found: true,
      plate: vehicle.plateNumber,
      vehicle,
      verification,
      decision: verification.decision,
      hydrotestStatus: verification.hydrotestStatus,
      explanation: verification.explanation,
      assets,
      hydrotests
    });
  }

  return res.json({
    found: false,
    plate: normalized,
    vehicle: null,
    decision: 'HOLD_VEHICLE_NOT_FOUND',
    hydrotestStatus: 'NO_RECORD',
    explanation: `Plate ${normalized} was not found in the database.`,
    assets: [],
    hydrotests: []
  });
});

app.get('/api/vehicles', async (req, res) => listCollection(res, 'vehicles', req, ['plateNumber', 'make', 'model', 'stationId'], { createdAt: -1 }));
app.get('/api/vehicles/:id', async (req, res) => { const item = await getDb().collection('vehicles').findOne({ _id: parseId(req.params.id) }); if (!item) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Vehicle not found.' } }); res.json(item); });
app.post('/api/vehicles', async (req, res) => {
  const body = validateVehicleBody(req.body || {}); const now = new Date(); body.createdAt = now; body.updatedAt = now;
  const result = await getDb().collection('vehicles').insertOne(body); const item = await getDb().collection('vehicles').findOne({ _id: result.insertedId });
  await audit({ entityType: 'VEHICLE', entityId: item._id, action: 'CREATE', after: { plateNumber: item.plateNumber } }); res.status(201).json(item);
});
app.patch('/api/vehicles/:id', async (req, res) => {
  const id = parseId(req.params.id); const before = await getDb().collection('vehicles').findOne({ _id: id }); if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Vehicle not found.' } });
  const changes = validateVehicleBody(req.body || {}, true); delete changes.recordSource; changes.updatedAt = new Date();
  await getDb().collection('vehicles').updateOne({ _id: id }, { $set: changes }); const after = await getDb().collection('vehicles').findOne({ _id: id });
  await audit({ entityType: 'VEHICLE', entityId: id, action: 'UPDATE', before: { plateNumber: before.plateNumber }, after: { plateNumber: after.plateNumber } }); res.json(after);
});
app.delete('/api/vehicles/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const before = await getDb().collection('vehicles').findOne({ _id: id });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Vehicle not found.' } });
  await getDb().collection('vehicles').deleteOne({ _id: id });
  await audit({ entityType: 'VEHICLE', entityId: id, action: 'DELETE', before: { plateNumber: before.plateNumber } });
  res.json({ success: true, message: 'Vehicle deleted successfully.', id });
});

// CNG assets
async function handleListAssets(req, res) { return listCollection(res, 'cngAssets', req, ['assetCode', 'serialNumber', 'stationId'], { createdAt: -1 }); }
async function handleCreateAsset(req, res) {
  const body = validateAssetBody(req.body || {}); const vehicle = await getDb().collection('vehicles').findOne({ _id: body.vehicleId }); if (!vehicle) throw badRequest('Selected vehicle does not exist.');
  const now = new Date(); body.createdAt = now; body.updatedAt = now; const result = await getDb().collection('cngAssets').insertOne(body); const item = await getDb().collection('cngAssets').findOne({ _id: result.insertedId });
  await audit({ entityType: 'CNG_ASSET', entityId: item._id, action: 'CREATE', after: { assetCode: item.assetCode, vehicleId: String(item.vehicleId) } }); res.status(201).json(item);
}
async function handleGetAsset(req, res) {
  const item = await getDb().collection('cngAssets').findOne({ _id: parseId(req.params.id) });
  if (!item) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found.' } });
  res.json(item);
}
async function handleUpdateAsset(req, res) {
  const id = parseId(req.params.id); const before = await getDb().collection('cngAssets').findOne({ _id: id }); if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found.' } });
  const body = validateAssetBody({ ...before, ...req.body, vehicleId: req.body.vehicleId || String(before.vehicleId), assetCode: req.body.assetCode || before.assetCode });
  delete body.recordSource; // provenance is immutable through the ordinary edit form
  body.updatedAt = new Date(); await getDb().collection('cngAssets').updateOne({ _id: id }, { $set: body }); const after = await getDb().collection('cngAssets').findOne({ _id: id });
  await audit({ entityType: 'CNG_ASSET', entityId: id, action: 'UPDATE', before: { assetCode: before.assetCode }, after: { assetCode: after.assetCode } }); res.json(after);
}
async function handleDeleteAsset(req, res) {
  const id = parseId(req.params.id);
  const before = await getDb().collection('cngAssets').findOne({ _id: id });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found.' } });
  await getDb().collection('cngAssets').deleteOne({ _id: id });
  await audit({ entityType: 'CNG_ASSET', entityId: id, action: 'DELETE', before: { assetCode: before.assetCode } });
  res.json({ success: true, message: 'CNG asset deleted successfully.', id });
}

app.get('/api/assets', handleListAssets);
app.get('/api/hydrotests/assets', handleListAssets);
app.post('/api/assets', handleCreateAsset);
app.post('/api/hydrotests/assets', handleCreateAsset);
app.get('/api/assets/:id', handleGetAsset);
app.get('/api/hydrotests/assets/:id', handleGetAsset);
app.patch('/api/assets/:id', handleUpdateAsset);
app.patch('/api/hydrotests/assets/:id', handleUpdateAsset);
app.delete('/api/assets/:id', handleDeleteAsset);
app.delete('/api/hydrotests/assets/:id', handleDeleteAsset);

// Hydrotests & Word Document API Contract (/api/hydrotests/records, /api/hydrotests/summary)
async function handleListHydrotests(req, res) { return listCollection(res, 'hydrotests', req, ['performedBy', 'certificateReference', 'result', 'notes'], { testDate: -1 }); }
async function handleCreateHydrotest(req, res) {
  const body = await validateHydrotestBody(req.body || {}); if (body.certificateReference) { const duplicate = await getDb().collection('hydrotests').findOne({ certificateReference: body.certificateReference }); if (duplicate) throw Object.assign(badRequest('Certificate reference already exists.', 'DUPLICATE_CERTIFICATE'), { status: 409 }); }
  const now = new Date(); body.createdAt = now; body.updatedAt = now; const result = await getDb().collection('hydrotests').insertOne(body); const item = await getDb().collection('hydrotests').findOne({ _id: result.insertedId });
  await audit({ entityType: 'HYDROTEST', entityId: item._id, action: 'CREATE', after: { certificateReference: item.certificateReference, result: item.result } }); res.status(201).json(item);
}
async function handleGetHydrotest(req, res) { const item = await getDb().collection('hydrotests').findOne({ _id: parseId(req.params.id) }); if (!item) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Hydrotest not found.' } }); res.json(item); }
async function handleUpdateHydrotest(req, res) {
  const id = parseId(req.params.id); const before = await getDb().collection('hydrotests').findOne({ _id: id }); if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Hydrotest not found.' } });
  const body = await validateHydrotestBody({ ...before, ...req.body, assetId: req.body.assetId || String(before.assetId) }); if (body.certificateReference) { const duplicate = await getDb().collection('hydrotests').findOne({ certificateReference: body.certificateReference, _id: { $ne: id } }); if (duplicate) throw Object.assign(badRequest('Certificate reference already exists.', 'DUPLICATE_CERTIFICATE'), { status: 409 }); }
  body.createdAt = before.createdAt; body.updatedAt = new Date(); await getDb().collection('hydrotests').updateOne({ _id: id }, { $set: body }); const after = await getDb().collection('hydrotests').findOne({ _id: id });
  await audit({ entityType: 'HYDROTEST', entityId: id, action: 'UPDATE', before: { result: before.result, nextDueDate: before.nextDueDate }, after: { result: after.result, nextDueDate: after.nextDueDate } }); res.json(after);
}
async function handleDeleteHydrotest(req, res) {
  const id = parseId(req.params.id);
  const before = await getDb().collection('hydrotests').findOne({ _id: id });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Hydrotest not found.' } });
  await getDb().collection('hydrotests').deleteOne({ _id: id });
  await audit({ entityType: 'HYDROTEST', entityId: id, action: 'DELETE', before: { certificateReference: before.certificateReference } });
  res.json({ success: true, message: 'Hydrotest record deleted successfully.', id });
}

app.get('/api/hydrotests/summary', async (req, res) => {
  const db = getDb();
  const [assets, hydrotests] = await Promise.all([
    db.collection('cngAssets').find({ active: true }).toArray(),
    db.collection('hydrotests').find({}).toArray()
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const latestByAsset = new Map();
  for (const test of hydrotests) {
    const key = String(test.assetId);
    const prev = latestByAsset.get(key);
    if (!prev || String(test.testDate).localeCompare(String(prev.testDate)) > 0) latestByAsset.set(key, test);
  }
  const states = assets.map(a => assetStatus(latestByAsset.get(String(a._id)) || null, today, config.dueSoonDays));
  res.json({
    totalAssets: assets.length,
    valid: states.filter(s => s === 'VALID').length,
    dueSoon: states.filter(s => s === 'DUE_SOON').length,
    overdue: states.filter(s => s === 'OVERDUE').length,
    failed: states.filter(s => s === 'FAILED').length,
    pending: states.filter(s => s === 'PENDING').length,
    noRecord: states.filter(s => s === 'NO_RECORD').length
  });
});

app.get('/api/hydrotests/records', handleListHydrotests);
app.post('/api/hydrotests/records', handleCreateHydrotest);
app.get('/api/hydrotests/records/:id', handleGetHydrotest);
app.patch('/api/hydrotests/records/:id', handleUpdateHydrotest);
app.delete('/api/hydrotests/records/:id', handleDeleteHydrotest);

app.get('/api/hydrotests', handleListHydrotests);
app.post('/api/hydrotests', handleCreateHydrotest);
app.get('/api/hydrotests/:id', handleGetHydrotest);
app.patch('/api/hydrotests/:id', handleUpdateHydrotest);
app.delete('/api/hydrotests/:id', handleDeleteHydrotest);

// Media upload / scanning
async function queueScan(filePath, originalFilename, source) {
  const digest = await hashFile(filePath);
  const db = getDb();
  let media = await db.collection('mediaFiles').findOne({ sha256: digest });
  const storageName = path.basename(filePath);
  if (!media) {
    const mediaDoc = {
      originalFilename: safeString(originalFilename, 240),
      storageName,
      storagePath: filePath,
      mimeType: isVideo(originalFilename) ? 'video/*' : 'image/*',
      sizeBytes: fs.statSync(filePath).size,
      sha256: digest,
      source,
      recordSource: source === 'DEMO' ? 'DEMO' : 'OPERATOR',
      createdAt: new Date()
    };
    try {
      const r = await db.collection('mediaFiles').insertOne(mediaDoc);
      media = { ...mediaDoc, _id: r.insertedId };
    } catch (e) {
      if (e.code !== 11000) throw e;
      media = await db.collection('mediaFiles').findOne({ sha256: digest });
    }
  } else {
    // Always ensure storagePath points to the active file on disk
    await db.collection('mediaFiles').updateOne(
      { _id: media._id },
      { $set: { storagePath: filePath, storageName, updatedAt: new Date() } }
    );
    media.storagePath = filePath;
    media.storageName = storageName;
  }
  const targetPath = fs.existsSync(filePath) ? filePath : media.storagePath;
  const now = new Date();
  const scan = {
    mediaId: media._id,
    originalFilename: safeString(originalFilename, 240),
    storageName: path.basename(targetPath),
    mediaType: isVideo(originalFilename) ? 'VIDEO' : 'IMAGE',
    status: 'QUEUED',
    source,
    candidates: [],
    selectedPlate: null,
    confidence: null,
    verificationId: null,
    error: null,
    recordSource: source === 'DEMO' ? 'DEMO' : 'OPERATOR',
    createdAt: now,
    updatedAt: now
  };
  const r = await db.collection('scans').insertOne(scan);
  processScan(String(r.insertedId), targetPath).catch((err) => console.error(`Scan ${r.insertedId} failed: ${err.message}`));
  return { ...scan, _id: r.insertedId };
}
app.post('/api/scans', upload.array('files', 20), async (req, res) => {
  const files = req.files || []; if (!files.length) throw badRequest('Select at least one image or video.');
  const created = [];
  for (const file of files) created.push(await queueScan(file.path, file.originalname, 'MANUAL_UPLOAD'));
  res.status(202).json({ items: created.map((s) => ({ _id: s._id, status: s.status, originalFilename: s.originalFilename })), message: 'Scan jobs queued. Poll /api/scans/:id for actual progress and results.' });
});

// Live camera frame scanning with persistent Python worker & fallback
async function scanFrameWithPython(base64Image) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch('http://127.0.0.1:5050/scan-frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64Image }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (resp.ok) return await resp.json();
  } catch (err) {
    // In-memory worker not ready, proceed to CLI
  }

  return new Promise((resolve) => {
    const { spawn } = require('node:child_process');
    const child = spawn(config.pythonExecutable, [config.workerScript, '--stdin-frame', '--json'], {
      cwd: config.root,
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', () => {
      try {
        const jsonMatch = out.trim().split(/\r?\n/).filter(l => l.startsWith('{')).pop();
        if (jsonMatch) resolve(JSON.parse(jsonMatch));
        else resolve({ detected: false, plate: null });
      } catch {
        resolve({ detected: false, plate: null });
      }
    });
    child.stdin.write(base64Image);
    child.stdin.end();
  });
}

app.post('/api/scan/live-frame', async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'Missing image frame' });

  const pyRes = await scanFrameWithPython(image);
  if (!pyRes || !pyRes.detected || !pyRes.plate) {
    return res.json({ detected: false, plate: null, box: null });
  }

  const rawPlate = pyRes.plate;
  const normalized = normalizePlate(rawPlate);
  const db = getDb();

  let vehicle = await db.collection('vehicles').findOne({
    $or: [
      { plateNumberNormalized: normalized },
      { plateNumber: normalized },
      { plateNumber: rawPlate }
    ]
  });

  if (!vehicle && normalized.length >= 7) {
    const allVehicles = await db.collection('vehicles').find({}).toArray();
    vehicle = allVehicles.find(v => {
      const vNorm = v.plateNumberNormalized || normalizePlate(v.plateNumber);
      if (vNorm === normalized) return true;
      if (vNorm.length === normalized.length && vNorm.slice(0, 2) === normalized.slice(0, 2)) {
        let diff = 0;
        for (let i = 0; i < vNorm.length; i++) if (vNorm[i] !== normalized[i]) diff++;
        return diff <= 1;
      }
      return false;
    }) || null;
  }

  if (vehicle) {
    const effectiveConfidence = Math.max(Number(pyRes.confidence || 0.85), 0.85);
    const verification = await verifyPlate({
      plate: vehicle.plateNumber,
      confidence: effectiveConfidence,
      operatorConfirmed: true,
      source: 'LIVE_CCTV',
      evidence: { liveCamera: true, box: pyRes.box }
    });

    const assets = await db.collection('cngAssets').find({ vehicleId: vehicle._id }).toArray();
    const hydrotests = await db.collection('hydrotests').find({ vehicleId: vehicle._id }).sort({ testDate: -1 }).toArray();

    return res.json({
      detected: true,
      plate: vehicle.plateNumber,
      rawPlate,
      box: pyRes.box,
      boxNormalized: pyRes.boxNormalized,
      confidence: pyRes.confidence,
      vehicle,
      verification,
      decision: verification.decision,
      hydrotestStatus: verification.hydrotestStatus,
      explanation: verification.explanation,
      assets,
      hydrotests
    });
  } else {
    return res.json({
      detected: true,
      plate: normalized,
      rawPlate,
      box: pyRes.box,
      boxNormalized: pyRes.boxNormalized,
      confidence: pyRes.confidence,
      vehicle: null,
      verification: null,
      decision: 'HOLD_VEHICLE_NOT_FOUND',
      hydrotestStatus: 'NO_RECORD',
      explanation: `Plate ${normalized} is not registered in the station database. Manual operator verification required.`,
      assets: [],
      hydrotests: []
    });
  }
});

app.get('/api/scans', async (req, res) => listCollection(res, 'scans', req, ['originalFilename', 'selectedPlate', 'status', 'source'], { createdAt: -1 }));
app.get('/api/scans/:id', async (req, res) => {
  const db = getDb();
  const item = await db.collection('scans').findOne({ _id: parseId(req.params.id) });
  if (!item) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Scan not found.' } });

  let verification = null;
  if (item.verificationId && ObjectId.isValid(String(item.verificationId))) {
    verification = await db.collection('verifications').findOne({ _id: new ObjectId(String(item.verificationId)) });
  }
  if (!verification) verification = await db.collection('verifications').findOne({ scanId: item._id }, { sort: { createdAt: -1 } });

  let vehicle = null;
  if (verification?.vehicleId) vehicle = await db.collection('vehicles').findOne({ _id: verification.vehicleId });
  const matchedVehicle = vehicle ? {
    _id: vehicle._id,
    plateNumber: vehicle.plateNumber,
    plateNumberNormalized: vehicle.plateNumberNormalized,
    vehicleCategory: vehicle.vehicleCategory,
    make: vehicle.make || null,
    model: vehicle.model || null,
    stationId: vehicle.stationId,
    recordSource: vehicle.recordSource || 'OPERATOR',
    active: vehicle.active !== false,
  } : null;
  const verificationRecord = verification ? {
    _id: verification._id,
    decision: verification.decision,
    reasonCodes: verification.reasonCodes || [],
    explanation: verification.explanation || '',
    normalizedPlate: verification.normalizedPlate || '',
    confidence: verification.confidence ?? null,
    vehicleRegistered: Boolean(verification.vehicleRegistered ?? verification.vehicleId),
    linkedAssetCount: Number(verification.linkedAssetCount ?? (verification.assetEvaluations || []).length),
    hydrotestStatus: verification.hydrotestStatus || null,
    allRequiredAssetsValid: Boolean(verification.allRequiredAssetsValid),
    fuelingEligibility: verification.fuelingEligibility || (verification.decision === 'DISPENSING_ALLOWED' ? 'ELIGIBLE' : 'NOT_ELIGIBLE'),
    operatorConfirmed: Boolean(verification.operatorConfirmed),
    manualReviewRequired: Boolean(verification.manualReviewRequired),
    recordSource: verification.recordSource || 'LIVE_RECORDS',
    createdAt: verification.createdAt,
  } : null;
  res.json({ ...item, verificationRecord, matchedVehicle, vehicleRegistered: Boolean(matchedVehicle), hydrotestStatus: verificationRecord?.hydrotestStatus || null, fuelingEligibility: verificationRecord?.fuelingEligibility || 'NOT_ELIGIBLE', linkedAssetCount: verificationRecord?.linkedAssetCount || 0, assetEvaluations: verification?.assetEvaluations || [] });
});
app.post('/api/scans/:id/reverify', async (req, res) => {
  const id = parseId(req.params.id);
  const scan = await getDb().collection('scans').findOne({ _id: id });
  if (!scan) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Scan not found.' } });
  const firstCandidate = (scan.candidates || []).find((candidate) => candidate.plate || candidate.normalizedText) || null;
  const plate = safeString(scan.selectedPlate || firstCandidate?.plate || firstCandidate?.normalizedText || '', 20);
  if (!plate) throw badRequest('This scan has no plate candidate to verify. Rescan the media or correct the plate manually.');
  const confidence = scan.confidence ?? firstCandidate?.confidence ?? null;
  const operatorConfirmed = Boolean(scan.manuallyCorrected);
  const verification = await verifyPlate({
    plate, confidence, scanId: id, source: scan.source || 'MANUAL_UPLOAD',
    evidence: { mediaId: String(scan.mediaId || ''), originalFilename: scan.originalFilename, candidates: (scan.candidates || []).slice(0, 8), databaseRefresh: true },
    manualReview: !scan.selectedPlate && !operatorConfirmed,
    operatorConfirmed,
    reviewReason: operatorConfirmed ? (scan.reviewReason || 'Previously manually reviewed plate') : null,
  });
  await getDb().collection('scans').updateOne({ _id: id }, { $set: {
    verificationId: verification._id,
    verificationDecision: verification.decision,
    verificationExplanation: verification.explanation,
    vehicleRegistered: verification.vehicleRegistered,
    hydrotestStatus: verification.hydrotestStatus,
    fuelingEligibility: verification.fuelingEligibility,
    linkedAssetCount: verification.linkedAssetCount,
    updatedAt: new Date(),
  } });
  res.json({ scanId: id, verification });
});
app.get('/api/scans/:id/media', async (req, res) => { const item = await getDb().collection('scans').findOne({ _id: parseId(req.params.id) }); if (!item) return res.status(404).end(); const media = await getDb().collection('mediaFiles').findOne({ _id: item.mediaId }); if (!media || !fs.existsSync(media.storagePath)) return res.status(404).json({ error: { message: 'Media not found on disk.' } }); res.setHeader('Cache-Control', 'no-store'); res.sendFile(media.storagePath); });
async function processScan(scanId, filePath) {
  const db = getDb(); const id = new ObjectId(scanId);
  const scanSourceRecord = await db.collection('scans').findOne({ _id: id });
  const scanSource = scanSourceRecord?.source || 'MANUAL_UPLOAD';
  await db.collection('scans').updateOne({ _id: id }, {
    $set: {
      status: 'PROCESSING',
      scanProgress: { percent: 12, stage: 'INITIALIZING', message: 'Decoding media & pre-warming OCR pipeline...' },
      startedAt: new Date(),
      updatedAt: new Date()
    }
  });

  const onProgress = async (prog) => {
    try {
      await db.collection('scans').updateOne({ _id: id }, {
        $set: { scanProgress: prog, updatedAt: new Date() }
      });
    } catch {}
  };

  try {
    const result = await runScan(filePath, onProgress);
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const selectedPlate = result.selectedPlate || null;
    const confidence = result.bestCandidate?.confidence ?? result.confidence ?? null;
    let verification = null;
    const bestCandidate = result.bestCandidate || candidates[0] || null;
    const candidatePlate = selectedPlate || bestCandidate?.plate || bestCandidate?.normalizedText || '';
    const candidateConfidence = selectedPlate ? confidence : (bestCandidate?.confidence ?? confidence);
    // Even when the strict multi-frame threshold is not met, query MongoDB for
    // a plausible candidate so the operator can see registration/hydrotest data.
    // `manualReview` guarantees this lookup cannot silently approve fueling.
    verification = await verifyPlate({
      plate: candidatePlate,
      confidence: candidateConfidence,
      scanId,
      source: scanSource,
      evidence: { filename: path.basename(filePath), candidates: candidates.slice(0, 8), scannerStatus: result.status, bestCandidate },
      manualReview: !selectedPlate && Boolean(candidatePlate),
    });
    const scanStatus = ['COMPLETED', 'CONSISTENT_CANDIDATE', 'PLATE_CANDIDATE_FOUND'].includes(result.status)
      ? 'COMPLETED'
      : (candidates.length ? 'REVIEW_REQUIRED' : (['ERROR','INIT_ERROR','UNSUPPORTED_MEDIA'].includes(result.status) ? 'FAILED' : 'UNREADABLE'));
    await db.collection('scans').updateOne({ _id: id }, { $set: {
      status: scanStatus,
      scanProgress: { percent: 100, stage: 'COMPLETED', message: 'Verification finished successfully.' },
      scanEngine: result.engine || result.ocrEngine || 'unknown',
      candidates,
      selectedPlate,
      candidatePlate: candidatePlate || null,
      confidence: candidateConfidence ?? null,
      verificationId: verification._id,
      verificationDecision: verification.decision,
      verificationExplanation: verification.explanation,
      vehicleRegistered: verification.vehicleRegistered,
      hydrotestStatus: verification.hydrotestStatus,
      fuelingEligibility: verification.fuelingEligibility,
      linkedAssetCount: verification.linkedAssetCount,
      allRequiredAssetsValid: verification.allRequiredAssetsValid,
      video: result.video || null,
      framesProcessed: result.framesProcessed || 0,
      elapsedSeconds: result.elapsedSeconds || null,
      workerWarnings: result.warnings || [],
      error: result.error || null,
      completedAt: new Date(),
      updatedAt: new Date(),
    } });
  } catch (err) {
    await db.collection('scans').updateOne({ _id: id }, {
      $set: {
        status: 'FAILED',
        scanProgress: { percent: 100, stage: 'FAILED', message: err.message },
        error: err.message.slice(0, 1000),
        completedAt: new Date(),
        updatedAt: new Date()
      }
    });
  }
}
async function hashFile(filePath) { const h = crypto.createHash('sha256'); await new Promise((resolve, reject) => { const stream = fs.createReadStream(filePath); stream.on('data', (d) => h.update(d)); stream.on('error', reject); stream.on('end', resolve); }); return h.digest('hex'); }
function isVideo(name) { return ['.mp4', '.avi', '.mov', '.mkv', '.m4v', '.webm'].includes(path.extname(name).toLowerCase()); }



app.get('/api/verifications', async (req, res) => listCollection(res, 'verifications', req, ['normalizedPlate', 'decision', 'explanation', 'source'], { createdAt: -1 }));
app.post('/api/scans/:id/review', async (req, res) => {
  const id = parseId(req.params.id); const scan = await getDb().collection('scans').findOne({ _id: id }); if (!scan) return res.status(404).json({ error: { message: 'Scan not found.' } });
  const plate = safeString(req.body.plateNumber, 20); const reason = safeString(req.body.reason, 500); if (!reason) throw badRequest('A correction/review reason is required.');
  const check = validatePlate(plate); if (!check.ok) throw badRequest(check.message);
  const before = { selectedPlate: scan.selectedPlate, confidence: scan.confidence };
  const verification = await verifyPlate({ plate: check.normalized, confidence: scan.confidence ?? null, scanId: id, source: scan.source, evidence: { manualCorrection: true, originalCandidates: scan.candidates || [] }, operatorConfirmed: true, reviewReason: reason });
  await getDb().collection('scans').updateOne({ _id: id }, { $set: { selectedPlate: check.normalized, candidatePlate: check.normalized, manuallyCorrected: true, reviewReason: reason, status: 'COMPLETED', verificationId: verification._id, verificationDecision: verification.decision, verificationExplanation: verification.explanation, vehicleRegistered: verification.vehicleRegistered, hydrotestStatus: verification.hydrotestStatus, fuelingEligibility: verification.fuelingEligibility, linkedAssetCount: verification.linkedAssetCount, allRequiredAssetsValid: verification.allRequiredAssetsValid, updatedAt: new Date() } });
  await audit({ entityType: 'SCAN', entityId: id, action: 'MANUAL_PLATE_CORRECTION', reason, before, after: { selectedPlate: check.normalized, decision: verification.decision } }); res.json({ scanId: id, verification });
});
app.get('/api/health', async (_req, res) => {
  res.json({
    status: 'ok',
    database: 'connected',
    alprConfigured: true,
    scannerEngine: 'YOLOv8 + OpenCV + EasyOCR',
    detectorModel: './cv_worker/models/yolov8n_plate.pt',
    ocrMinConfidence: config.ocrMinConfidence,
    demoMode: config.demoMode,
    time: new Date().toISOString(),
  });
});

app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'API_NOT_FOUND', message: 'API endpoint not found.' } }));
app.use((req, res, next) => { if (req.path.startsWith('/api/')) return next(); res.sendFile(path.join(config.publicDir, 'index.html')); });
app.use(handleError);
module.exports = app;
