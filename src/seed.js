const { getDb } = require('./db');
const { normalizePlate, assetStatus, decisionForAssets } = require('./domain');

function dayOffset(n) {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
async function seedDemoData(db = getDb()) {
  const vehicleRows = [
    ['GJ01AB1234', 'DEMO-CAR-001', 'Demo Motors', 'Demo Sedan'],
    ['GJ05CD2345', 'DEMO-CAR-002', 'Demo Motors', 'Demo Hatchback'],
    ['GJ06EF3456', 'DEMO-CAR-003', 'Demo Mobility', 'Demo SUV'],
    ['GJ18GH4567', 'DEMO-CAR-004', 'Demo Motors', 'Demo Crossover'],
    ['GJ01JK5678', 'DEMO-CAR-005', null, null],
    ['GJ05LM6789', 'DEMO-CAR-006', 'Demo Mobility', 'Demo Sedan'],
    ['GJ06NP7890', 'DEMO-CAR-007', 'Demo Motors', 'Demo Van'],
    ['GJ18QR8901', 'DEMO-CAR-008', null, null],
  ];
  const vehicles = {};
  for (const [plate, demoId, make, model] of vehicleRows) {
    const normalized = normalizePlate(plate);
    await db.collection('vehicles').updateOne(
      { demoId },
      { $set: { plateNumber: plate, plateNumberNormalized: normalized, vehicleCategory: 'CNG_CAR', make, model, stationId: 'STATION-DEMO-001', recordSource: 'DEMO', demoId, active: true, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    vehicles[demoId] = await db.collection('vehicles').findOne({ demoId });
  }
  const assets = {};
  for (let i = 0; i < vehicleRows.length; i += 1) {
    const code = `CNG-DEMO-${String(i + 1).padStart(3, '0')}`;
    await db.collection('cngAssets').updateOne(
      { assetCode: code },
      { $set: { assetCode: code, vehicleId: vehicles[vehicleRows[i][1]]._id, stationId: 'STATION-DEMO-001', assetType: 'CNG_CYLINDER', serialNumber: `DEMO-SERIAL-${String(i + 1).padStart(3, '0')}`, manufacturer: 'Demo Manufacturer', installationDate: null, recordSource: 'DEMO', active: true, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    assets[code] = await db.collection('cngAssets').findOne({ assetCode: code });
  }
  const records = [
    ['DEMO-CERT-001-CURRENT', 'CNG-DEMO-001', 'PASS', -180, 180],
    ['DEMO-CERT-001-HISTORY', 'CNG-DEMO-001', 'PASS', -550, -180],
    ['DEMO-CERT-002-CURRENT', 'CNG-DEMO-002', 'PASS', -350, 10],
    ['DEMO-CERT-002-HISTORY', 'CNG-DEMO-002', 'PASS', -720, -350],
    ['DEMO-CERT-003-CURRENT', 'CNG-DEMO-003', 'PASS', -380, -10],
    ['DEMO-CERT-003-HISTORY', 'CNG-DEMO-003', 'PASS', -740, -380],
    ['DEMO-CERT-004-CURRENT', 'CNG-DEMO-004', 'FAIL', -5, 365],
    ['DEMO-CERT-004-HISTORY', 'CNG-DEMO-004', 'PASS', -370, -5],
    ['DEMO-CERT-005-CURRENT', 'CNG-DEMO-005', 'PENDING', -5, 50],
    ['DEMO-CERT-006-CURRENT', 'CNG-DEMO-006', 'PASS', -100, 200],
    ['DEMO-CERT-006-HISTORY', 'CNG-DEMO-006', 'PASS', -465, -100],
    ['DEMO-CERT-007-CURRENT', 'CNG-DEMO-007', 'PASS', -150, 120],
  ];
  for (const [certificateReference, assetCode, result, testOffset, dueOffset] of records) {
    const asset = assets[assetCode];
    await db.collection('hydrotests').updateOne(
      { certificateReference },
      { $set: { assetId: asset._id, vehicleId: asset.vehicleId, testDate: dayOffset(testOffset), nextDueDate: dayOffset(dueOffset), performedBy: 'Demo Inspection Services', result, notes: 'Synthetic record created only for local demonstration; not a real certificate.', certificateReference, reportStorageKey: null, recordSource: 'DEMO', updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
  }
  // Provide a small, clearly labelled scan/decision history so the dashboard,
  // history and review views are populated on first launch. These are synthetic
  // fixtures, not actual OCR observations and do not refer to supplied media.
  const scanFixtures = [
    { demoId: 'DEMO-SCAN-001', vehicleId: 'DEMO-CAR-001', assetCode: 'CNG-DEMO-001', ageDays: 0, confidence: 0.96 },
    { demoId: 'DEMO-SCAN-002', vehicleId: 'DEMO-CAR-002', assetCode: 'CNG-DEMO-002', ageDays: 0, confidence: 0.91 },
    { demoId: 'DEMO-SCAN-003', vehicleId: 'DEMO-CAR-003', assetCode: 'CNG-DEMO-003', ageDays: 1, confidence: 0.94 },
    { demoId: 'DEMO-SCAN-004', vehicleId: 'DEMO-CAR-004', assetCode: 'CNG-DEMO-004', ageDays: 2, confidence: 0.93 },
    { demoId: 'DEMO-SCAN-005', vehicleId: 'DEMO-CAR-005', assetCode: 'CNG-DEMO-005', ageDays: 3, confidence: 0.90 },
    { demoId: 'DEMO-SCAN-008', vehicleId: 'DEMO-CAR-008', assetCode: 'CNG-DEMO-008', ageDays: 4, confidence: 0.88 },
  ];
  const today = new Date().toISOString().slice(0, 10);
  for (const fixture of scanFixtures) {
    const vehicle = vehicles[fixture.vehicleId];
    const asset = assets[fixture.assetCode];
    const latest = await db.collection('hydrotests').find({ assetId: asset._id }).sort({ testDate: -1, createdAt: -1 }).limit(1).next();
    const status = assetStatus(latest, today, 30);
    const decisionInfo = decisionForAssets([status], fixture.confidence, 0.62);
    const candidate = { plate: vehicle.plateNumberNormalized, rawText: vehicle.plateNumber, confidence: fixture.confidence, supportFrames: 3, frameIndices: [4, 8, 12], timestampsSeconds: [0.4, 0.8, 1.2], source: 'ASSUMED_DEMO_DATA' };
    const createdAt = new Date(); createdAt.setUTCDate(createdAt.getUTCDate() - fixture.ageDays);
    const scanDoc = {
      demoId: fixture.demoId, mediaId: null,
      originalFilename: `DEMO ONLY — synthetic fixture, not from footage — ${vehicle.plateNumber}`,
      storageName: null, mediaType: 'DEMO_FIXTURE', status: 'COMPLETED', source: 'DEMO',
      candidates: [candidate], selectedPlate: vehicle.plateNumberNormalized, confidence: fixture.confidence,
      verificationId: null, verificationDecision: decisionInfo.decision,
      verificationExplanation: `Synthetic UI fixture only. ${decisionInfo.decision}; not an actual scan or compliance record.`,
      recordSource: 'DEMO', createdAt, updatedAt: new Date(), framesProcessed: 3, elapsedSeconds: 0.35,
      scanEngine: 'SYNTHETIC_DEMO_FIXTURE', synthetic: true,
    };
    await db.collection('scans').updateOne({ demoId: fixture.demoId }, { $set: scanDoc }, { upsert: true });
    const scan = await db.collection('scans').findOne({ demoId: fixture.demoId });
    const evaluation = { assetId: asset._id, assetCode: asset.assetCode, serialNumber: asset.serialNumber || null, test: latest ? { _id: latest._id, testDate: latest.testDate, nextDueDate: latest.nextDueDate, result: latest.result, performedBy: latest.performedBy, certificateReference: latest.certificateReference, recordSource: latest.recordSource } : null, status };
    const explanationByDecision = {
      DISPENSING_ALLOWED: 'Synthetic demo example only: all linked assets appear valid under demo rules. This is not real compliance evidence.',
      REVIEW_REQUIRED: 'Synthetic demo example: review is required due to due-soon status or uncertainty.',
      DO_NOT_DISPENSE_FAILED: 'Synthetic demo example: the latest linked hydrotest is FAIL.',
      DO_NOT_DISPENSE_OVERDUE: 'Synthetic demo example: the latest linked hydrotest is overdue.',
      HOLD_PENDING_TEST: 'Synthetic demo example: the linked hydrotest is pending.',
      HOLD_NO_HYDROTEST_RECORD: 'Synthetic demo example: no hydrotest record exists for the linked asset.',
    };
    const verificationDoc = {
      demoId: `${fixture.demoId}-VERIFICATION`, scanId: scan._id, source: 'DEMO',
      detectedPlate: vehicle.plateNumber, normalizedPlate: vehicle.plateNumberNormalized,
      confidence: fixture.confidence, vehicleId: vehicle._id, vehiclePlate: vehicle.plateNumber,
      assetEvaluations: [evaluation], decision: decisionInfo.decision, reasonCodes: decisionInfo.reasonCodes,
      explanation: explanationByDecision[decisionInfo.decision] || 'Synthetic demo decision; review the linked records.',
      manualReviewRequired: decisionInfo.decision !== 'DISPENSING_ALLOWED', operatorConfirmed: false,
      vehicleRegistered: true, linkedAssetCount: 1, hydrotestStatus: status, allRequiredAssetsValid: status === 'VALID', fuelingEligibility: decisionInfo.decision === 'DISPENSING_ALLOWED' ? 'ELIGIBLE' : 'NOT_ELIGIBLE',
      recordSource: 'DEMO', synthetic: true, createdAt, updatedAt: createdAt,
    };
    await db.collection('verifications').updateOne({ demoId: verificationDoc.demoId }, { $set: verificationDoc }, { upsert: true });
    const verification = await db.collection('verifications').findOne({ demoId: verificationDoc.demoId });
    await db.collection('scans').updateOne({ _id: scan._id }, { $set: { verificationId: verification._id, verificationDecision: decisionInfo.decision, verificationExplanation: verificationDoc.explanation } });
  }
  const current = await db.collection('vehicles').countDocuments({ recordSource: 'DEMO' });
  const assetCount = await db.collection('cngAssets').countDocuments({ recordSource: 'DEMO' });
  const testCount = await db.collection('hydrotests').countDocuments({ recordSource: 'DEMO' });
  const scanCount = await db.collection('scans').countDocuments({ recordSource: 'DEMO' });
  const verificationCount = await db.collection('verifications').countDocuments({ recordSource: 'DEMO' });
  return { vehicles: current, assets: assetCount, hydrotests: testCount, scans: scanCount, verifications: verificationCount, note: 'All seeded records, including scan history and candidate confidence, are synthetic demo data and are not derived from supplied footage.' };
}

async function resetDemoData(db = getDb()) {
  // Audit rows keep entityId as a string; remove only audit rows referencing
  // records explicitly marked DEMO, leaving operator/live-record audit intact.
  const demoIds = [];
  for (const collectionName of ['vehicles', 'cngAssets', 'hydrotests', 'scans', 'verifications']) {
    const docs = await db.collection(collectionName).find({ recordSource: 'DEMO' }).project({ _id: 1 }).toArray();
    demoIds.push(...docs.map((doc) => String(doc._id)));
  }
  if (demoIds.length) await db.collection('auditLogs').deleteMany({ entityId: { $in: demoIds } });
  await db.collection('verifications').deleteMany({ recordSource: 'DEMO' });
  await db.collection('scans').deleteMany({ recordSource: 'DEMO' });
  await db.collection('hydrotests').deleteMany({ recordSource: 'DEMO' });
  await db.collection('cngAssets').deleteMany({ recordSource: 'DEMO' });
  await db.collection('vehicles').deleteMany({ recordSource: 'DEMO' });
  return seedDemoData(db);
}
module.exports = { seedDemoData, resetDemoData };
