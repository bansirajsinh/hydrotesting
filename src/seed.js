const { getDb } = require('./db');
const { normalizePlate, assetStatus, decisionForAssets } = require('./domain');

function dayOffset(n) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function seedDemoData(db = getDb()) {
  const vehicleRows = [
    ['RJ14CV0002', 'DEMO-LIVE-KIA', 'Kia', 'Seltos HTX CNG', 'CNG_CAR', 'Rajesh Sharma'],
    ['HR26CE7674', 'DEMO-LIVE-HYUNDAI', 'Hyundai', 'i20 Magna CNG', 'CNG_CAR', 'Amit Verma'],
    ['DL3CBD3885', 'DEMO-V4-CAR', 'Maruti Suzuki', 'Wagon R LXi CNG', 'CNG_CAR', 'Suresh Kumar'],
    ['GJ06QA2032', 'DEMO-V5-AUTO', 'Bajaj Auto', 'RE 4S CNG Auto-rickshaw', 'CNG_COMMERCIAL', 'Ramesh Patel'],
    ['GJ01AB1234', 'DEMO-V1-CAR', 'Hyundai', 'Grand i10 Nios CNG', 'CNG_CAR', 'Kishore Jani'],
    ['MH12DE1433', 'DEMO-V2-TRUCK', 'Tata Motors', '407 CNG Tanker', 'CNG_COMMERCIAL', 'Western Fleet Logistics'],
    ['RJ14SB1234', 'DEMO-V3-VAN', 'Maruti Suzuki', 'Eeco 5-Str CNG', 'CNG_VAN', 'Sunil Shekhawat'],
    ['MH01AV8866', 'DEMO-CAR-008', 'Maruti Suzuki', 'Ertiga VXi CNG', 'CNG_CAR', 'Pooja Mehta'],
    ['GJ05CD2345', 'DEMO-CAR-009', 'Tata Motors', 'Tiago iCNG', 'CNG_CAR', 'Vikram Desai'],
    ['GJ18QR8901', 'DEMO-CAR-010', 'Maruti Suzuki', 'Alto K10 VXi CNG', 'CNG_CAR', 'Deepak Joshi'],
    ['DL01XY9999', 'DEMO-CAR-011', 'Mahindra', 'Supro CNG Maxi Truck', 'CNG_COMMERCIAL', 'Capital Deliveries'],
    ['GJ01FU4738', 'DEMO-V6-BREZZA', 'Maruti Suzuki', 'Brezza ZXi CNG', 'CNG_CAR', 'Station Verified Fleet'],
  ];

  const vehicles = {};
  for (const [plate, demoId, make, model, category, owner] of vehicleRows) {
    const normalized = normalizePlate(plate);
    await db.collection('vehicles').updateOne(
      { demoId },
      {
        $set: {
          plateNumber: plate,
          plateNumberNormalized: normalized,
          vehicleCategory: category || 'CNG_CAR',
          make,
          model,
          owner: owner || 'Fleet Operator',
          stationId: 'STATION-DEMO-001',
          recordSource: 'DEMO',
          demoId,
          active: true,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
    vehicles[demoId] = await db.collection('vehicles').findOne({ demoId });
  }

  const assetRows = [
    ['CNG-ASSET-001', 'DEMO-LIVE-KIA', 'CNG_CYLINDER', 'EKC-2022-998214', 'Everest Kanto Cylinder', '2022-04-10'],
    ['CNG-ASSET-002', 'DEMO-LIVE-HYUNDAI', 'CNG_CYLINDER', 'RAM-2021-445120', 'Rama Cylinders Ltd', '2021-08-15'],
    ['CNG-ASSET-003', 'DEMO-V4-CAR', 'CNG_CYLINDER', 'EKC-2020-773190', 'Everest Kanto Cylinder', '2020-03-20'],
    ['CNG-ASSET-004', 'DEMO-V5-AUTO', 'CNG_CYLINDER', 'MAR-2021-112340', 'Maruti Koatsu Cylinders', '2021-11-05'],
    ['CNG-ASSET-005', 'DEMO-V1-CAR', 'CNG_CYLINDER', 'EKC-2022-881230', 'Everest Kanto Cylinder', '2022-02-18'],
    ['CNG-ASSET-006', 'DEMO-V2-TRUCK', 'CNG_TANK', 'BH-2021-998112', 'Bharat Heavy Gas Storage', '2021-06-12'],
    ['CNG-ASSET-007', 'DEMO-V3-VAN', 'CNG_CYLINDER', 'RAM-2020-334190', 'Rama Cylinders Ltd', '2020-09-25'],
    ['CNG-ASSET-008', 'DEMO-CAR-008', 'CNG_CYLINDER', 'EKC-2021-554120', 'Everest Kanto Cylinder', '2021-04-14'],
    ['CNG-ASSET-009', 'DEMO-CAR-009', 'CNG_CYLINDER', 'MAR-2022-667120', 'Maruti Koatsu Cylinders', '2022-01-20'],
    ['CNG-ASSET-010', 'DEMO-CAR-010', 'CNG_CYLINDER', 'EKC-2023-112990', 'Everest Kanto Cylinder', '2023-05-10'],
    ['CNG-ASSET-011', 'DEMO-CAR-011', 'CNG_CYLINDER', 'UNTESTED-2024-001', 'Euro Gas Cylinders', '2024-01-10'],
    ['CNG-ASSET-012', 'DEMO-V6-BREZZA', 'CNG_CYLINDER', 'EKC-2023-774180', 'Everest Kanto Cylinder', '2023-03-15'],
  ];

  const assets = {};
  for (const [code, vDemoId, type, serial, mfr, installDate] of assetRows) {
    const vId = vehicles[vDemoId]._id;
    await db.collection('cngAssets').updateOne(
      { assetCode: code },
      {
        $set: {
          assetCode: code,
          vehicleId: vId,
          stationId: 'STATION-DEMO-001',
          assetType: type,
          serialNumber: serial,
          manufacturer: mfr,
          installationDate: installDate,
          recordSource: 'DEMO',
          active: true,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
    assets[code] = await db.collection('cngAssets').findOne({ assetCode: code });
  }

  // Fictional hydrotest records covering: Pass (Valid), Fail, Pending, Due-Soon, and Overdue
  const records = [
    // 1. VALID: Kia Seltos (RJ14CV0002) - Pass, valid for 800 days -> Fueling Allowed
    ['CERT-RJ14-001', 'CNG-ASSET-001', 'PASS', -295, 800, 'National Gas Testing Authority', 'Hydrostatic stretch test passed at 300 bar. Permanent expansion 1.2%.'],
    ['CERT-RJ14-001-HIST', 'CNG-ASSET-001', 'PASS', -1390, -295, 'National Gas Testing Authority', 'Prior routine inspection passed.'],

    // 2. FAILED: Hyundai i20 (HR26CE7674) - Fail (wall thinning) -> Fueling Locked
    ['CERT-HR26-002', 'CNG-ASSET-002', 'FAIL', -10, 0, 'Apex Gas Inspection Lab', 'Failed visual and hydrostatic test. Cylinder wall thinning below safe threshold.'],

    // 3. OVERDUE: Maruti Wagon R (DL3CBD3885) - Overdue by 60 days -> Fueling Locked
    ['CERT-DL3C-003', 'CNG-ASSET-003', 'PASS', -1155, -60, 'Apex Gas Inspection Lab', 'Expired hydrostatic certificate. Retesting mandatory before next refill.'],

    // 4. DUE_SOON: Bajaj Auto (GJ06QA2032) - Due in 15 days (<= 30 days) -> Advisory Alert
    ['CERT-GJ06-004', 'CNG-ASSET-004', 'PASS', -1080, 15, 'Western Cylinder Testing Corp', 'Approaching 3-year statutory retest cycle. Refill permitted with advisory notice.'],

    // 5. PENDING: Hyundai Grand i10 (GJ01AB1234) - Pending laboratory review -> Fueling Held
    ['CERT-GJ01-005', 'CNG-ASSET-005', 'PENDING', -3, 60, 'State Hydrostatic Inspection Cell', 'Ultrasonic thickness test complete; waiting on metallographic report approval.'],

    // 6. VALID: Tata 407 (MH12DE1433) - Pass, valid for 650 days -> Fueling Allowed
    ['CERT-MH12-006', 'CNG-ASSET-006', 'PASS', -445, 650, 'Mumbai Industrial Testing Labs', 'Commercial cascade cylinder tested at 350 bar. Expansion 0.9%.'],

    // 7. FAILED: Maruti Eeco (RJ14SB1234) - Fail -> Fueling Locked
    ['CERT-RJ14-007', 'CNG-ASSET-007', 'FAIL', -8, 0, 'Jaipur Gas Equipment Testing', 'Cylinder expansion exceeded 10% elastic limit. Condemned and tagged.'],

    // 8. OVERDUE: Maruti Ertiga (MH01AV8866) - Overdue by 45 days -> Fueling Locked
    ['CERT-MH01-008', 'CNG-ASSET-008', 'PASS', -1140, -45, 'Maharashtra State Testing Board', 'Test validity expired. Refueling prohibited.'],

    // 9. DUE_SOON: Tata Tiago (GJ05CD2345) - Due in 22 days -> Advisory Alert
    ['CERT-GJ05-009', 'CNG-ASSET-009', 'PASS', -1073, 22, 'Surat Gas Safety Cell', 'Valid for 22 days. Renewal recommended.'],

    // 10. VALID: Maruti Alto (GJ18QR8901) - Pass, valid for 700 days -> Fueling Allowed
    ['CERT-GJ18-010', 'CNG-ASSET-010', 'PASS', -395, 700, 'Gujarat CNG Certification Center', 'Passed pressure hold and volumetric expansion tests.'],
    ['CERT-GJ18-010-HIST', 'CNG-ASSET-010', 'PASS', -1490, -395, 'Gujarat CNG Certification Center', 'Initial certification record.'],
    ['CERT-GJ01-012', 'CNG-ASSET-012', 'PASS', -180, 915, 'National Gas Testing Authority', 'Hydrostatic stretch test passed at 300 bar. Cylinder integrity confirmed.'],

    // Note: CNG-ASSET-011 has NO hydrotest record -> demonstrates NO_RECORD status!
  ];

  for (const [certificateReference, assetCode, result, testOffset, dueOffset, provider, notes] of records) {
    const asset = assets[assetCode];
    if (!asset) continue;
    await db.collection('hydrotests').updateOne(
      { certificateReference },
      {
        $set: {
          assetId: asset._id,
          vehicleId: asset.vehicleId,
          testDate: dayOffset(testOffset),
          nextDueDate: dayOffset(dueOffset),
          performedBy: provider || 'Demo Inspection Services',
          result,
          notes: notes || 'Synthetic demonstration record.',
          certificateReference,
          reportStorageKey: null,
          recordSource: 'DEMO',
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
  }

  // Create initial demo scan history
  const scanFixtures = [
    { demoId: 'DEMO-SCAN-001', vehicleId: 'DEMO-LIVE-KIA', assetCode: 'CNG-ASSET-001', ageDays: 0, confidence: 0.96 },
    { demoId: 'DEMO-SCAN-002', vehicleId: 'DEMO-LIVE-HYUNDAI', assetCode: 'CNG-ASSET-002', ageDays: 0, confidence: 0.91 },
    { demoId: 'DEMO-SCAN-003', vehicleId: 'DEMO-V4-CAR', assetCode: 'CNG-ASSET-003', ageDays: 1, confidence: 0.94 },
    { demoId: 'DEMO-SCAN-004', vehicleId: 'DEMO-V5-AUTO', assetCode: 'CNG-ASSET-004', ageDays: 2, confidence: 0.93 },
    { demoId: 'DEMO-SCAN-005', vehicleId: 'DEMO-V1-CAR', assetCode: 'CNG-ASSET-005', ageDays: 3, confidence: 0.90 },
    { demoId: 'DEMO-SCAN-006', vehicleId: 'DEMO-V2-TRUCK', assetCode: 'CNG-ASSET-006', ageDays: 4, confidence: 0.88 },
  ];

  const today = new Date().toISOString().slice(0, 10);
  for (const fixture of scanFixtures) {
    const vehicle = vehicles[fixture.vehicleId];
    const asset = assets[fixture.assetCode];
    if (!vehicle || !asset) continue;

    const latest = await db.collection('hydrotests').find({ assetId: asset._id }).sort({ testDate: -1, createdAt: -1 }).limit(1).next();
    const status = assetStatus(latest, today, 30);
    const decisionInfo = decisionForAssets([status], fixture.confidence, 0.62);
    const candidate = {
      plate: vehicle.plateNumberNormalized,
      rawText: vehicle.plateNumber,
      confidence: fixture.confidence,
      supportFrames: 3,
      frameIndices: [4, 8, 12],
      timestampsSeconds: [0.4, 0.8, 1.2],
      source: 'ASSUMED_DEMO_DATA'
    };

    const createdAt = new Date();
    createdAt.setUTCDate(createdAt.getUTCDate() - fixture.ageDays);

    const scanDoc = {
      demoId: fixture.demoId,
      mediaId: null,
      originalFilename: `Manual scan entry — ${vehicle.plateNumber}`,
      storageName: null,
      mediaType: 'DEMO_FIXTURE',
      status: 'COMPLETED',
      source: 'MANUAL_UPLOAD',
      candidates: [candidate],
      selectedPlate: vehicle.plateNumberNormalized,
      confidence: fixture.confidence,
      verificationId: null,
      verificationDecision: decisionInfo.decision,
      verificationExplanation: `${decisionInfo.decision} based on cylinder hydrotest inspection.`,
      recordSource: 'DEMO',
      createdAt,
      updatedAt: new Date(),
      framesProcessed: 3,
      elapsedSeconds: 0.35,
      scanEngine: 'YOLOv8-Plate + OpenCV + EasyOCR',
      synthetic: true,
    };

    await db.collection('scans').updateOne({ demoId: fixture.demoId }, { $set: scanDoc }, { upsert: true });
    const scan = await db.collection('scans').findOne({ demoId: fixture.demoId });

    const evaluation = {
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
        recordSource: latest.recordSource
      } : null,
      status
    };

    const explanationByDecision = {
      DISPENSING_ALLOWED: 'All linked assets have verified, current PASS hydrostatic test records. Dispenser interlock unlocked.',
      REVIEW_REQUIRED: 'Cylinder hydrotest due soon within 30 days. Operator advisory review required.',
      DO_NOT_DISPENSE_FAILED: 'Latest linked cylinder test FAILED safety inspection. Fuel dispensing blocked.',
      DO_NOT_DISPENSE_OVERDUE: 'Cylinder hydrostatic test is OVERDUE. Fuel dispensing blocked.',
      HOLD_PENDING_TEST: 'Cylinder inspection result is PENDING. Fuel dispensing held.',
      HOLD_NO_HYDROTEST_RECORD: 'No hydrotest record exists for the linked asset.',
    };

    const verificationDoc = {
      demoId: `${fixture.demoId}-VERIFICATION`,
      scanId: scan._id,
      source: 'MANUAL_UPLOAD',
      detectedPlate: vehicle.plateNumber,
      normalizedPlate: vehicle.plateNumberNormalized,
      confidence: fixture.confidence,
      vehicleId: vehicle._id,
      vehiclePlate: vehicle.plateNumber,
      assetEvaluations: [evaluation],
      decision: decisionInfo.decision,
      reasonCodes: decisionInfo.reasonCodes,
      explanation: explanationByDecision[decisionInfo.decision] || 'Review linked records.',
      manualReviewRequired: decisionInfo.decision !== 'DISPENSING_ALLOWED',
      operatorConfirmed: false,
      vehicleRegistered: true,
      linkedAssetCount: 1,
      hydrotestStatus: status,
      allRequiredAssetsValid: status === 'VALID',
      fuelingEligibility: decisionInfo.decision === 'DISPENSING_ALLOWED' ? 'ELIGIBLE' : 'NOT_ELIGIBLE',
      recordSource: 'DEMO',
      synthetic: true,
      createdAt,
      updatedAt: createdAt,
    };

    await db.collection('verifications').updateOne({ demoId: verificationDoc.demoId }, { $set: verificationDoc }, { upsert: true });
    const verification = await db.collection('verifications').findOne({ demoId: verificationDoc.demoId });
    await db.collection('scans').updateOne({ _id: scan._id }, { $set: { verificationId: verification._id, verificationDecision: decisionInfo.decision, verificationExplanation: verificationDoc.explanation } });
  }

  const current = await db.collection('vehicles').countDocuments({ recordSource: 'DEMO' });
  const assetCount = await db.collection('cngAssets').countDocuments({ recordSource: 'DEMO' });
  const testCount = await db.collection('hydrotests').countDocuments({ recordSource: 'DEMO' });
  const scanCount = await db.collection('scans').countDocuments({ recordSource: 'DEMO' });

  return { vehicles: current, assets: assetCount, hydrotests: testCount, scans: scanCount };
}

module.exports = { seedDemoData };
