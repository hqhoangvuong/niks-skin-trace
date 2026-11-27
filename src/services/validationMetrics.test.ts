import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  BlemishAnalysisRecord,
  CaptureView,
  ColorimetryAnalysisRecord,
  ExperimentVariant,
  NativeCaptureRecord,
  RegionColorimetryMetrics,
} from '@skin-trace/truedepth-camera';
import {
  buildLongitudinalTrendSummary,
  buildM4ValidationReportMarkdown,
  computeVariantRepeatability,
  DEFAULT_M4_THRESHOLDS,
  evaluateValidationCohort,
  VALIDATION_PROTOCOL_VERSION,
} from './validationMetrics';

function makeColorRegion(
  region: RegionColorimetryMetrics['region'],
  overrides: Partial<RegionColorimetryMetrics> = {}
): RegionColorimetryMetrics {
  return {
    region,
    state: 'measured',
    sampledPixelCount: 16000,
    validSkinPixelRatio: 0.94,
    meanLStar: 64.0,
    meanAStar: 11.2,
    meanBStar: 16.5,
    erythemaIndex: 14.0,
    melaninIndexProxy: 34.0,
    elevatedRednessAreaFraction: 0.04,
    darkSpotContrastAreaFraction: 0.03,
    darkSpotContrastDeltaL: 7.5,
    ...overrides,
  };
}

function makeColorimetry(
  sessionId: string,
  overrides: {
    algorithmVersion?: string;
    aStarShift?: number;
    rednessAreaShift?: number;
    darkSpotAreaShift?: number;
    computationTimeMs?: number;
  } = {}
): ColorimetryAnalysisRecord {
  const aShift = overrides.aStarShift ?? 0;
  const rShift = overrides.rednessAreaShift ?? 0;
  const dShift = overrides.darkSpotAreaShift ?? 0;
  return {
    sessionId,
    analyzedAtIso: '2026-11-27T10:00:00.000Z',
    state: 'measured',
    algorithmVersion: overrides.algorithmVersion ?? 'cielab-roi-srgb-v2',
    metricDefinitionVersion: 'colorimetry-metrics-v1',
    colorSpace: 'sRGB_D65',
    computationTimeMs: overrides.computationTimeMs ?? 48,
    regions: [
      makeColorRegion('forehead', {
        meanAStar: 11.2 + aShift,
        elevatedRednessAreaFraction: 0.04 + rShift,
        darkSpotContrastAreaFraction: 0.03 + dShift,
      }),
      makeColorRegion('anatomicalLeftCheek', {
        meanAStar: 12.1 + aShift,
        elevatedRednessAreaFraction: 0.05 + rShift,
        darkSpotContrastAreaFraction: 0.04 + dShift,
      }),
      makeColorRegion('anatomicalRightCheek', {
        meanAStar: 11.9 + aShift,
        elevatedRednessAreaFraction: 0.05 + rShift,
        darkSpotContrastAreaFraction: 0.04 + dShift,
      }),
      makeColorRegion('chin', {
        meanAStar: 10.8 + aShift,
        elevatedRednessAreaFraction: 0.03 + rShift,
        darkSpotContrastAreaFraction: 0.02 + dShift,
      }),
    ],
    warnings: [],
  };
}

