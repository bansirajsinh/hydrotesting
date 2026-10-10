const { MongoClient } = require('mongodb');
const config = require('./config');
const { normalizePlate } = require('./domain');
let client;
let database;

async function connectDatabase() {
  if (database) return database;
  client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    appName: 'FuelFlux-CNG-Hydrotest-Verification',
  });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    const candidateDatabase = client.db(config.dbName);
    await backfillNormalizedPlates(candidateDatabase);
    await prepareVehiclePlateIndex(candidateDatabase);
    await createIndexes(candidateDatabase);
    database = candidateDatabase;
    return database;
  } catch (error) {
    database = undefined;
    const failedClient = client;
    client = undefined;
    await failedClient?.close().catch(() => {});
    throw error;
  }
}

async function backfillNormalizedPlates(db) {
  // Backfill legacy records so vehicles entered before plate normalization are
  // still discoverable by scans. Empty/invalid plates are left untouched.
  const cursor = db.collection('vehicles').find({ plateNumber: { $exists: true, $type: 'string' } }).project({ _id: 1, plateNumber: 1, plateNumberNormalized: 1 });
  for await (const vehicle of cursor) {
    const normalized = normalizePlate(vehicle.plateNumber);
    if (!normalized || normalized.length < 7 || normalized.length > 12) continue;
    if (vehicle.plateNumberNormalized !== normalized) {
      await db.collection('vehicles').updateOne({ _id: vehicle._id }, { $set: { plateNumberNormalized: normalized, updatedAt: vehicle.updatedAt || new Date() } });
    }
  }
}

async function prepareVehiclePlateIndex(db) {
  // Earlier project versions created this named unique index without a partial
  // filter. Migrate that exact legacy index so old records lacking normalized
  // values do not make startup fail; duplicate normalized registrations still
  // fail loudly when the replacement unique index is created.
  const collection = db.collection('vehicles');
  const currentIndexes = await collection.indexes();
  const existing = currentIndexes.find((index) => index.name === 'uq_vehicle_plate');
  if (existing && !existing.partialFilterExpression) {
    await collection.dropIndex('uq_vehicle_plate');
  }
}

async function createIndexes(db) {
  await Promise.all([
    db.collection('vehicles').createIndex({ plateNumberNormalized: 1 }, { unique: true, partialFilterExpression: { plateNumberNormalized: { $type: 'string', $gt: '' } }, name: 'uq_vehicle_plate' }),
    db.collection('vehicles').createIndex({ active: 1, stationId: 1 }),
    db.collection('cngAssets').createIndex({ assetCode: 1 }, { unique: true, name: 'uq_asset_code' }),
    db.collection('cngAssets').createIndex({ vehicleId: 1, active: 1 }),
    db.collection('cngAssets').createIndex({ serialNumber: 1 }, { unique: true, partialFilterExpression: { serialNumber: { $type: 'string', $gt: '' } }, name: 'uq_asset_serial' }),
    db.collection('hydrotests').createIndex({ assetId: 1, testDate: -1, createdAt: -1 }),
    db.collection('hydrotests').createIndex({ nextDueDate: 1, result: 1 }),
    db.collection('hydrotests').createIndex({ certificateReference: 1 }, { unique: true, partialFilterExpression: { certificateReference: { $type: 'string', $gt: '' } }, name: 'uq_hydrotest_certificate' }),
    db.collection('mediaFiles').createIndex({ sha256: 1 }, { unique: true, name: 'uq_media_hash' }),
    db.collection('scans').createIndex({ demoId: 1 }, { unique: true, partialFilterExpression: { demoId: { $type: 'string' } }, name: 'uq_demo_scan_id' }),
    db.collection('verifications').createIndex({ demoId: 1 }, { unique: true, partialFilterExpression: { demoId: { $type: 'string' } }, name: 'uq_demo_verification_id' }),
    db.collection('scans').createIndex({ createdAt: -1 }),
    db.collection('scans').createIndex({ status: 1, createdAt: -1 }),
    db.collection('verifications').createIndex({ normalizedPlate: 1, createdAt: -1 }),
    db.collection('verifications').createIndex({ decision: 1, createdAt: -1 }),
    db.collection('cameras').createIndex({ cameraName: 1 }, { unique: true, name: 'uq_camera_name' }),
    db.collection('auditLogs').createIndex({ entityType: 1, entityId: 1, createdAt: -1 }),
  ]);
}
function getDb() {
  if (!database) throw new Error('Database is not connected. Check MongoDB service and .env settings.');
  return database;
}
async function closeDatabase() {
  if (client) await client.close();
  client = undefined;
  database = undefined;
}
module.exports = { connectDatabase, getDb, closeDatabase, createIndexes, backfillNormalizedPlates };
