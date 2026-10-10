const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlate, validatePlate, parseDateOnly, assetStatus, decisionForAssets } = require('../src/domain');

test('plate normalization preserves the underlying letters and digits', () => {
  assert.equal(normalizePlate(' gj 01 ab 1234 '), 'GJ01AB1234');
  assert.equal(normalizePlate('GJ01A81234'), 'GJ01A81234');
});
test('supports common Indian and Bharat Series-shaped registration examples', () => {
  assert.equal(validatePlate('GJ01AB1234').ok, true);
  assert.equal(validatePlate('21BH1234AA').ok, true);
  assert.equal(validatePlate('21BH1234IO').ok, false);
  assert.equal(validatePlate('GJ01ABC1234').ok, true);
  assert.equal(validatePlate('GJ01#AB1234').ok, false);
  assert.equal(validatePlate('CAR').ok, false);
});
test('date-only parsing rejects malformed calendar dates', () => {
  assert.equal(parseDateOnly('2026-10-10'), '2026-10-10');
  assert.throws(() => parseDateOnly('2026-02-31'));
  assert.throws(() => parseDateOnly('10/10/2026'));
});
test('asset status follows the documented priority', () => {
  assert.equal(assetStatus(null, '2026-10-10'), 'NO_RECORD');
  assert.equal(assetStatus({ result: 'FAIL', nextDueDate: '2027-12-01' }, '2026-10-10'), 'FAILED');
  assert.equal(assetStatus({ result: 'PENDING', nextDueDate: '2027-12-01' }, '2026-10-10'), 'PENDING');
  assert.equal(assetStatus({ result: 'PASS', nextDueDate: '2026-10-09' }, '2026-10-10'), 'OVERDUE');
  assert.equal(assetStatus({ result: 'PASS', nextDueDate: '2026-10-20' }, '2026-10-10'), 'DUE_SOON');
  assert.equal(assetStatus({ result: 'PASS', nextDueDate: '2027-02-01' }, '2026-10-10'), 'VALID');
});
test('a failed/overdue test cannot be allowed; all valid assets may be allowed only over threshold', () => {
  assert.equal(decisionForAssets(['FAILED'], .99, .62).decision, 'DO_NOT_DISPENSE_FAILED');
  assert.equal(decisionForAssets(['VALID'], .4, .62).decision, 'HOLD_LOW_OCR_CONFIDENCE');
  assert.equal(decisionForAssets(['VALID','VALID'], .99, .62).decision, 'DISPENSING_ALLOWED');
  assert.equal(decisionForAssets(['DUE_SOON'], .99, .62).decision, 'REVIEW_REQUIRED');
});

test('legacy Date and ISO timestamp due dates are normalized safely', () => {
  assert.equal(assetStatus({ result: 'pass', nextDueDate: new Date('2099-01-01T00:00:00.000Z') }, '2026-10-10'), 'VALID');
  assert.equal(assetStatus({ result: 'PASS', nextDueDate: '2026-10-01T00:00:00.000Z' }, '2026-10-10'), 'OVERDUE');
});
test('verification summary separates database hydrotest status from OCR approval', () => {
  const summary = require('../src/domain').summarizeVerification({
    vehicleFound: true,
    evaluations: [{ status: 'VALID' }],
    decision: 'HOLD_LOW_OCR_CONFIDENCE',
  });
  assert.equal(summary.vehicleRegistered, true);
  assert.equal(summary.hydrotestStatus, 'VALID');
  assert.equal(summary.allRequiredAssetsValid, true);
  assert.equal(summary.fuelingEligibility, 'NOT_ELIGIBLE');
});
test('overall status prioritizes safety-blocking linked asset conditions', () => {
  const { overallHydrotestStatus } = require('../src/domain');
  assert.equal(overallHydrotestStatus(['VALID', 'FAILED']), 'FAILED');
  assert.equal(overallHydrotestStatus(['VALID', 'OVERDUE']), 'OVERDUE');
  assert.equal(overallHydrotestStatus(['VALID', 'PENDING']), 'PENDING');
  assert.equal(overallHydrotestStatus([]), 'NO_RECORD');
});