function makeBlemish(
  sessionId: string,
  overrides: {
    modelVersion?: string;
    activeCount?: number;
    normalizedArea?: number;
    areaMm2?: number | null;
    computationTimeMs?: number;
  } = {}
): BlemishAnalysisRecord {
  const activeCount = overrides.activeCount ?? 1;
  const normArea = overrides.normalizedArea ?? 0.0025;
  const areaMm2 = overrides.areaMm2 === undefined ? 38.0 : overrides.areaMm2;
  return {
    sessionId,
    analyzedAtIso: '2026-11-27T10:00:00.000Z',
    state: 'measured',
    source: 'research_coreml_model',
    licenseScope: 'non_commercial_research_only',
    modelVersion: overrides.modelVersion ?? 'glowlytics-acne-yolov8-v1',
    preprocessingVersion: 'roi-square-640-v1',
    metricDefinitionVersion: 'blemish-metrics-v1',
    computationTimeMs: overrides.computationTimeMs ?? 170,
    lesions:
      activeCount > 0
        ? [
            {
              id: `${sessionId}-l1`,
              region: 'anatomicalLeftCheek',
              category: 'active_blemish_unspecified',
              centerNormalized: { x: 0.62, y: 0.56 },
              bboxNormalized: { x: 0.6, y: 0.54, width: 0.05, height: 0.05 },
              confidence: 0.52,
              uncertaintyState: 'confident',
              source: 'research_coreml_model',
            },
          ]
        : [],
    regions: [
      {
        region: 'forehead',
        activeBlemishCount: 0,
        residualMarkCount: 0,
        uncertainCount: 0,
        affectedAreaNormalized: 0,
        affectedAreaMm2: areaMm2 === null ? null : 0,
      },
      {
        region: 'anatomicalLeftCheek',
        activeBlemishCount: activeCount,
        residualMarkCount: 0,
        uncertainCount: 0,
        affectedAreaNormalized: normArea,
        affectedAreaMm2: areaMm2,
      },
      {
        region: 'anatomicalRightCheek',
        activeBlemishCount: 0,
        residualMarkCount: 0,
        uncertainCount: 0,
        affectedAreaNormalized: 0,
        affectedAreaMm2: areaMm2 === null ? null : 0,
      },
      {
        region: 'chin',
        activeBlemishCount: 0,
        residualMarkCount: 0,
        uncertainCount: 0,
        affectedAreaNormalized: 0,
        affectedAreaMm2: areaMm2 === null ? null : 0,
      },
    ],
    warnings: [],
  };
}

function makeCapture(
  sessionId: string,
  variant: ExperimentVariant,
  opts: {
    capturedAtIso?: string;
    deviceModel?: string;
    view?: CaptureView;
    interEyeDistance?: number;
    yawDegrees?: number;
    rollDegrees?: number;
    pitchDegrees?: number;
    eyeX?: number;
    eyeY?: number;
    depthMeters?: number | null;
    mmPerPixel?: number | null;
    iso?: number;
    exposureDurationMs?: number;
    wbRed?: number;
    wbBlue?: number;
    readyToCapture?: boolean;
    includeBlemish?: boolean;
    includeColorimetry?: boolean;
    blemishOverrides?: Parameters<typeof makeBlemish>[1];
    colorimetryOverrides?: Parameters<typeof makeColorimetry>[1];
  } = {}
): NativeCaptureRecord {
  const hasDepth = variant === 'rgb_depth_guided' && opts.depthMeters !== null;
  const depthMeters = opts.depthMeters ?? 0.27;
  const mmPerPixel =
    opts.mmPerPixel === undefined
      ? hasDepth
        ? 0.098
        : undefined
      : opts.mmPerPixel ?? undefined;
  const eyeX = opts.eyeX ?? 0.5;
  const eyeY = opts.eyeY ?? 0.42;
  const interEye = opts.interEyeDistance ?? 0.28;

  return {
    sessionId,
    capturedAtIso: opts.capturedAtIso ?? '2026-11-27T10:00:00.000Z',
    timezone: 'Asia/Bangkok',
    platform: 'ios',
    isSimulatedOrWebFallback: false,
    deviceModel: opts.deviceModel ?? 'iPhone13,2',
    systemVersion: '26.5.2',
    cameraDeviceType: hasDepth
      ? 'AVCaptureDeviceTypeBuiltInTrueDepthCamera'
      : 'AVCaptureDeviceTypeBuiltInWideAngleCamera',
    view: opts.view ?? 'front',
    requestedVariant: variant,
    effectiveCaptureMode: hasDepth ? 'rgb_plus_truedepth' : 'rgb_only_native',
    storedImageMirrored: false,
    rgbDimensions: { width: 3024, height: 4032 },
    cameraMetadata: {
      iso: opts.iso ?? 160,
      exposureDurationMs: opts.exposureDurationMs ?? 16.6,
      exposureTargetBias: 0,
      whiteBalanceRedGain: opts.wbRed ?? 1.9,
      whiteBalanceGreenGain: 1.0,
      whiteBalanceBlueGain: opts.wbBlue ?? 2.1,
    },
    facialAlignment: {
      detected: true,
      faceCount: 1,
      coordinateOrigin: 'top_left_normalized',
      faceBoundingBox: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
      anatomicalLeftEye: { x: eyeX + interEye / 2, y: eyeY },
      anatomicalRightEye: { x: eyeX - interEye / 2, y: eyeY },
      eyeCenterMidpoint: { x: eyeX, y: eyeY },
      interEyeDistance: interEye,
      eyeLineAngleDegrees: opts.rollDegrees ?? 0,
      poseDegrees: {
        yawDegrees: opts.yawDegrees ?? 0,
        rollDegrees: opts.rollDegrees ?? 0,
        pitchDegrees: opts.pitchDegrees ?? 0,
      },
      regions: {
        forehead: { x: 0.3, y: 0.22, width: 0.4, height: 0.14 },
        anatomicalLeftCheek: { x: 0.52, y: 0.48, width: 0.22, height: 0.18 },
        anatomicalRightCheek: { x: 0.26, y: 0.48, width: 0.22, height: 0.18 },
        chin: { x: 0.36, y: 0.68, width: 0.28, height: 0.14 },
      },
    },
    depth: hasDepth
      ? {
          available: true,
          originalPixelFormat: 'hdis',
          width: 640,
          height: 480,
          accuracy: 'absolute',
          quality: 'high',
          isFiltered: true,
          validPixelRatio: 0.99,
          centerWindowMinMeters: depthMeters - 0.01,
          centerWindowMedianMeters: depthMeters,
          centerWindowMaxMeters: depthMeters + 0.01,
          estimatedMmPerPixelAtRgb: mmPerPixel,
          calibration: { present: true },
        }
      : { available: false, unavailableReason: 'Depth not requested.' },
    liveGuidanceAtShutter: {
      timestampIso: opts.capturedAtIso ?? '2026-11-27T10:00:00.000Z',
      view: opts.view ?? 'front',
      variant,
      thresholdsProvisional: true,
      faceCount: 1,
      faceCentered: true,
      faceCoverageRatio: 0.36,
      yawDegrees: opts.yawDegrees ?? 0,
      rollDegrees: opts.rollDegrees ?? 0,
      pitchDegrees: opts.pitchDegrees ?? 0,
      sharpnessScore: 42,
      isSharp: true,
      neutralExpression: true,
      depthAvailable: hasDepth,
      faceDistanceMeters: hasDepth ? depthMeters : null,
      depthValidRatio: hasDepth ? 0.99 : null,
      distanceState: hasDepth ? 'in_range' : 'unavailable',
      sessionInterrupted: false,
      readyToCapture: opts.readyToCapture ?? true,
      guidanceMessages: [],
    },
    blemishAnalysis:
      opts.includeBlemish === false
        ? undefined
        : makeBlemish(sessionId, {
            areaMm2: hasDepth ? 38.0 : null,
            ...opts.blemishOverrides,
          }),
    colorimetryAnalysis:
      opts.includeColorimetry === false
        ? undefined
        : makeColorimetry(sessionId, opts.colorimetryOverrides),
    captureDurationMs: 420,
    warnings: [],
  };
}

