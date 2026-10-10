const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const config = require('../config');
const { normalizePlate, validatePlate, assetStatus, decisionForAssets, summarizeVerification } = require('../domain');
const { audit } = require('./audit');

/**
 * Look up an active vehicle by canonical plate key. The indexed query is the
 * normal fast path. The slower normalization scan is a compatibility fallback
 * for legacy records that pre-date plateNumberNormalized migration.
 */
async function findRegisteredVehicle(db, normalizedPlate) {
  if (!normalizedPlate) return null;
  const collection = db.collection('vehicles');
  const indexed = await collection.findOne({
    plateNumberNormalized: normalizedPlate,
    active: { $ne: false },
  });
  if (indexed) return indexed;

  // Old documents might have a plate with lowercase letters or separators and
  // no normalized field. This fallback is only reached after the indexed miss.
  const legacy = await collection.find({ active: { $ne: false } })
    .project({ _id: 1, plateNumber: 1, plateNumberNormalized: 1, vehicleCategory: 1, make: 1, model: 1, stationId: 1, recordSource: 1, active: 1 })
    .toArray();
  return legacy.find((vehicle) => normalizePlate(vehicle.plateNumber || vehicle.plateNumberNormalized || '') === normalizedPlate) || null;
}

async function getAssetEvaluations(db, vehicle) {
  const assets = await db.collection('cngAssets').find({
    vehicleId: vehicle._id,
    active: { $ne: false },
  }).toArray();

  const evaluations = [];
  for (const asset of assets) {
    const latest = await db.collection('hydrotests')
      .find({ assetId: asset._id })
      .sort({ testDate: -1, createdAt: -1 })
      .limit(1)
      .next();

    evaluations.push({
      assetId: asset._id,
      assetCode: asset.assetCode,
      serialNumber: asset.serialNumber || null,
      test: latest ? {
        _id: latest._id,
        testDate: latest.testDate,
        nextDueDate: latest.nextDueDate,
        result: latest.result,
        performedBy: latest.performedBy,
        certificateReference: latest.certificateReference,
        recordSource: latest.recordSource || 'UNKNOWN',
      } : null,
      status: assetStatus(latest, new Date().toISOString().slice(0, 10), config.dueSoonDays),
    });
  }
  return evaluations;
}

/**
 * Verify an observed/corrected plate against current MongoDB records.
 * Optional deps are provided for deterministic unit tests; production callers
 * omit them and use the live database/audit service.
 */
