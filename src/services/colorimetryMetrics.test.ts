import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ColorimetryAnalysisRecord,
  NativeCaptureRecord,
  RegionColorimetryMetrics,
} from '../../plugins/truedepth-camera/src/definitions';
import type { ComparisonRecord } from '../types/domain';
import {
  COLORIMETRY_ALGORITHM_VERSION,
  COLORIMETRY_METRIC_VERSION,
  compareColorimetryAnalyses,
  computeRegionColorimetryFromRgba,
  srgbToLab,
} from './colorimetryMetrics';

function makePatchRgba(
  count: number,
  rgb: [number, number, number],
  overrideCount = 0,
  overrideRgb: [number, number, number] = rgb
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    const [r, g, b] = i < overrideCount ? overrideRgb : rgb;
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function makeRegionMetric(
  region: RegionColorimetryMetrics['region'],
  overrides: Partial<RegionColorimetryMetrics> = {}
): RegionColorimetryMetrics {
  return {
    region,
    state: 'measured',
    sampledPixelCount: 1000,
    validSkinPixelRatio: 0.95,
    meanLStar: 65,
    meanAStar: 12,
    meanBStar: 15,
    erythemaIndex: 18,
    melaninIndexProxy: 35,
    elevatedRednessAreaFraction: 0.08,
    darkSpotContrastAreaFraction: 0.06,
    darkSpotContrastDeltaL: 9.0,
    ...overrides,
  };
}

function makeColorimetryRecord(
  sessionId: string,
  overrides: Partial<ColorimetryAnalysisRecord> = {}
): ColorimetryAnalysisRecord {
  return {
    sessionId,
    analyzedAtIso: '2026-11-27T10:00:00Z',
    state: 'measured',
    algorithmVersion: COLORIMETRY_ALGORITHM_VERSION,
    metricDefinitionVersion: COLORIMETRY_METRIC_VERSION,
    colorSpace: 'sRGB_D65',
    computationTimeMs: 22,
    regions: [
      makeRegionMetric('forehead'),
      makeRegionMetric('anatomicalLeftCheek'),
      makeRegionMetric('anatomicalRightCheek'),
      makeRegionMetric('chin'),
    ],
    warnings: [],
    ...overrides,
  };
}

function makeCapture(
  id: string,
  overrides: Partial<NativeCaptureRecord> = {}
): NativeCaptureRecord {
  return {
    sessionId: id,
    capturedAtIso: '2026-11-27T10:00:00Z',
    timezone: 'UTC',
    platform: 'ios',
    isSimulatedOrWebFallback: false,
    deviceModel: 'iPhone13,2',
    systemVersion: '26.5.2',
    cameraDeviceType: 'AVCaptureDeviceTypeBuiltInTrueDepthCamera',
    view: 'front',
    requestedVariant: 'rgb_depth_guided',
    effectiveCaptureMode: 'rgb_plus_truedepth',
    storedImageMirrored: false,
    rgbDimensions: { width: 4032, height: 3024 },
    cameraMetadata: {
      iso: 600,
      exposureDurationMs: 10,
      exposureTargetBias: 0,
      whiteBalanceRedGain: 2.1,
      whiteBalanceGreenGain: 1.0,
      whiteBalanceBlueGain: 1.65,
    },
    depth: {
      available: true,
      width: 640,
      height: 480,
      validPixelRatio: 1,
      centerWindowMedianMeters: 0.28,
      estimatedMmPerPixelAtRgb: 0.1,
    },
    captureDurationMs: 320,
    warnings: [],
    ...overrides,
  };
}

function makeGate(
  bId: string,
  cId: string,
  overrides: Partial<ComparisonRecord> = {}
): ComparisonRecord {
  return {
    baselineSessionId: bId,
    currentSessionId: cId,
    view: 'front',
    comparabilityState: 'comparable',
    alignmentMode: 'eye_landmarks',
    reasons: ['Within M1 bounds'],
    cautions: [],
    deltas: {
      distanceDeltaCm: 0.5,
      exposureEvDelta: 0.1,
      wbRedDelta: 0.02,
      wbBlueDelta: -0.02,
    },
    analysisStatus: 'not_analyzed',
    ...overrides,
  };
}

describe('colorimetryMetrics', () => {
  it('converts reference sRGB colors to CIELAB accurately', () => {
    const white = srgbToLab(255, 255, 255);
    assert.ok(Math.abs(white.l - 100) < 0.05);
    assert.ok(Math.abs(white.a) < 0.05);
    assert.ok(Math.abs(white.b) < 0.05);

    const black = srgbToLab(0, 0, 0);
    assert.ok(Math.abs(black.l) < 0.05);

    const neutralSkin = srgbToLab(200, 160, 140);
    const redderSkin = srgbToLab(215, 145, 135);
    assert.ok(redderSkin.a > neutralSkin.a + 5);
  });

  it('marks ROI unavailable when specular glare or deep shadow drops validSkinPixelRatio below 0.35', () => {
    const glarePatch = makePatchRgba(200, [200, 160, 140], 160, [252, 252, 252]);
    const res = computeRegionColorimetryFromRgba(glarePatch, 'forehead');
    assert.equal(res.state, 'unavailable');
    assert.ok(res.validSkinPixelRatio < 0.35);
    assert.equal(res.meanAStar, null);
    assert.equal(res.darkSpotContrastAreaFraction, null);

    const shadowPatch = makePatchRgba(200, [200, 160, 140], 170, [10, 10, 10]);
    const shadowRes = computeRegionColorimetryFromRgba(shadowPatch, 'chin');
    assert.equal(shadowRes.state, 'unavailable');
    assert.equal(shadowRes.meanLStar, null);
  });

  it('is invariant across light and dark Fitzpatrick skin tones for uniform skin and localized spots/redness', () => {
    const lightUniform = computeRegionColorimetryFromRgba(
      makePatchRgba(200, [215, 175, 155]),
      'anatomicalLeftCheek'
    );
    const darkUniform = computeRegionColorimetryFromRgba(
      makePatchRgba(200, [110, 75, 60]),
      'anatomicalLeftCheek'
    );
    assert.equal(lightUniform.state, 'measured');
    assert.equal(darkUniform.state, 'measured');
    assert.equal(lightUniform.elevatedRednessAreaFraction, 0);
    assert.equal(lightUniform.darkSpotContrastAreaFraction, 0);
    assert.equal(darkUniform.elevatedRednessAreaFraction, 0);
    assert.equal(darkUniform.darkSpotContrastAreaFraction, 0);

    // 10% darker spot injected into both light and dark skin
    const lightSpot = computeRegionColorimetryFromRgba(
      makePatchRgba(200, [215, 175, 155], 20, [155, 120, 105]),
      'anatomicalLeftCheek'
    );
    const darkSpot = computeRegionColorimetryFromRgba(
      makePatchRgba(200, [110, 75, 60], 20, [70, 46, 36]),
      'anatomicalLeftCheek'
    );
    assert.ok(Math.abs((lightSpot.darkSpotContrastAreaFraction ?? 0) - 0.1) < 0.01);
    assert.ok(Math.abs((darkSpot.darkSpotContrastAreaFraction ?? 0) - 0.1) < 0.01);
    assert.ok((lightSpot.darkSpotContrastDeltaL ?? 0) >= 6.0);
    assert.ok((darkSpot.darkSpotContrastDeltaL ?? 0) >= 6.0);
  });

  it('enforces stricter EV (<= 0.75), WB (<= 0.20), and distance (<= 4.0 cm) color-consistency gates', () => {
    const b = makeCapture('b', { colorimetryAnalysis: makeColorimetryRecord('b') });
    const c = makeCapture('c', { colorimetryAnalysis: makeColorimetryRecord('c') });

    const evFail = compareColorimetryAnalyses(
      b,
      c,
      makeGate('b', 'c', { deltas: { exposureEvDelta: 0.9, distanceDeltaCm: 0.5, wbRedDelta: 0.02, wbBlueDelta: 0.02 } })
    );
    assert.equal(evFail.state, 'not_comparable');
    assert.equal(evFail.regionDeltas.length, 0);

    const wbFail = compareColorimetryAnalyses(
      b,
      c,
      makeGate('b', 'c', { deltas: { exposureEvDelta: 0.1, distanceDeltaCm: 0.5, wbRedDelta: 0.25, wbBlueDelta: 0.02 } })
    );
    assert.equal(wbFail.state, 'not_comparable');

    const distFail = compareColorimetryAnalyses(
      b,
      c,
      makeGate('b', 'c', { deltas: { exposureEvDelta: 0.1, distanceDeltaCm: 5.0, wbRedDelta: 0.02, wbBlueDelta: 0.02 } })
    );
    assert.equal(distFail.state, 'not_comparable');
  });

  it('distinguishes noise-floor drift from directional redness and dark-spot appearance changes', () => {
    const b = makeCapture('b', { colorimetryAnalysis: makeColorimetryRecord('b') });
    const cNoise = makeCapture('c1', {
      colorimetryAnalysis: makeColorimetryRecord('c1', {
        regions: [
          makeRegionMetric('forehead', { meanAStar: 12.3, elevatedRednessAreaFraction: 0.084, darkSpotContrastAreaFraction: 0.056 }),
          makeRegionMetric('anatomicalLeftCheek', { meanAStar: 9.8, elevatedRednessAreaFraction: 0.04, darkSpotContrastAreaFraction: 0.02 }),
          makeRegionMetric('anatomicalRightCheek'),
          makeRegionMetric('chin'),
        ],
      }),
    });

    const cmp = compareColorimetryAnalyses(b, cNoise, makeGate('b', 'c1'));
    assert.equal(cmp.state, 'measured');
    const fh = cmp.regionDeltas.find((r) => r.region === 'forehead');
    assert.equal(fh?.rednessStatus, 'no_clear_change');
    assert.equal(fh?.darkSpotStatus, 'no_clear_change');

    const lc = cmp.regionDeltas.find((r) => r.region === 'anatomicalLeftCheek');
    assert.equal(lc?.rednessStatus, 'decreased_appearance');
    assert.equal(lc?.darkSpotStatus, 'decreased_appearance');
  });

  it('handles unanalyzed sessions and algorithm version mismatches cleanly', () => {
    const legacy = makeCapture('old');
    const analyzed = makeCapture('new', {
      colorimetryAnalysis: makeColorimetryRecord('new'),
    });

    assert.equal(
      compareColorimetryAnalyses(legacy, analyzed, makeGate('old', 'new')).state,
      'not_analyzed'
    );

    const olderAlgo = makeCapture('v0', {
      colorimetryAnalysis: makeColorimetryRecord('v0', {
        algorithmVersion: 'cielab-roi-v0',
      }),
    });
    assert.equal(
      compareColorimetryAnalyses(olderAlgo, analyzed, makeGate('v0', 'new')).state,
      'not_comparable'
    );
  });

  it('refuses colorimetry comparison when EV or white-balance deltas are missing', () => {
    const b = makeCapture('b', {
      cameraMetadata: undefined,
      colorimetryAnalysis: makeColorimetryRecord('b'),
    });
    const c = makeCapture('c', {
      colorimetryAnalysis: makeColorimetryRecord('c'),
    });
    const gateNoCameraMeta = makeGate('b', 'c', {
      deltas: { distanceDeltaCm: 0.5 },
    });
    const res = compareColorimetryAnalyses(b, c, gateNoCameraMeta);
    assert.equal(res.state, 'not_comparable');
    assert.equal(res.regionDeltas.length, 0);
  });

  it('avoids darkSpotContrastDeltaL discontinuity at 0->tiny spots and survivorship suppression on clearing', () => {
    // 0% -> 0.2% tiny fluctuation (below 1.5% noise floor) must remain no_clear_change even if deltaL jumps 0 -> 6.5
    const bZero = makeCapture('bz', {
      colorimetryAnalysis: makeColorimetryRecord('bz', {
        regions: [
          makeRegionMetric('forehead', {
            darkSpotContrastAreaFraction: 0,
            darkSpotContrastDeltaL: 0,
          }),
          makeRegionMetric('anatomicalLeftCheek', {
            darkSpotContrastAreaFraction: 0.1,
            darkSpotContrastDeltaL: 7.5,
          }),
          makeRegionMetric('anatomicalRightCheek'),
          makeRegionMetric('chin'),
        ],
      }),
    });
    const cTinyAndCleared = makeCapture('ct', {
      colorimetryAnalysis: makeColorimetryRecord('ct', {
        regions: [
          makeRegionMetric('forehead', {
            darkSpotContrastAreaFraction: 0.002,
            darkSpotContrastDeltaL: 6.5,
          }),
          // Left cheek spots dropped 10% -> 2% (-8pp), while remaining spot has higher mean deltaL (9.5)
          makeRegionMetric('anatomicalLeftCheek', {
            darkSpotContrastAreaFraction: 0.02,
            darkSpotContrastDeltaL: 9.5,
          }),
          makeRegionMetric('anatomicalRightCheek'),
          makeRegionMetric('chin'),
        ],
      }),
    });

    const res = compareColorimetryAnalyses(
      bZero,
      cTinyAndCleared,
      makeGate('bz', 'ct')
    );
    assert.equal(res.state, 'measured');
    const fh = res.regionDeltas.find((r) => r.region === 'forehead');
    assert.equal(fh?.darkSpotStatus, 'no_clear_change');
    const lc = res.regionDeltas.find((r) => r.region === 'anatomicalLeftCheek');
    assert.equal(lc?.darkSpotStatus, 'decreased_appearance');
  });

  it('preserves unavailable state instead of collapsing into not_analyzed or measured', () => {
    const unavail = makeCapture('u1', {
      colorimetryAnalysis: makeColorimetryRecord('u1', {
        state: 'unavailable',
        unavailableReason: 'All ROIs had glare.',
        regions: [],
      }),
    });
    const measured = makeCapture('m1', {
      colorimetryAnalysis: makeColorimetryRecord('m1'),
    });
    const res1 = compareColorimetryAnalyses(
      unavail,
      measured,
      makeGate('u1', 'm1')
    );
    assert.equal(res1.state, 'unavailable');

    // Disjoint measured ROIs -> every region delta is unavailable -> top-level state must be unavailable
    const onlyForehead = makeCapture('d1', {
      colorimetryAnalysis: makeColorimetryRecord('d1', {
        regions: [
          makeRegionMetric('forehead', { state: 'measured' }),
          makeRegionMetric('anatomicalLeftCheek', { state: 'unavailable' }),
          makeRegionMetric('anatomicalRightCheek', { state: 'unavailable' }),
          makeRegionMetric('chin', { state: 'unavailable' }),
        ],
      }),
    });
    const onlyChin = makeCapture('d2', {
      colorimetryAnalysis: makeColorimetryRecord('d2', {
        regions: [
          makeRegionMetric('forehead', { state: 'unavailable' }),
          makeRegionMetric('anatomicalLeftCheek', { state: 'unavailable' }),
          makeRegionMetric('anatomicalRightCheek', { state: 'unavailable' }),
          makeRegionMetric('chin', { state: 'measured' }),
        ],
      }),
    });
    const res2 = compareColorimetryAnalyses(
      onlyForehead,
      onlyChin,
      makeGate('d1', 'd2')
    );
    assert.equal(res2.state, 'unavailable');
  });
});