describe('validationMetrics (M4)', () => {
  it('computes apples-to-apples geometric, comparability, blemish, and colorimetry repeatability per variant', () => {
    const shots = [0, 1, 2, 3, 4].map((i) =>
      makeCapture(`c-${i}`, 'rgb_depth_guided', {
        capturedAtIso: `2026-11-27T10:0${i}:00.000Z`,
        interEyeDistance: 0.28 + (i - 2) * 0.002,
        depthMeters: 0.27 + (i - 2) * 0.003,
        mmPerPixel: 0.098 + (i - 2) * 0.001,
        yawDegrees: (i - 2) * 0.8,
        rollDegrees: (i - 2) * 0.5,
        blemishOverrides: {
          activeCount: 1,
          normalizedArea: 0.0025 + (i - 2) * 0.00005,
          areaMm2: 38.0 + (i - 2) * 0.2,
        },
        colorimetryOverrides: {
          aStarShift: (i - 2) * 0.1,
          rednessAreaShift: (i - 2) * 0.003,
          darkSpotAreaShift: (i - 2) * 0.003,
        },
      })
    );

    const summary = computeVariantRepeatability(shots, 'rgb_depth_guided');
    assert.equal(summary.sampleCount, 5);
    assert.equal(summary.totalPairs, 10);
    assert.equal(summary.geometricComparableRate, 1);
    assert.equal(summary.colorComparableRate, 1);
    assert.ok(summary.interEyeDistanceCvPct !== null && summary.interEyeDistanceCvPct < 3);
    assert.ok(summary.depthDistanceSdCm !== null && summary.depthDistanceSdCm < 1);
    assert.ok(summary.mmPerPixelCvPct !== null && summary.mmPerPixelCvPct < 3);
    assert.equal(summary.rednessFalseChangeRegionRate, 0);
    assert.equal(summary.darkSpotFalseChangeRegionRate, 0);
    assert.equal(summary.blemishFalseChangePairRate, 0);
    assert.equal(summary.qualityAcceptanceRate, 1);
  });

  it('blocks cross-device and cross-view contamination in evaluateValidationCohort', () => {
    const mixedDevices = [
      makeCapture('c-1', 'rgb_depth_guided', { deviceModel: 'iPhone13,2' }),
      makeCapture('c-2', 'rgb_depth_guided', { deviceModel: 'iPhone17,1' }),
    ];
    const evalDevices = evaluateValidationCohort(mixedDevices);
    assert.equal(evalDevices.cohortValid, false);
    assert.equal(evalDevices.verdict, 'insufficient_data');
    assert.ok(evalDevices.blockers.some((b) => b.toLowerCase().includes('device')));

    const mixedViews = [
      makeCapture('c-3', 'rgb_depth_guided', { view: 'front' }),
      makeCapture('c-4', 'rgb_depth_guided', { view: 'left_cheek' }),
    ];
    const evalViews = evaluateValidationCohort(mixedViews);
    assert.equal(evalViews.cohortValid, false);
    assert.equal(evalViews.verdict, 'insufficient_data');
    assert.ok(evalViews.blockers.some((b) => b.toLowerCase().includes('view')));
  });

  it('marks cross-variant blemish and colorimetry comparability invalid on version drift', () => {
    const bShots = [0, 1, 2, 3, 4].map((i) =>
      makeCapture(`b-${i}`, 'rgb_guided', {
        capturedAtIso: `2026-11-27T10:0${i}:00.000Z`,
        colorimetryOverrides: { algorithmVersion: 'cielab-roi-srgb-v1' },
      })
    );
    const cShots = [0, 1, 2, 3, 4].map((i) =>
      makeCapture(`c-${i}`, 'rgb_depth_guided', {
        capturedAtIso: `2026-11-27T10:1${i}:00.000Z`,
        colorimetryOverrides: { algorithmVersion: 'cielab-roi-srgb-v2' },
      })
    );

    const evaluation = evaluateValidationCohort([...bShots, ...cShots]);
    assert.equal(evaluation.versionConsistency.colorimetryConsistent, false);
    assert.equal(evaluation.verdict, 'insufficient_data');
    assert.ok(evaluation.blockers.some((b) => b.toLowerCase().includes('version')));
  });

  it('returns null instead of NaN or fake zero for tiny samples, zero-mean areas, and missing depth', () => {
    const aShot = makeCapture('a-0', 'rgb_unguided', {
      includeBlemish: false,
      includeColorimetry: false,
    });
    const bShots = [0, 1, 2, 3, 4].map((i) =>
      makeCapture(`b-${i}`, 'rgb_guided', {
        capturedAtIso: `2026-11-27T10:0${i}:00.000Z`,
        blemishOverrides: { activeCount: 0, normalizedArea: 0, areaMm2: null },
      })
    );

    const aSummary = computeVariantRepeatability([aShot], 'rgb_unguided');
    assert.equal(aSummary.interEyeDistanceCvPct, null);
    assert.equal(aSummary.yawSdDeg, null);
    assert.equal(aSummary.depthDistanceSdCm, null);
    assert.equal(aSummary.totalPairs, 0);

    const bSummary = computeVariantRepeatability(bShots, 'rgb_guided');
    assert.equal(bSummary.depthDistanceSdCm, null);
    assert.equal(bSummary.mmPerPixelCvPct, null);
    assert.equal(bSummary.normalizedAreaCvPct, null);
    assert.equal(bSummary.calibratedAreaMm2CvPct, null);

    const evaluation = evaluateValidationCohort([aShot, ...bShots]);
    assert.equal(evaluation.verdict, 'insufficient_data');
  });

  it('separates not_comparable refusals from false-change rate denominator', () => {
    // Huge EV jumps between consecutive captures (> 1.5 EV) so 0 pairs pass color gate.
    const isos = [50, 200, 800, 3200, 12800];
    const cShots = isos.map((iso, i) =>
      makeCapture(`c-ev-${i}`, 'rgb_depth_guided', {
        capturedAtIso: `2026-11-27T10:0${i}:00.000Z`,
        iso,
      })
    );

    const summary = computeVariantRepeatability(cShots, 'rgb_depth_guided');
    assert.equal(summary.totalPairs, 10);
    assert.equal(summary.colorComparablePairs, 0);
    assert.equal(summary.colorComparableRate, 0);
    assert.equal(summary.rednessFalseChangeRegionRate, null);
    assert.equal(summary.darkSpotFalseChangeRegionRate, null);
    assert.ok((summary.refusalReasonCounts.exposure_ev_shift ?? 0) > 0);

    const bShots = [0, 1, 2, 3, 4].map((i) =>
      makeCapture(`b-${i}`, 'rgb_guided', {
        capturedAtIso: `2026-11-27T10:2${i}:00.000Z`,
      })
    );
    const evaluation = evaluateValidationCohort([...bShots, ...cShots]);
    const cColorGate = evaluation.gates.find(
      (g) => g.variant === 'rgb_depth_guided' && g.id === 'color_comparable_rate'
    );
    assert.equal(cColorGate?.passed, false);
  });

  it('selects truedepth_demonstrated_benefit when Variant C beats Variant B by >= 15% relative reduction and passes all gates', () => {
    const bInterEye = [0.262, 0.275, 0.28, 0.287, 0.296]; // ~4.5% CV (passes <= 5%)
    const cInterEye = [0.277, 0.279, 0.28, 0.281, 0.283]; // ~0.8% CV (>80% reduction)

    const bShots = bInterEye.map((eye, i) =>
      makeCapture(`b-${i}`, 'rgb_guided', {
        capturedAtIso: `2026-11-27T10:0${i}:00.000Z`,
        interEyeDistance: eye,
        yawDegrees: (i - 2) * 1.1,
      })
    );
    const cShots = cInterEye.map((eye, i) =>
      makeCapture(`c-${i}`, 'rgb_depth_guided', {
        capturedAtIso: `2026-11-27T10:1${i}:00.000Z`,
        interEyeDistance: eye,
        depthMeters: 0.27 + (i - 2) * 0.002,
        yawDegrees: (i - 2) * 0.6,
        blemishOverrides: {
          normalizedArea: 0.0025 + (i - 2) * 0.0002,
          areaMm2: 38.0 + (i - 2) * 0.2,
        },
      })
    );

    const evaluation = evaluateValidationCohort([...bShots, ...cShots]);
    assert.equal(evaluation.verdict, 'truedepth_demonstrated_benefit');
    assert.ok(
      evaluation.depthVsGuidedComparison.interEyeCvRelativeReduction !== null &&
        evaluation.depthVsGuidedComparison.interEyeCvRelativeReduction >=
          DEFAULT_M4_THRESHOLDS.minDepthBenefitRelativeReduction
    );
  });

  it('selects guidance_sufficient_depth_optional when Variant B already passes all gates and Variant C offers < 15% improvement', () => {
    const tightEye = [0.278, 0.279, 0.28, 0.281, 0.282];
    const bShots = tightEye.map((eye, i) =>
      makeCapture(`b-${i}`, 'rgb_guided', {
        capturedAtIso: `2026-11-27T10:0${i}:00.000Z`,
        interEyeDistance: eye,
        yawDegrees: (i - 2) * 0.8,
      })
    );
    const cShots = tightEye.map((eye, i) =>
      makeCapture(`c-${i}`, 'rgb_depth_guided', {
        capturedAtIso: `2026-11-27T10:1${i}:00.000Z`,
        interEyeDistance: eye,
        yawDegrees: (i - 2) * 0.8,
        blemishOverrides: {
          normalizedArea: 0.0025 + (i - 2) * 0.0001,
          areaMm2: 38.0 + (i - 2) * 1.5, // same CV% as normalized
        },
      })
    );

    const evaluation = evaluateValidationCohort([...bShots, ...cShots]);
    assert.equal(evaluation.verdict, 'guidance_sufficient_depth_optional');
  });

  it('selects thresholds_not_met when sample counts are sufficient but redness false-change rate exceeds 10%', () => {
    const aStarJumps = [0, 2.2, 0.1, 2.4, 0.2]; // large redness jumps across pairs -> >10% false change
    const bShots = aStarJumps.map((shift, i) =>
      makeCapture(`b-${i}`, 'rgb_guided', {
        capturedAtIso: `2026-11-27T10:0${i}:00.000Z`,
        colorimetryOverrides: { aStarShift: shift },
      })
    );
    const cShots = aStarJumps.map((shift, i) =>
      makeCapture(`c-${i}`, 'rgb_depth_guided', {
        capturedAtIso: `2026-11-27T10:1${i}:00.000Z`,
        colorimetryOverrides: { aStarShift: shift },
      })
    );

    const evaluation = evaluateValidationCohort([...bShots, ...cShots]);
    assert.equal(evaluation.verdict, 'thresholds_not_met');
    const cRedGate = evaluation.gates.find(
      (g) => g.variant === 'rgb_depth_guided' && g.id === 'redness_false_change_rate'
    );
    assert.equal(cRedGate?.passed, false);
  });

  it('builds multi-day longitudinal trend summary separating comparable, non-comparable, and unanalyzed days', () => {
    const day1 = makeCapture('d1', 'rgb_depth_guided', {
      capturedAtIso: '2026-11-24T09:00:00.000Z',
      blemishOverrides: { activeCount: 3, areaMm2: 45.0 },
    });
    const day2 = makeCapture('d2', 'rgb_depth_guided', {
      capturedAtIso: '2026-11-25T09:00:00.000Z',
      blemishOverrides: { activeCount: 2, areaMm2: 30.0 },
    });
    const day3BadLight = makeCapture('d3', 'rgb_depth_guided', {
      capturedAtIso: '2026-11-26T09:00:00.000Z',
      iso: 1200, // > 1.5 EV shift vs Day 1 -> not_comparable
      blemishOverrides: { activeCount: 1, areaMm2: 15.0 },
    });
    const day4Unanalyzed = makeCapture('d4', 'rgb_depth_guided', {
      capturedAtIso: '2026-11-27T09:00:00.000Z',
      includeBlemish: false,
      includeColorimetry: false,
    });

    const trend = buildLongitudinalTrendSummary([day4Unanalyzed, day2, day3BadLight, day1], {
      view: 'front',
      deviceModel: 'iPhone13,2',
    });

    assert.equal(trend.points.length, 4);
    assert.equal(trend.points[0].dayKey, '2026-11-24');
    assert.equal(trend.points[0].comparabilityVsBaseline, 'baseline');
    assert.equal(trend.points[0].totalActiveBlemishes, 3);

    assert.equal(trend.points[1].dayKey, '2026-11-25');
    assert.equal(trend.points[1].comparabilityVsBaseline, 'comparable');
    assert.equal(trend.points[1].totalActiveBlemishes, 2);

    assert.equal(trend.points[2].dayKey, '2026-11-26');
    assert.equal(trend.points[2].comparabilityVsBaseline, 'not_comparable');

    assert.equal(trend.points[3].dayKey, '2026-11-27');
    assert.equal(trend.points[3].blemishState, 'not_analyzed');
    assert.equal(trend.points[3].colorimetryState, 'not_analyzed');
    assert.equal(trend.points[3].totalActiveBlemishes, null);
  });

  it('generates honest Markdown validation report distinguishing verified device from pending iPhone 16 Pro', () => {
    const bShots = [0, 1, 2, 3, 4].map((i) =>
      makeCapture(`b-${i}`, 'rgb_guided', {
        capturedAtIso: `2026-11-27T10:0${i}:00.000Z`,
        deviceModel: 'iPhone13,2',
      })
    );
    const cShots = [0, 1, 2, 3, 4].map((i) =>
      makeCapture(`c-${i}`, 'rgb_depth_guided', {
        capturedAtIso: `2026-11-27T10:1${i}:00.000Z`,
        deviceModel: 'iPhone13,2',
      })
    );

    const evaluation = evaluateValidationCohort([...bShots, ...cShots]);
    const trend = buildLongitudinalTrendSummary(cShots, {
      view: 'front',
      deviceModel: 'iPhone13,2',
    });
    const md = buildM4ValidationReportMarkdown(evaluation, trend, {
      generatedAtIso: '2026-11-27T18:00:00.000Z',
      targetHardwareModel: 'iPhone 16 Pro',
    });

    assert.ok(md.includes(VALIDATION_PROTOCOL_VERSION));
    assert.ok(md.includes('iPhone13,2'));
    assert.ok(md.includes('provisional_pilot_thresholds'));
    assert.ok(md.includes('Variant A'));
    assert.ok(md.includes('Variant B'));
    assert.ok(md.includes('Variant C'));
    assert.ok(md.includes(evaluation.verdict));
    assert.ok(md.includes('iPhone 16 Pro'));
    assert.ok(md.toLowerCase().includes('pending'));
  });

  it('blocks truedepth_demonstrated_benefit when Variant C has no TrueDepth depth or web fallback, and withholds benefitReasons on blocked cohorts', () => {
    const bInterEye = [0.262, 0.275, 0.28, 0.287, 0.296];
    const cInterEye = [0.277, 0.279, 0.28, 0.281, 0.283];
    const bShots = bInterEye.map((eye, i) =>
      makeCapture(`b-${i}`, 'rgb_guided', {
        capturedAtIso: `2026-11-27T10:0${i}:00.000Z`,
        interEyeDistance: eye,
      })
    );
    // Variant C requested depth, but depth fell back to unavailable (depthMeters: null).
    const cNoDepthShots = cInterEye.map((eye, i) =>
      makeCapture(`c-nodepth-${i}`, 'rgb_depth_guided', {
        capturedAtIso: `2026-11-27T10:1${i}:00.000Z`,
        interEyeDistance: eye,
        depthMeters: null,
      })
    );
    const evalNoDepth = evaluateValidationCohort([...bShots, ...cNoDepthShots]);
    assert.equal(evalNoDepth.verdict, 'insufficient_data');
    assert.equal(evalNoDepth.depthVsGuidedComparison.benefitReasons.length, 0);

    // Version-drifted cohort must withhold benefitReasons and gate verdicts.
    const cDrifted = cInterEye.map((eye, i) =>
      makeCapture(`c-drift-${i}`, 'rgb_depth_guided', {
        capturedAtIso: `2026-11-27T10:2${i}:00.000Z`,
        interEyeDistance: eye,
        colorimetryOverrides: { algorithmVersion: 'cielab-roi-srgb-v1' },
      })
    );
    const evalDrifted = evaluateValidationCohort([...bShots, ...cDrifted]);
    assert.equal(evalDrifted.verdict, 'insufficient_data');
    assert.equal(evalDrifted.depthVsGuidedComparison.benefitReasons.length, 0);
    assert.ok(evalDrifted.gates.every((g) => g.passed === null));
  });

  it('flags longitudinal days not_comparable on M3 colorimetry EV/version shifts and prefers TrueDepth shots on mixed-variant days', () => {
    const day1B = makeCapture('d1-b', 'rgb_guided', {
      capturedAtIso: '2026-11-24T09:05:00.000Z',
    });
    const day1C = makeCapture('d1-c', 'rgb_depth_guided', {
      capturedAtIso: '2026-11-24T09:00:00.000Z',
    });
    // Day 2 has 1.0 EV shift (passes M1 <=1.5 EV, fails M3 <=0.75 EV).
    const day2ModerateEv = makeCapture('d2-ev', 'rgb_depth_guided', {
      capturedAtIso: '2026-11-25T09:00:00.000Z',
      iso: 320,
    });
    // Day 3 has algorithm version drift (v1 vs v2).
    const day3VersionDrift = makeCapture('d3-v1', 'rgb_depth_guided', {
      capturedAtIso: '2026-11-26T09:00:00.000Z',
      colorimetryOverrides: { algorithmVersion: 'cielab-roi-srgb-v1' },
    });

    const trend = buildLongitudinalTrendSummary(
      [day1B, day1C, day2ModerateEv, day3VersionDrift],
      { view: 'front', deviceModel: 'iPhone13,2' }
    );
    // Day 1 must pick Variant C (TrueDepth) over Variant B even though B is 5 min later.
    assert.equal(trend.points[0].sessionId, 'd1-c');
    assert.equal(trend.points[1].comparabilityVsBaseline, 'not_comparable');
    assert.equal(trend.points[2].comparabilityVsBaseline, 'not_comparable');
  });

  it('buckets missing EV/WB/distance metadata into missing_metadata rather than physical shift buckets', () => {
    const cShots = [0, 1, 2].map((i) => {
      const cap = makeCapture(`c-nometa-${i}`, 'rgb_depth_guided', {
        capturedAtIso: `2026-11-27T10:0${i}:00.000Z`,
      });
      cap.cameraMetadata = undefined;
      return cap;
    });
    const summary = computeVariantRepeatability(cShots, 'rgb_depth_guided');
    assert.ok((summary.refusalReasonCounts.missing_metadata ?? 0) > 0);
    assert.equal(summary.refusalReasonCounts.exposure_ev_shift ?? 0, 0);
    assert.equal(summary.refusalReasonCounts.white_balance_shift ?? 0, 0);
  });

  it('returns insufficient_data rather than thresholds_not_met when cohort is only partially color-analyzed', () => {
    const bShots = [0, 1, 2, 3, 4].map((i) =>
      makeCapture(`b-part-${i}`, 'rgb_guided', {
        capturedAtIso: `2026-11-27T10:0${i}:00.000Z`,
        includeColorimetry: i < 2, // only 2 of 5 analyzed
      })
    );
    const cShots = [0, 1, 2, 3, 4].map((i) =>
      makeCapture(`c-part-${i}`, 'rgb_depth_guided', {
        capturedAtIso: `2026-11-27T10:1${i}:00.000Z`,
      })
    );
    const evaluation = evaluateValidationCohort([...bShots, ...cShots]);
    assert.equal(evaluation.verdict, 'insufficient_data');
    assert.equal(evaluation.variants.rgb_guided.colorComparableRate, 1);
  });

  it('enforces symmetric RGB-only framing scale gates (<=12% color, <=22% geometric) and refuses unaligned colorimetry', () => {
    const base = makeCapture('b-base', 'rgb_guided', {
      capturedAtIso: '2026-11-27T10:00:00.000Z',
      interEyeDistance: 0.28,
    });
    // 15% scale shift (0.28 / 0.2435 = 1.15): passes M1 <=22%, fails M3 color <=12%.
    const midShift = makeCapture('b-mid', 'rgb_guided', {
      capturedAtIso: '2026-11-27T10:01:00.000Z',
      interEyeDistance: 0.2435,
    });
    // 30% scale shift (0.28 / 0.215 = 1.30): fails M1 geometric >22%.
    const hugeShift = makeCapture('b-huge', 'rgb_guided', {
      capturedAtIso: '2026-11-27T10:02:00.000Z',
      interEyeDistance: 0.215,
    });
    const unaligned = makeCapture('b-unaligned', 'rgb_guided', {
      capturedAtIso: '2026-11-27T10:03:00.000Z',
    });
    unaligned.facialAlignment = { detected: false, faceCount: 0 };

    const sMid = computeVariantRepeatability([base, midShift], 'rgb_guided');
    assert.equal(sMid.geometricComparablePairs, 1);
    assert.equal(sMid.colorComparablePairs, 0);

    const sHuge = computeVariantRepeatability([base, hugeShift], 'rgb_guided');
    assert.equal(sHuge.geometricComparablePairs, 0);

    const sUnaligned = computeVariantRepeatability([base, unaligned], 'rgb_guided');
    assert.equal(sUnaligned.colorComparablePairs, 0);
    assert.ok((sUnaligned.refusalReasonCounts.missing_metadata ?? 0) > 0);
  });

  it('filters per-session blemish CV% to the dominant version when version drift exists', () => {
    const shots = [
      makeCapture('v1-0', 'rgb_depth_guided', {
        capturedAtIso: '2026-11-27T10:00:00.000Z',
        blemishOverrides: { modelVersion: 'model-v2', normalizedArea: 0.0025, areaMm2: 38 },
      }),
      makeCapture('v1-1', 'rgb_depth_guided', {
        capturedAtIso: '2026-11-27T10:01:00.000Z',
        blemishOverrides: { modelVersion: 'model-v2', normalizedArea: 0.0025, areaMm2: 38 },
      }),
      makeCapture('v1-2', 'rgb_depth_guided', {
        capturedAtIso: '2026-11-27T10:02:00.000Z',
        blemishOverrides: { modelVersion: 'model-v2', normalizedArea: 0.0025, areaMm2: 38 },
      }),
      // Single outlier from an older model version with 10x larger area
      makeCapture('v0-outlier', 'rgb_depth_guided', {
        capturedAtIso: '2026-11-27T10:03:00.000Z',
        blemishOverrides: { modelVersion: 'model-v1', normalizedArea: 0.025, areaMm2: 380 },
      }),
    ];
    const summary = computeVariantRepeatability(shots, 'rgb_depth_guided');
    // Dominant version ('model-v2', 3 shots) has identical areas -> 0% CV, not inflated by v1 outlier.
    assert.equal(summary.normalizedAreaCvPct, 0);
    assert.equal(summary.calibratedAreaMm2CvPct, 0);
  });
});
