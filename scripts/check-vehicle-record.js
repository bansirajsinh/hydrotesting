#!/usr/bin/env node
/**
 * Read-only smoke test: look up a plate in MongoDB and evaluate its linked
 * hydrotest records using the same domain rules as the application. This checks
 * database/model-independent verification logic; it does not scan video or write
 * a verification event.
 */
require('dotenv').config();
const config = require('../src/config');
const { connectDatabase, closeDatabase } = require('../src/db');
const { normalizePlate, validatePlate, assetStatus, decisionForAssets } = require('../src/domain');

async function findVehicle(db, normalized) {
  const vehicles = db.collection('vehicles');
  const indexed = await vehicles.findOne({ plateNumberNormalized: normalized, active: { $ne: false } });
  if (indexed) return indexed;
  const legacy = await vehicles.find({ active: { $ne: false } })
    .project({ _id: 1, plateNumber: 1, plateNumberNormalized: 1, vehicleCategory: 1, stationId: 1, active: 1, recordSource: 1 })
    .toArray();
  return legacy.find((vehicle) => normalizePlate(vehicle.plateNumber || vehicle.plateNumberNormalized || '') === normalized) || null;
}

async function main() {
  const raw = process.argv[2];
  if (!raw) throw new Error('Usage: npm run check:plate -- GJ01AB1234');
  const validation = validatePlate(raw);
  const normalized = normalizePlate(raw);
  if (!normalized || normalized.length < 7 || normalized.length > 12) throw new Error('Enter a plausible registration number.');
  const db = await connectDatabase();
  const vehicle = await findVehicle(db, normalized);
  if (!vehicle) {
    console.log(JSON.stringify({ plate: normalized, registered: false, decision: 'HOLD_VEHICLE_NOT_FOUND', validation: validation.ok ? 'FORMAT_VALID' : 'FORMAT_UNSUPPORTED' }, null, 2));
    process.exitCode = 2;
    return;
  }

  const assets = await db.collection('cngAssets').find({ vehicleId: vehicle._id, active: { $ne: false } }).toArray();
  const today = new Date().toISOString().slice(0, 10);
  const evaluations = [];
  for (const asset of assets) {
    const latest = await db.collection('hydrotests').find({ assetId: asset._id }).sort({ testDate: -1, createdAt: -1 }).limit(1).next();
    evaluations.push({
      assetCode: asset.assetCode,
      serialNumber: asset.serialNumber || null,
      result: latest?.result || 'NO_RECORD',
      testDate: latest?.testDate || null,
      nextDueDate: latest?.nextDueDate || null,
      certificateReference: latest?.certificateReference || null,
      status: assetStatus(latest, today, config.dueSoonDays),
      recordSource: latest?.recordSource || asset.recordSource || 'UNKNOWN',
    });
  }
  const decision = decisionForAssets(evaluations.map((e) => e.status), 0.99, config.ocrMinConfidence);
  const result = {
    plate: normalized,
    registrationFormat: validation.ok ? 'FORMAT_VALID' : 'FORMAT_UNSUPPORTED_FOR_AUTOMATIC_APPROVAL',
    registered: true,
    vehicle: { plateNumber: vehicle.plateNumber || normalized, category: vehicle.vehicleCategory || 'UNKNOWN', stationId: vehicle.stationId || null, recordSource: vehicle.recordSource || 'UNKNOWN', active: vehicle.active !== false },
    assets: evaluations,
    decision: validation.ok ? decision.decision : 'HOLD_PLATE_UNREADABLE',
    reasonCodes: validation.ok ? decision.reasonCodes : ['PLATE_FORMAT_UNSUPPORTED'],
    note: 'Read-only database smoke test; assumes the typed plate was independently confirmed. It does not run OCR or verify certificate authenticity.',
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.decision !== 'DISPENSING_ALLOWED') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Database plate check failed: ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await closeDatabase().catch(() => {});
});
