const fs = require('node:fs');
const path = require('node:path');
const { MongoClient, ObjectId } = require('mongodb');
const config = require('./config');
const { normalizePlate } = require('./domain');

let client;
let database;
let isEmbedded = false;

// ─────────────────────────────────────────────────────────────────────────────
// Embedded In-Memory & File-Backed Fallback Database (when MongoDB is offline)
// ─────────────────────────────────────────────────────────────────────────────

function sameVal(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a instanceof ObjectId || b instanceof ObjectId) {
    return String(a) === String(b);
  }
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() === new Date(b).getTime();
  }
  return false;
}

function matchDoc(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;

  for (const [key, expected] of Object.entries(query)) {
    if (key === '$or') {
      if (!Array.isArray(expected)) continue;
      const matched = expected.some((branch) => matchDoc(doc, branch));
      if (!matched) return false;
      continue;
    }

    const actual = doc[key];

    if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof ObjectId) && !(expected instanceof Date) && !(expected instanceof RegExp)) {
      if ('$in' in expected) {
        const arr = expected.$in;
        const inMatch = Array.isArray(arr) && arr.some((target) => sameVal(actual, target));
        if (!inMatch) return false;
        continue;
      }
      if ('$ne' in expected) {
        if (sameVal(actual, expected.$ne)) return false;
        continue;
      }
      if ('$regex' in expected) {
        const rx = new RegExp(expected.$regex, expected.$options || '');
        if (!rx.test(String(actual ?? ''))) return false;
        continue;
      }
      if ('$exists' in expected) {
        const exists = key in doc && doc[key] !== undefined;
        if (Boolean(expected.$exists) !== exists) return false;
        continue;
      }
      if ('$gt' in expected) {
        if (!(actual > expected.$gt)) return false;
        continue;
      }
    }

    if (!sameVal(actual, expected)) {
      return false;
    }
  }

  return true;
}

function getEmbeddedStoragePath() {
  const file = path.resolve(config.root, 'data/embedded-db.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function loadEmbeddedData() {
  const filePath = getEmbeddedStoragePath();
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const col of Object.values(parsed)) {
        for (const doc of col) {
          if (doc._id && typeof doc._id === 'string' && ObjectId.isValid(doc._id)) {
            doc._id = new ObjectId(doc._id);
          }
          for (const [k, v] of Object.entries(doc)) {
            if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
              doc[k] = new Date(v);
            }
          }
        }
      }
      return parsed;
    } catch (e) {
      console.warn('Could not read embedded-db.json, starting fresh:', e.message);
    }
  }
  return {
    vehicles: [],
    cngAssets: [],
    hydrotests: [],
    scans: [],
    verifications: [],
    mediaFiles: [],
    cameras: [],
    auditLogs: [],
  };
}

let embeddedStore = null;

