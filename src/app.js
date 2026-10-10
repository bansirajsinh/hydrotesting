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
const cameraManager = require('./camera-manager');
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
  const sortField = ['createdAt', 'updatedAt', 'plateNumber', 'assetCode', 'testDate', 'nextDueDate', 'result', 'status', 'cameraName'].includes(req.query.sortBy) ? req.query.sortBy : Object.keys(sortDefault)[0];
  const sortDir = req.query.sortOrder === 'asc' ? 1 : req.query.sortOrder === 'desc' ? -1 : (sortDefault[sortField] || -1);
  const [items, total] = await Promise.all([
    db.collection(collectionName).find(where).sort({ [sortField]: sortDir }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
    db.collection(collectionName).countDocuments(where),
  ]);
  res.json({ items: items.map((x) => collectionName === 'cameras' ? cameraPublic(x) : x), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
}
function cameraPublic(c) { const { streamUrl, ...rest } = c; return { ...rest, streamConfigured: Boolean(streamUrl), streamUrl: undefined, runtime: cameraManager.getCameraState(c._id) }; }
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
  const db = getDb();
  await db.command({ ping: 1 });
  const modelDir = path.resolve(process.env.AWIROS_MODEL_DIR || path.join(config.root, 'cv_worker', 'models', 'awiros_anpr'));
  const paddleDir = path.resolve(process.env.AWIROS_PADDLEOCR_DIR || path.join(config.root, 'cv_worker', 'vendor', 'PaddleOCR'));
  const workerAvailable = fs.existsSync(config.workerScript);
  const indianOcrFilesReady = fs.existsSync(path.join(modelDir, 'model.safetensors'))
    && fs.existsSync(path.join(modelDir, 'en_dict.txt'))
    && fs.existsSync(path.join(paddleDir, 'ppocr', '__init__.py'));
  res.json({
    status: 'ok', database: 'connected',
    alprConfigured: workerAvailable,
    indianOcrFilesReady,
    scannerEngine: process.env.ALPR_ENGINE || 'fast_alpr_india',
    detectorModel: process.env.ALPR_DETECTOR_MODEL || 'yolo-v9-s-608-license-plate-end2end',
    demoMode: config.demoMode, time: new Date().toISOString(),
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

// CNG assets
app.get('/api/assets', async (req, res) => listCollection(res, 'cngAssets', req, ['assetCode', 'serialNumber', 'stationId'], { createdAt: -1 }));
app.post('/api/assets', async (req, res) => {
  const body = validateAssetBody(req.body || {}); const vehicle = await getDb().collection('vehicles').findOne({ _id: body.vehicleId }); if (!vehicle) throw badRequest('Selected vehicle does not exist.');
  const now = new Date(); body.createdAt = now; body.updatedAt = now; const result = await getDb().collection('cngAssets').insertOne(body); const item = await getDb().collection('cngAssets').findOne({ _id: result.insertedId });
  await audit({ entityType: 'CNG_ASSET', entityId: item._id, action: 'CREATE', after: { assetCode: item.assetCode, vehicleId: String(item.vehicleId) } }); res.status(201).json(item);
});
app.get('/api/assets/:id', async (req, res) => { const item = await getDb().collection('cngAssets').findOne({ _id: parseId(req.params.id) }); if (!item) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found.' } }); res.json(item); });
app.patch('/api/assets/:id', async (req, res) => {
  const id = parseId(req.params.id); const before = await getDb().collection('cngAssets').findOne({ _id: id }); if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found.' } });
  const body = validateAssetBody({ ...before, ...req.body, vehicleId: req.body.vehicleId || String(before.vehicleId), assetCode: req.body.assetCode || before.assetCode });
  delete body.recordSource; // provenance is immutable through the ordinary edit form
  body.updatedAt = new Date(); await getDb().collection('cngAssets').updateOne({ _id: id }, { $set: body }); const after = await getDb().collection('cngAssets').findOne({ _id: id });
  await audit({ entityType: 'CNG_ASSET', entityId: id, action: 'UPDATE', before: { assetCode: before.assetCode }, after: { assetCode: after.assetCode } }); res.json(after);
});

// Hydrotests
app.get('/api/hydrotests', async (req, res) => listCollection(res, 'hydrotests', req, ['performedBy', 'certificateReference', 'result', 'notes'], { testDate: -1 }));
app.post('/api/hydrotests', async (req, res) => {
  const body = await validateHydrotestBody(req.body || {}); if (body.certificateReference) { const duplicate = await getDb().collection('hydrotests').findOne({ certificateReference: body.certificateReference }); if (duplicate) throw Object.assign(badRequest('Certificate reference already exists.', 'DUPLICATE_CERTIFICATE'), { status: 409 }); }
  const now = new Date(); body.createdAt = now; body.updatedAt = now; const result = await getDb().collection('hydrotests').insertOne(body); const item = await getDb().collection('hydrotests').findOne({ _id: result.insertedId });
  await audit({ entityType: 'HYDROTEST', entityId: item._id, action: 'CREATE', after: { certificateReference: item.certificateReference, result: item.result } }); res.status(201).json(item);
});
app.get('/api/hydrotests/:id', async (req, res) => { const item = await getDb().collection('hydrotests').findOne({ _id: parseId(req.params.id) }); if (!item) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Hydrotest not found.' } }); res.json(item); });
app.patch('/api/hydrotests/:id', async (req, res) => {
  const id = parseId(req.params.id); const before = await getDb().collection('hydrotests').findOne({ _id: id }); if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Hydrotest not found.' } });
  const body = await validateHydrotestBody({ ...before, ...req.body, assetId: req.body.assetId || String(before.assetId) }); if (body.certificateReference) { const duplicate = await getDb().collection('hydrotests').findOne({ certificateReference: body.certificateReference, _id: { $ne: id } }); if (duplicate) throw Object.assign(badRequest('Certificate reference already exists.', 'DUPLICATE_CERTIFICATE'), { status: 409 }); }
  body.createdAt = before.createdAt; body.updatedAt = new Date(); await getDb().collection('hydrotests').updateOne({ _id: id }, { $set: body }); const after = await getDb().collection('hydrotests').findOne({ _id: id });
  await audit({ entityType: 'HYDROTEST', entityId: id, action: 'UPDATE', before: { result: before.result, nextDueDate: before.nextDueDate }, after: { result: after.result, nextDueDate: after.nextDueDate } }); res.json(after);
});

// Media upload / scanning
async function queueScan(filePath, originalFilename, source) {
  const digest = await hashFile(filePath); const db = getDb(); let media = await db.collection('mediaFiles').findOne({ sha256: digest });
  if (!media) {
    const mediaDoc = { originalFilename: safeString(originalFilename, 240), storageName: path.basename(filePath), storagePath: filePath, mimeType: isVideo(originalFilename) ? 'video/*' : 'image/*', sizeBytes: fs.statSync(filePath).size, sha256: digest, source, recordSource: source === 'DEMO' ? 'DEMO' : 'OPERATOR', createdAt: new Date() };
    try { const r = await db.collection('mediaFiles').insertOne(mediaDoc); media = { ...mediaDoc, _id: r.insertedId }; }
    catch (e) { if (e.code !== 11000) throw e; media = await db.collection('mediaFiles').findOne({ sha256: digest }); }
  }
  const now = new Date(); const scan = { mediaId: media._id, originalFilename: safeString(originalFilename,240), storageName: media.storageName, mediaType: isVideo(originalFilename) ? 'VIDEO' : 'IMAGE', status: 'QUEUED', source, candidates: [], selectedPlate: null, confidence: null, verificationId: null, error: null, recordSource: source === 'DEMO' ? 'DEMO' : 'OPERATOR', createdAt: now, updatedAt: now };
  const r = await db.collection('scans').insertOne(scan); processScan(String(r.insertedId), media.storagePath).catch((err) => console.error(`Scan ${r.insertedId} failed: ${err.message}`));
  return { ...scan, _id: r.insertedId };
}
app.post('/api/scans', upload.array('files', 20), async (req, res) => {
  const files = req.files || []; if (!files.length) throw badRequest('Select at least one image or video.');
  const created = [];
  for (const file of files) created.push(await queueScan(file.path, file.originalname, 'MANUAL_UPLOAD'));
  res.status(202).json({ items: created.map((s) => ({ _id: s._id, status: s.status, originalFilename: s.originalFilename })), message: 'Scan jobs queued. Poll /api/scans/:id for actual progress and results.' });
});
app.post('/api/scans/batch', async (_req, res) => {
  const db = getDb(); fs.mkdirSync(config.suppliedMediaDir, { recursive: true });
  const entries = fs.readdirSync(config.suppliedMediaDir, { withFileTypes: true }).filter((e) => e.isFile() && allowedExt.has(path.extname(e.name).toLowerCase()));
  if (!entries.length) return res.json({ items: [], message: `No supported media files were found in ${path.relative(config.root, config.suppliedMediaDir)}. Add authorized files there or use manual upload.` });
  const known = new Set((await db.collection('scans').find({ source: 'SUPPLIED_FILE' }).project({ originalFilename: 1, mediaId: 1 }).toArray()).map((s) => `${s.originalFilename}:${String(s.mediaId)}`));
  const items = [];
  for (const entry of entries) {
    const filePath = path.join(config.suppliedMediaDir, entry.name);
    // Hash to identify existing media; a new scan job is created only if this exact
    // media file has not already been scanned from the supplied-media folder.
    const digest = await hashFile(filePath); const media = await db.collection('mediaFiles').findOne({ sha256: digest });
    const prior = media ? await db.collection('scans').findOne({ mediaId: media._id, source: 'SUPPLIED_FILE', status: { $in: ['QUEUED','PROCESSING','COMPLETED','REVIEW_REQUIRED','UNREADABLE'] } }) : null;
    if (prior) { items.push({ _id: prior._id, status: prior.status, originalFilename: prior.originalFilename, skipped: true }); continue; }
    items.push(await queueScan(filePath, entry.name, 'SUPPLIED_FILE'));
  }
  res.status(202).json({ items: items.map((s) => ({ _id: s._id, status: s.status, originalFilename: s.originalFilename, skipped: Boolean(s.skipped) })), message: 'Batch scan jobs queued.' });
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
  await db.collection('scans').updateOne({ _id: id }, { $set: { status: 'PROCESSING', startedAt: new Date(), updatedAt: new Date() } });
  try {
    const result = await runScan(filePath);
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
    const scanStatus = ['CONSISTENT_CANDIDATE', 'PLATE_CANDIDATE_FOUND'].includes(result.status)
      ? 'COMPLETED'
      : (candidates.length ? 'REVIEW_REQUIRED' : (['ERROR','INIT_ERROR','UNSUPPORTED_MEDIA'].includes(result.status) ? 'FAILED' : 'UNREADABLE'));
    await db.collection('scans').updateOne({ _id: id }, { $set: {
      status: scanStatus,
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
    await db.collection('scans').updateOne({ _id: id }, { $set: { status: 'FAILED', error: err.message.slice(0, 1000), completedAt: new Date(), updatedAt: new Date() } });
  }
}
async function hashFile(filePath) { const h = crypto.createHash('sha256'); await new Promise((resolve, reject) => { const stream = fs.createReadStream(filePath); stream.on('data', (d) => h.update(d)); stream.on('error', reject); stream.on('end', resolve); }); return h.digest('hex'); }
function isVideo(name) { return ['.mp4', '.avi', '.mov', '.mkv', '.m4v', '.webm'].includes(path.extname(name).toLowerCase()); }

// CCTV config and management. Public responses redact stream URL and credentials.
app.get('/api/cameras', async (_req, res) => { const cameras = await getDb().collection('cameras').find({}).sort({ createdAt: -1 }).toArray(); res.json({ items: cameras.map(cameraPublic) }); });
app.post('/api/cameras', async (req, res) => {
  const cameraName = safeString(req.body.cameraName, 120); const streamUrl = safeString(req.body.streamUrl, 1000);
  if (!cameraName) throw badRequest('Camera name is required.');
  let parsed; try { parsed = new URL(streamUrl); } catch { throw badRequest('Enter a valid camera stream URL.'); }
  if (!['rtsp:', 'rtsps:', 'http:', 'https:'].includes(parsed.protocol)) throw badRequest('Supported stream schemes are RTSP, RTSPS, HTTP and HTTPS.');
  const doc = { cameraName, streamUrl, stationId: safeString(req.body.stationId || 'STATION-DEMO-001', 80), active: true, createdAt: new Date(), updatedAt: new Date(), recordSource: 'OPERATOR' };
  const result = await getDb().collection('cameras').insertOne(doc); const camera = await getDb().collection('cameras').findOne({ _id: result.insertedId });
  await audit({ entityType: 'CAMERA', entityId: camera._id, action: 'CREATE', after: { cameraName } }); res.status(201).json(cameraPublic(camera));
});
app.post('/api/cameras/:id/test', async (req, res) => {
  const id = parseId(req.params.id); const camera = await getDb().collection('cameras').findOne({ _id: id, active: true }); if (!camera) return res.status(404).json({ error: { message: 'Camera not found.' } });
  const result = await cameraManager.testStream(camera.streamUrl, String(camera._id)); res.json({ ...result, cameraName: camera.cameraName, note: 'Connection test only; no pump control.' });
});
app.post('/api/cameras/:id/start', async (req, res) => {
  const id = parseId(req.params.id); const camera = await getDb().collection('cameras').findOne({ _id: id, active: true }); if (!camera) return res.status(404).json({ error: { message: 'Camera not found.' } });
  const result = cameraManager.startCamera(camera, async (cam, event) => {
    const now = new Date();
    const scanDoc = { mediaId: null, originalFilename: `CCTV: ${cam.cameraName}`, storageName: null, mediaType: 'STREAM_FRAME', status: 'COMPLETED', source: 'CCTV', cameraId: cam._id, candidates: event.candidates || [], selectedPlate: event.selectedPlate || null, confidence: event.confidence ?? null, createdAt: now, updatedAt: now, framesProcessed: event.framesProcessed || 1 };
    const inserted = await getDb().collection('scans').insertOne(scanDoc);
    const verification = await verifyPlate({ plate: event.selectedPlate || event.candidatePlate || '', confidence: event.confidence ?? null, scanId: inserted.insertedId, source: 'CCTV', evidence: { cameraId: String(cam._id), timestampSeconds: event.timestampSeconds ?? null, frameIndex: event.frameIndex ?? null, candidates: event.candidates || [] }, manualReview: !event.selectedPlate });
    await getDb().collection('scans').updateOne({ _id: inserted.insertedId }, { $set: { verificationId: verification._id, verificationDecision: verification.decision, verificationExplanation: verification.explanation, vehicleRegistered: verification.vehicleRegistered, hydrotestStatus: verification.hydrotestStatus, fuelingEligibility: verification.fuelingEligibility, linkedAssetCount: verification.linkedAssetCount, allRequiredAssetsValid: verification.allRequiredAssetsValid, updatedAt: new Date() } });
  });
  if (!result.ok) return res.status(409).json({ error: { message: result.message } });
  await getDb().collection('cameras').updateOne({ _id: id }, { $set: { lastStartedAt: new Date(), updatedAt: new Date() } }); res.json({ ...result, camera: cameraPublic(camera) });
});
app.post('/api/cameras/:id/stop', async (req, res) => { const id = parseId(req.params.id); const result = cameraManager.stopCamera(id); if (!result.ok) return res.status(409).json({ error: { message: result.message } }); res.json(result); });
app.patch('/api/cameras/:id', async (req, res) => {
  const id = parseId(req.params.id); const before = await getDb().collection('cameras').findOne({ _id: id }); if (!before) return res.status(404).json({ error: { message: 'Camera not found.' } });
  const set = { updatedAt: new Date() }; if (req.body.cameraName !== undefined) set.cameraName = safeString(req.body.cameraName, 120); if (req.body.stationId !== undefined) set.stationId = safeString(req.body.stationId, 80); if (req.body.active !== undefined) set.active = Boolean(req.body.active);
  if (req.body.streamUrl !== undefined) { let parsed; try { parsed = new URL(req.body.streamUrl); } catch { throw badRequest('Enter a valid camera stream URL.'); } if (!['rtsp:', 'rtsps:', 'http:', 'https:'].includes(parsed.protocol)) throw badRequest('Unsupported stream protocol.'); set.streamUrl = req.body.streamUrl; }
  await getDb().collection('cameras').updateOne({ _id: id }, { $set: set }); const after = await getDb().collection('cameras').findOne({ _id: id }); await audit({ entityType: 'CAMERA', entityId: id, action: 'UPDATE', before: { cameraName: before.cameraName }, after: { cameraName: after.cameraName } }); res.json(cameraPublic(after));
});

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
app.post('/api/demo/seed', async (_req, res) => { if (!config.demoMode || !config.allowDemoSeed) return res.status(403).json({ error: { message: 'Demo seed is disabled by configuration.' } }); res.json(await seedDemoData()); });

app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'API_NOT_FOUND', message: 'API endpoint not found.' } }));
app.use((req, res, next) => { if (req.path.startsWith('/api/')) return next(); res.sendFile(path.join(config.publicDir, 'index.html')); });
app.use(handleError);
module.exports = app;