async function verifyPlate({
  plate,
  confidence,
  scanId = null,
  source = 'MANUAL_UPLOAD',
  evidence = null,
  manualReview = false,
  operatorConfirmed = false,
  reviewReason = null,
}, deps = {}) {
  const db = deps.db || getDb();
  const auditFn = deps.audit || audit;
  const normalizedPlate = normalizePlate(plate);
  const validation = validatePlate(plate);
  const relaxedManual = operatorConfirmed && /^[A-Z0-9]{7,12}$/.test(normalizedPlate);
  const syntaxAccepted = validation.ok || relaxedManual;
  const isPlausibleForLookup = /^[A-Z0-9]{7,12}$/.test(normalizedPlate);
  const lowConfidence = confidence == null || Number(confidence) < config.ocrMinConfidence;
  const createdAt = new Date();
  let vehicle = null;
  let evaluations = [];
  let decision;
  let reasonCodes;
  let explanation;

  if (!isPlausibleForLookup) {
    decision = 'HOLD_PLATE_UNREADABLE';
    reasonCodes = ['PLATE_MISSING_OR_TOO_SHORT'];
    explanation = validation.message || 'No plausible registration plate could be read.';
  } else {
    // Look up even when the OCR format is uncertain. This lets the operator see
    // a possible registered vehicle and its real stored hydrotest status, while
    // keeping the final decision on HOLD until identity is accepted.
    vehicle = await findRegisteredVehicle(db, normalizedPlate);
    if (vehicle) evaluations = await getAssetEvaluations(db, vehicle);

    if (!syntaxAccepted && !operatorConfirmed) {
      decision = 'HOLD_PLATE_UNREADABLE';
      reasonCodes = ['PLATE_FORMAT_UNSUPPORTED'];
      explanation = `${validation.message || 'The detected plate format is not supported.'}${vehicle ? ' A possible database match is shown for manual review only.' : ''}`;
    } else if (!vehicle) {
      decision = lowConfidence && !operatorConfirmed ? 'HOLD_LOW_OCR_CONFIDENCE' : 'HOLD_VEHICLE_NOT_FOUND';
      reasonCodes = [decision === 'HOLD_LOW_OCR_CONFIDENCE' ? 'LOW_OCR_CONFIDENCE_NO_TRUSTED_MATCH' : 'NO_ACTIVE_VEHICLE_MATCH'];
      explanation = decision === 'HOLD_LOW_OCR_CONFIDENCE'
        ? 'The plate candidate is too uncertain for a trusted vehicle lookup.'
        : 'No active vehicle record matches this plate. Register or review the vehicle before proceeding.';
    } else if (vehicle.active === false) {
      decision = 'HOLD_VEHICLE_NOT_FOUND';
      reasonCodes = ['VEHICLE_INACTIVE'];
      explanation = 'The matching vehicle record is inactive.';
    } else if (lowConfidence && !operatorConfirmed) {
      decision = 'HOLD_LOW_OCR_CONFIDENCE';
      reasonCodes = ['LOW_OCR_CONFIDENCE'];
      explanation = 'A registered vehicle and its hydrotest records were found, but the plate is not confident enough for automatic fueling approval. Review the source frame.';
    } else if (manualReview && !operatorConfirmed) {
      decision = 'REVIEW_REQUIRED';
      reasonCodes = ['MULTI_FRAME_CONSENSUS_NOT_MET'];
      explanation = 'A possible registered vehicle and its hydrotest records are shown, but the video scan did not meet the automatic identity-confirmation policy.';
    } else {
      // Manual confirmation is allowed only through the review endpoint which
      // validates the corrected plate and requires a non-empty reason. Keep the
      // originally observed confidence in the stored record for auditability.
      const effectiveConfidence = operatorConfirmed ? config.ocrMinConfidence : Number(confidence);
      const result = decisionForAssets(evaluations.map((evaluation) => evaluation.status), effectiveConfidence, config.ocrMinConfidence);
      decision = result.decision;
      reasonCodes = operatorConfirmed ? [...result.reasonCodes, 'PLATE_CONFIRMED_BY_OPERATOR'] : result.reasonCodes;
      explanation = explanationForDecision(decision, evaluations);
    }
  }

  const summary = summarizeVerification({ vehicleFound: Boolean(vehicle && vehicle.active !== false), evaluations, decision });
  const recordSource = (vehicle?.recordSource === 'DEMO' || evaluations.some((evaluation) => evaluation.test?.recordSource === 'DEMO')) ? 'DEMO' : 'LIVE_RECORDS';
  const doc = {
    scanId: scanId && ObjectId.isValid(String(scanId)) ? new ObjectId(String(scanId)) : null,
    source,
    detectedPlate: String(plate || ''),
    normalizedPlate,
    confidence: confidence == null ? null : Number(confidence),
    vehicleId: vehicle?._id || null,
    vehiclePlate: vehicle?.plateNumber || null,
    assetEvaluations: evaluations,
    decision,
    reasonCodes,
    explanation,
    ...summary,
    operatorConfirmed: Boolean(operatorConfirmed),
    reviewReason: reviewReason || null,
    manualReviewRequired: decision !== 'DISPENSING_ALLOWED',
    evidence: evidence || null,
    recordSource,
    createdAt,
    updatedAt: createdAt,
  };

  const inserted = await db.collection('verifications').insertOne(doc);
  await auditFn({
    entityType: 'VERIFICATION',
    entityId: inserted.insertedId,
    action: operatorConfirmed ? 'OPERATOR_CONFIRMED_PLATE' : 'DECISION_CREATED',
    reason: reviewReason,
    after: { decision, reasonCodes, normalizedPlate, vehicleRegistered: summary.vehicleRegistered, hydrotestStatus: summary.hydrotestStatus },
    correlationId: scanId,
  });
  return { ...doc, _id: inserted.insertedId, vehicle: vehicle ? sanitizeVehicle(vehicle) : null, assets: evaluations };
}

function sanitizeVehicle(vehicle) {
  return {
    _id: vehicle._id,
    plateNumber: vehicle.plateNumber || vehicle.plateNumberNormalized || null,
    plateNumberNormalized: normalizePlate(vehicle.plateNumberNormalized || vehicle.plateNumber || ''),
    vehicleCategory: vehicle.vehicleCategory || 'UNKNOWN',
    make: vehicle.make || null,
    model: vehicle.model || null,
    stationId: vehicle.stationId || null,
    recordSource: vehicle.recordSource || 'OPERATOR',
    active: vehicle.active !== false,
  };
}

function explanationForDecision(decision, evaluations) {
  const messages = {
    DISPENSING_ALLOWED: 'The plate passed the configured identity checks and every required active CNG asset has a current passing hydrotest record in the database.',
    DO_NOT_DISPENSE_FAILED: 'At least one linked active CNG asset has a latest hydrotest result of FAIL.',
    DO_NOT_DISPENSE_OVERDUE: 'At least one linked active CNG asset has an overdue hydrotest.',
    HOLD_NO_HYDROTEST_RECORD: 'At least one required active CNG asset has no hydrotest record.',
    HOLD_PENDING_TEST: 'At least one linked active CNG asset has a PENDING hydrotest.',
    REVIEW_REQUIRED: 'The database records require operator review because identity evidence or hydrotest data is uncertain.',
    HOLD_ASSET_LINK_MISSING: 'No active CNG asset is linked to the registered vehicle.',
    HOLD_VEHICLE_NOT_FOUND: 'No active vehicle record matches the detected plate.',
    HOLD_LOW_OCR_CONFIDENCE: 'The registered record may be shown, but OCR confidence is below the automatic approval threshold.',
    HOLD_PLATE_UNREADABLE: 'The plate could not be accepted as a supported registration format.',
  };
  const statusList = evaluations.map((evaluation) => `${evaluation.assetCode || 'CNG asset'}: ${evaluation.status}`).join('; ');
  return `${messages[decision] || `Decision: ${decision}. Review the linked records before continuing.`}${statusList ? ` Asset status: ${statusList}.` : ''}`;
}

module.exports = { verifyPlate, explanationForDecision, findRegisteredVehicle, getAssetEvaluations };
