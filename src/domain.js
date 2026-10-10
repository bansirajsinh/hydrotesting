const PLATE_PATTERN = /^(?:[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{1,4}|[0-9]{2}BH[0-9]{4}[A-HJ-NP-Z]{1,2})$/;
const RESULTS = new Set(['PASS', 'FAIL', 'PENDING']);
function normalizePlate(value) {
  return String(value || '').toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
}
function validatePlate(value) {
  const raw = String(value || '').trim();
  const normalized = normalizePlate(raw);
  if (!normalized) return { ok: false, normalized, message: 'Registration number is required.' };
  if (!/^[A-Z0-9\s-]+$/i.test(raw)) return { ok: false, normalized, message: 'Use only letters, digits, spaces, or hyphens in a registration number.' };
  if (normalized.length < 7 || normalized.length > 11) return { ok: false, normalized, message: 'Enter a supported Indian registration format (7–11 letters/digits after removing spaces and hyphens).' };
  if (!PLATE_PATTERN.test(normalized)) return { ok: false, normalized, message: 'Registration format is not recognized. Check state/RTO code, series and digits; special/legacy formats may require manual review.' };
  return { ok: true, normalized, message: null };
}
function parseDateOnly(value, field = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must use YYYY-MM-DD format.`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new Error(`${field} is not a valid calendar date.`);
  return value;
}
function compareDateOnly(a, b) { return dateOnlyValue(a).localeCompare(dateOnlyValue(b)); }
function dateOnlyValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      try { return parseDateOnly(value, 'date'); } catch { return ''; }
    }
    // Accept legacy ISO timestamps returned by older database schemas.
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return '';
}
function daysBetween(today, dueDate) {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${dueDate}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}
function assetStatus(test, today = new Date().toISOString().slice(0, 10), dueSoonDays = 30) {
  if (!test) return 'NO_RECORD';
  const result = String(test.result || '').trim().toUpperCase();
  if (!RESULTS.has(result)) return 'REVIEW_REQUIRED';
  if (result === 'FAIL') return 'FAILED';
  if (result === 'PENDING') return 'PENDING';
  const dueDate = dateOnlyValue(test.nextDueDate);
  if (!dueDate) return 'REVIEW_REQUIRED';
  const days = daysBetween(dateOnlyValue(today), dueDate);
  if (days < 0) return 'OVERDUE';
  if (days <= dueSoonDays) return 'DUE_SOON';
  return 'VALID';
}
function decisionForAssets(statuses, identityConfidence, threshold = 0.62) {
  if (identityConfidence == null || identityConfidence < threshold) return { decision: 'HOLD_LOW_OCR_CONFIDENCE', reasonCodes: ['LOW_OCR_CONFIDENCE'] };
  if (!statuses.length) return { decision: 'HOLD_ASSET_LINK_MISSING', reasonCodes: ['NO_ACTIVE_CNG_ASSET'] };
  if (statuses.includes('NO_RECORD')) return { decision: 'HOLD_NO_HYDROTEST_RECORD', reasonCodes: ['HYDROTEST_RECORD_MISSING'] };
  if (statuses.includes('FAILED')) return { decision: 'DO_NOT_DISPENSE_FAILED', reasonCodes: ['LATEST_TEST_FAILED'] };
  if (statuses.includes('OVERDUE')) return { decision: 'DO_NOT_DISPENSE_OVERDUE', reasonCodes: ['HYDROTEST_OVERDUE'] };
  if (statuses.includes('PENDING')) return { decision: 'HOLD_PENDING_TEST', reasonCodes: ['TEST_PENDING'] };
  if (statuses.includes('REVIEW_REQUIRED')) return { decision: 'REVIEW_REQUIRED', reasonCodes: ['CONFLICTING_OR_INVALID_TEST_DATA'] };
  if (statuses.includes('DUE_SOON')) return { decision: 'REVIEW_REQUIRED', reasonCodes: ['TEST_DUE_SOON_REVIEW_POLICY'] };
  if (statuses.every((s) => s === 'VALID')) return { decision: 'DISPENSING_ALLOWED', reasonCodes: ['ALL_LINKED_ASSETS_HAVE_CURRENT_PASSING_TESTS'] };
  return { decision: 'REVIEW_REQUIRED', reasonCodes: ['UNHANDLED_STATUS_COMBINATION'] };
}

function overallHydrotestStatus(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) return 'NO_RECORD';
  const priority = ['FAILED', 'OVERDUE', 'NO_RECORD', 'PENDING', 'REVIEW_REQUIRED', 'DUE_SOON', 'VALID'];
  for (const status of priority) if (statuses.includes(status)) return status;
  return 'REVIEW_REQUIRED';
}
function summarizeVerification({ vehicleFound, evaluations = [], decision = 'REVIEW_REQUIRED' }) {
  const statuses = evaluations.map((item) => item.status || 'NO_RECORD');
  const hydrotestStatus = overallHydrotestStatus(statuses);
  const allAssetsValid = statuses.length > 0 && statuses.every((status) => status === 'VALID');
  return {
    vehicleRegistered: Boolean(vehicleFound),
    linkedAssetCount: evaluations.length,
    hydrotestStatus,
    allRequiredAssetsValid: allAssetsValid,
    fuelingEligibility: decision === 'DISPENSING_ALLOWED' && vehicleFound && allAssetsValid ? 'ELIGIBLE' : 'NOT_ELIGIBLE',
  };
}

function isAllowedResult(result) { return RESULTS.has(result); }
module.exports = { normalizePlate, validatePlate, parseDateOnly, dateOnlyValue, compareDateOnly, daysBetween, assetStatus, decisionForAssets, overallHydrotestStatus, summarizeVerification, isAllowedResult, PLATE_PATTERN };
