const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { connectDatabase, closeDatabase } = require('../src/db');

let server;
let baseUrl;

test.before(async () => {
  await connectDatabase();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDatabase();
});

test('GET /api/hydrotests/summary returns compliant category counts', async () => {
  const res = await fetch(`${baseUrl}/api/hydrotests/summary`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(typeof data.totalAssets === 'number');
  assert.ok(typeof data.valid === 'number');
  assert.ok(typeof data.dueSoon === 'number');
  assert.ok(typeof data.overdue === 'number');
  assert.ok(typeof data.failed === 'number');
  assert.ok(typeof data.pending === 'number');
  assert.ok(typeof data.noRecord === 'number');
});

test('GET /api/hydrotests/assets lists assets', async () => {
  const res = await fetch(`${baseUrl}/api/hydrotests/assets`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.items));
  assert.ok(data.items.length >= 8, 'Should have at least 8 assets as required by specification');
});

test('GET /api/hydrotests/records lists hydrotest records', async () => {
  const res = await fetch(`${baseUrl}/api/hydrotests/records`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.items));
  assert.ok(data.items.length >= 12, 'Should have at least 12 records as required by specification');
});

test('POST /api/hydrotests/records rejects nextDueDate earlier than testDate', async () => {
  const assetsRes = await fetch(`${baseUrl}/api/hydrotests/assets?pageSize=1`);
  const assetsData = await assetsRes.json();
  const assetId = assetsData.items[0]._id;

  const res = await fetch(`${baseUrl}/api/hydrotests/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      assetId,
      testDate: '2026-10-15',
      nextDueDate: '2025-10-15', // Earlier than testDate!
      performedBy: 'Test Quality Labs',
      result: 'PASS',
      certificateReference: `TEST-INV-${Date.now()}`
    })
  });

  assert.equal(res.status, 400);
  const errData = await res.json();
  assert.match(errData.error.message, /next due date cannot be earlier/i);
});

test('POST and PATCH /api/hydrotests/records creates and updates record preserving timestamps', async () => {
  const assetsRes = await fetch(`${baseUrl}/api/hydrotests/assets?pageSize=1`);
  const assetsData = await assetsRes.json();
  const assetId = assetsData.items[0]._id;
  const certRef = `CERT-AUTO-${Date.now()}`;

  // 1. Create record
  const createRes = await fetch(`${baseUrl}/api/hydrotests/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      assetId,
      testDate: '2026-05-10',
      nextDueDate: '2029-05-10',
      performedBy: 'National Gas Testing Authority',
      result: 'PASS',
      certificateReference: certRef,
      notes: 'Automated test suite verification entry'
    })
  });

  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.certificateReference, certRef);
  assert.equal(created.result, 'PASS');
  assert.ok(created.createdAt);
  assert.ok(created.updatedAt);

  // 2. Retrieve by ID
  const getRes = await fetch(`${baseUrl}/api/hydrotests/records/${created._id}`);
  assert.equal(getRes.status, 200);
  const fetched = await getRes.json();
  assert.equal(fetched._id, created._id);

  // 3. Reject duplicate certificate
  const dupRes = await fetch(`${baseUrl}/api/hydrotests/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      assetId,
      testDate: '2026-06-01',
      nextDueDate: '2029-06-01',
      performedBy: 'Other Lab',
      result: 'PASS',
      certificateReference: certRef
    })
  });
  assert.equal(dupRes.status, 409);

  // 4. Update record via PATCH
  const patchRes = await fetch(`${baseUrl}/api/hydrotests/records/${created._id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      notes: 'Updated test notes via automated test'
    })
  });

  assert.equal(patchRes.status, 200);
  const updated = await patchRes.json();
  assert.equal(updated.notes, 'Updated test notes via automated test');
  assert.equal(updated.createdAt, created.createdAt);
});
