const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { verifyPlate } = require('../src/services/verification');

function same(a, b) {
  if (a && typeof a.toString === 'function' && b && typeof b.toString === 'function') return a.toString() === b.toString();
  return a === b;
}
function matches(doc, query) {
  return Object.entries(query || {}).every(([key, expected]) => {
    const actual = doc[key];
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected)) {
      if ('$ne' in expected && actual === expected.$ne) return false;
      if ('$in' in expected && !expected.$in.some((item) => same(item, actual))) return false;
      return true;
    }
    return same(actual, expected);
  });
}
class FakeCursor {
  constructor(rows) { this.rows = [...rows]; this.maximum = Infinity; }
  project() { return this; }
  sort(spec) {
    const [field, direction] = Object.entries(spec)[0] || [];
    if (field) this.rows.sort((a, b) => String(a[field] || '').localeCompare(String(b[field] || '')) * direction);
    return this;
  }
  limit(count) { this.maximum = count; return this; }
  async toArray() { return this.rows.slice(0, this.maximum); }
  async next() { return this.rows.slice(0, this.maximum)[0] || null; }
}
class FakeCollection {
  constructor(name, rows) { this.name = name; this.rows = rows; }
  async findOne(query) { return this.rows.find((row) => matches(row, query)) || null; }
  find(query) { return new FakeCursor(this.rows.filter((row) => matches(row, query))); }
  async insertOne(doc) { const _id = new ObjectId(); this.rows.push({ ...doc, _id }); return { insertedId: _id }; }
}
function fakeDatabase({ vehicles, assets, hydrotests }) {
  const state = {
    vehicles: vehicles || [],
    cngAssets: assets || [],
    hydrotests: hydrotests || [],
    verifications: [],
  };
  return {
    state,
    collection(name) {
      if (!state[name]) state[name] = [];
      return new FakeCollection(name, state[name]);
    },
  };
}
function fixture(testRecord) {
  const vehicleId = new ObjectId();
  const assetId = new ObjectId();
  const vehicle = {
    _id: vehicleId,
    plateNumber: 'GJ01AB1234',
    plateNumberNormalized: 'GJ01AB1234',
    vehicleCategory: 'CNG_CAR',
    stationId: 'STATION-DEMO-001',
    active: true,
    recordSource: 'TEST_FIXTURE',
  };
  const asset = {
    _id: assetId,
    vehicleId,
    assetCode: 'CNG-TEST-001',
    serialNumber: 'SERIAL-TEST-001',
    active: true,
  };
  const hydrotests = testRecord ? [{
    _id: new ObjectId(), assetId, vehicleId,
    testDate: '2026-01-01', nextDueDate: '2099-01-01',
    result: testRecord.result, performedBy: 'Fixture Provider',
    certificateReference: 'TEST-CERT-001', recordSource: 'TEST_FIXTURE', createdAt: new Date(),
  }] : [];
  const db = fakeDatabase({ vehicles: [vehicle], assets: [asset], hydrotests });
  return { db, vehicle, asset };
}
const deps = (db) => ({ db, audit: async () => {} });

test('registered vehicle with current PASS record is eligible when plate confidence is accepted', async () => {
  const { db, vehicle } = fixture({ result: 'PASS' });
  const result = await verifyPlate({ plate: 'GJ01AB1234', confidence: 0.99 }, deps(db));
  assert.equal(String(result.vehicle._id), String(vehicle._id));
  assert.equal(result.vehicleRegistered, true);
  assert.equal(result.hydrotestStatus, 'VALID');
  assert.equal(result.decision, 'DISPENSING_ALLOWED');
  assert.equal(result.fuelingEligibility, 'ELIGIBLE');
  assert.equal(result.assetEvaluations[0].test.result, 'PASS');
});

test('registered vehicle with FAIL record is blocked even when due date is future', async () => {
  const { db } = fixture({ result: 'FAIL' });
  const result = await verifyPlate({ plate: 'GJ01AB1234', confidence: 0.99 }, deps(db));
  assert.equal(result.vehicleRegistered, true);
  assert.equal(result.hydrotestStatus, 'FAILED');
  assert.equal(result.decision, 'DO_NOT_DISPENSE_FAILED');
  assert.equal(result.fuelingEligibility, 'NOT_ELIGIBLE');
});

test('registered vehicle without a hydrotest record is held', async () => {
  const { db } = fixture(null);
  const result = await verifyPlate({ plate: 'GJ01AB1234', confidence: 0.99 }, deps(db));
  assert.equal(result.vehicleRegistered, true);
  assert.equal(result.hydrotestStatus, 'NO_RECORD');
  assert.equal(result.decision, 'HOLD_NO_HYDROTEST_RECORD');
  assert.equal(result.fuelingEligibility, 'NOT_ELIGIBLE');
});

test('low-confidence video candidate still returns registered vehicle and hydrotest details but never allows fueling', async () => {
  const { db } = fixture({ result: 'PASS' });
  const result = await verifyPlate({ plate: 'GJ01AB1234', confidence: 0.35, manualReview: true }, deps(db));
  assert.equal(result.vehicleRegistered, true);
  assert.equal(result.hydrotestStatus, 'VALID');
  assert.equal(result.allRequiredAssetsValid, true);
  assert.equal(result.decision, 'HOLD_LOW_OCR_CONFIDENCE');
  assert.equal(result.fuelingEligibility, 'NOT_ELIGIBLE');
});

test('legacy vehicle record with formatted plate and missing active/normalized fields can still be found', async () => {
  const vehicleId = new ObjectId();
  const legacyVehicle = { _id: vehicleId, plateNumber: 'gj 01 ab 1234', vehicleCategory: 'CNG_CAR' };
  const db = fakeDatabase({ vehicles: [legacyVehicle], assets: [], hydrotests: [] });
  const result = await verifyPlate({ plate: 'GJ01AB1234', confidence: 0.99 }, deps(db));
  assert.equal(result.vehicleRegistered, true);
  assert.equal(String(result.vehicle._id), String(vehicleId));
  assert.equal(result.decision, 'HOLD_ASSET_LINK_MISSING');
});