function saveEmbeddedData() {
  if (!embeddedStore) return;
  const filePath = getEmbeddedStoragePath();
  try {
    fs.writeFileSync(filePath, JSON.stringify(embeddedStore, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist embedded database:', err.message);
  }
}

class EmbeddedCursor {
  constructor(docs) {
    this.docs = [...docs];
  }

  sort(sortObj) {
    if (!sortObj) return this;
    const [field, dir] = Object.entries(sortObj)[0] || [];
    if (!field) return this;
    this.docs.sort((a, b) => {
      const valA = a[field] ?? '';
      const valB = b[field] ?? '';
      if (valA < valB) return dir === -1 ? 1 : -1;
      if (valA > valB) return dir === -1 ? -1 : 1;
      return 0;
    });
    return this;
  }

  skip(n) {
    this.docs = this.docs.slice(n);
    return this;
  }

  limit(n) {
    this.docs = this.docs.slice(0, n);
    return this;
  }

  project(proj) {
    if (!proj) return this;
    this.docs = this.docs.map((d) => {
      const out = {};
      for (const k of Object.keys(proj)) {
        out[k] = d[k];
      }
      out._id = d._id;
      return out;
    });
    return this;
  }

  async toArray() {
    return [...this.docs];
  }

  async next() {
    return this.docs.shift() || null;
  }

  async *[Symbol.asyncIterator]() {
    for (const d of this.docs) {
      yield d;
    }
  }
}

class EmbeddedCollection {
  constructor(name) {
    this.name = name;
  }

  _all() {
    if (!embeddedStore[this.name]) {
      embeddedStore[this.name] = [];
    }
    return embeddedStore[this.name];
  }

  find(query = {}) {
    const list = this._all().filter((d) => matchDoc(d, query));
    return new EmbeddedCursor(list);
  }

  async findOne(query = {}, options = {}) {
    const list = this._all().filter((d) => matchDoc(d, query));
    if (options.sort) {
      const c = new EmbeddedCursor(list);
      c.sort(options.sort);
      return c.docs[0] || null;
    }
    return list[0] || null;
  }

  async countDocuments(query = {}) {
    return this._all().filter((d) => matchDoc(d, query)).length;
  }

  async insertOne(doc) {
    const copy = { ...doc };
    if (!copy._id) {
      copy._id = new ObjectId();
    } else if (typeof copy._id === 'string' && ObjectId.isValid(copy._id)) {
      copy._id = new ObjectId(copy._id);
    }
    this._all().push(copy);
    saveEmbeddedData();
    return { insertedId: copy._id };
  }

  async insertMany(docs) {
    const ids = [];
    for (const doc of docs) {
      const r = await this.insertOne(doc);
      ids.push(r.insertedId);
    }
    return { insertedIds: ids };
  }

  async updateOne(filter, update, options = {}) {
    const list = this._all();
    const idx = list.findIndex((d) => matchDoc(d, filter));
    if (idx >= 0) {
      const doc = list[idx];
      if (update.$set) {
        Object.assign(doc, update.$set);
      }
      saveEmbeddedData();
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    }
    if (options.upsert) {
      const newDoc = {
        _id: new ObjectId(),
        ...(filter.demoId ? { demoId: filter.demoId } : {}),
        ...(filter.plateNumber ? { plateNumber: filter.plateNumber } : {}),
        ...(filter.assetCode ? { assetCode: filter.assetCode } : {}),
        ...(update.$setOnInsert || {}),
        ...(update.$set || {}),
      };
      list.push(newDoc);
      saveEmbeddedData();
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: newDoc._id };
    }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }

  async deleteMany(filter = {}) {
    const before = this._all().length;
    embeddedStore[this.name] = this._all().filter((d) => !matchDoc(d, filter));
    saveEmbeddedData();
    return { deletedCount: before - embeddedStore[this.name].length };
  }

  async deleteOne(filter = {}) {
    const list = this._all();
    const idx = list.findIndex((d) => matchDoc(d, filter));
    if (idx >= 0) {
      list.splice(idx, 1);
      saveEmbeddedData();
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  }

  async createIndex() {
    return 'ok';
  }

  async indexes() {
    return [];
  }

  async dropIndex() {
    return true;
  }
}

class EmbeddedDatabase {
  collection(name) {
    return new EmbeddedCollection(name);
  }

  async command(cmd) {
    return { ok: 1 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Connection Interface
// ─────────────────────────────────────────────────────────────────────────────

async function connectDatabase() {
  if (database) return database;

  client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
    appName: 'Hydrotest-Studio',
  });

  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    const candidateDatabase = client.db(config.dbName);
    await backfillNormalizedPlates(candidateDatabase);
    await prepareVehiclePlateIndex(candidateDatabase);
    await createIndexes(candidateDatabase);
    database = candidateDatabase;
    isEmbedded = false;
    console.log(`Connected to external MongoDB database: ${config.dbName}`);
    return database;
  } catch (error) {
    console.warn(`Local MongoDB not running (${error.message}). Activating embedded zero-config data engine.`);
    client = undefined;
    embeddedStore = loadEmbeddedData();
    database = new EmbeddedDatabase();
    isEmbedded = true;
    return database;
  }
}

async function backfillNormalizedPlates(db) {
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
  if (!database) throw new Error('Database is not connected. Call connectDatabase() first.');
  return database;
}

async function closeDatabase() {
  if (client) await client.close();
  client = undefined;
  database = undefined;
}

module.exports = { connectDatabase, getDb, closeDatabase, createIndexes, backfillNormalizedPlates };
