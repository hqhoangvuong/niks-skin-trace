import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CandidateLesion,
  NativeCaptureRecord,
} from '../../plugins/truedepth-camera/src/definitions';
import { buildM0SessionEnvelope, type ComparisonRecord } from '../types/domain';
import {
  assignLesionToRegion,
  buildManualAnalysisRecord,
  compareBlemishAnalyses,
  isActiveBlemishCategory,
  summarizeRegionMetrics,
} from './blemishMetrics';

function makeCapture(
  id: string,
  overrides: Partial<NativeCaptureRecord> = {}
): NativeCaptureRecord {
  return {
    sessionId: id,
    capturedAtIso: '2026-11-27T05:23:26Z',
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
    depth: {
      available: true,
      width: 640,
      height: 480,
      validPixelRatio: 1,
      centerWindowMedianMeters: 0.3,
      estimatedMmPerPixelAtRgb: 0.1,
    },
    facialAlignment: {
      detected: true,
      faceCount: 1,
      coordinateOrigin: 'top_left_normalized',
      eyeCenterMidpoint: { x: 0.5, y: 0.4 },
      interEyeDistance: 0.2,
      eyeLineAngleDegrees: 0,
      regions: {
        forehead: { x: 0.3, y: 0.15, width: 0.4, height: 0.15 },
        anatomicalRightCheek: { x: 0.2, y: 0.45, width: 0.2, height: 0.2 },
        anatomicalLeftCheek: { x: 0.6, y: 0.45, width: 0.2, height: 0.2 },
        chin: { x: 0.35, y: 0.72, width: 0.3, height: 0.15 },
      },
    },
    captureDurationMs: 320,
    warnings: [],
    ...overrides,
  };
}

function makeComparableGate(
  baseId: string,
  currId: string,
  state: ComparisonRecord['comparabilityState'] = 'comparable'
): ComparisonRecord {
  return {
    baselineSessionId: baseId,
    currentSessionId: currId,
    view: 'front',
    comparabilityState: state,
    alignmentMode: 'eye_landmarks',
    reasons: state === 'comparable' ? ['Within bounds'] : ['Lighting shifted'],
    cautions: [],
    deltas: {},
    analysisStatus: 'not_analyzed',
  };
}

describe('blemishMetrics', () => {
  it('distinguishes not_analyzed from measured zero', () => {
    const unanalyzed = makeCapture('s1');
    const env = buildM0SessionEnvelope(unanalyzed);
    assert.equal(env.analysis.state, 'not_analyzed');

    const measuredZero = makeCapture('s2');
    measuredZero.blemishAnalysis = buildManualAnalysisRecord(
      's2',
      [],
      measuredZero
    );
    const zeroEnv = buildM0SessionEnvelope(measuredZero);
    assert.equal(zeroEnv.analysis.state, 'measured');
    const forehead = measuredZero.blemishAnalysis.regions.find(
      (r) => r.region === 'forehead'
    );
    assert.equal(forehead?.activeBlemishCount, 0);
    assert.equal(forehead?.residualMarkCount, 0);

    const cmp = compareBlemishAnalyses(
      unanalyzed,
      measuredZero,
      makeComparableGate('s1', 's2')
    );
    assert.equal(cmp.state, 'not_analyzed');
  });

  it('keeps residual PIE/PIH marks strictly separate from active blemishes', () => {
    assert.equal(isActiveBlemishCategory('papule_pustule'), true);
    assert.equal(isActiveBlemishCategory('comedone'), true);
    assert.equal(isActiveBlemishCategory('residual_red_mark_pie'), false);
    assert.equal(isActiveBlemishCategory('residual_dark_spot_pih'), false);

    const cap = makeCapture('s1');
    const lesions: CandidateLesion[] = [
      {
        id: 'l1',
        region: 'anatomicalLeftCheek',
        category: 'papule_pustule',
        centerNormalized: { x: 0.7, y: 0.55 },
        bboxNormalized: { x: 0.695, y: 0.545, width: 0.01, height: 0.01 },
        confidence: null,
        uncertaintyState: 'user_verified',
        source: 'manual_annotation',
      },
      {
        id: 'l2',
        region: 'anatomicalLeftCheek',
        category: 'residual_dark_spot_pih',
        centerNormalized: { x: 0.68, y: 0.56 },
        bboxNormalized: { x: 0.675, y: 0.555, width: 0.01, height: 0.01 },
        confidence: null,
        uncertaintyState: 'user_verified',
        source: 'manual_annotation',
      },
      {
        id: 'l3',
        region: 'anatomicalLeftCheek',
        category: 'residual_red_mark_pie',
        centerNormalized: { x: 0.72, y: 0.52 },
        bboxNormalized: { x: 0.715, y: 0.515, width: 0.01, height: 0.01 },
        confidence: null,
        uncertaintyState: 'user_verified',
        source: 'manual_annotation',
      },
    ];

    const summary = summarizeRegionMetrics(lesions, cap);
    const leftCheek = summary.find((r) => r.region === 'anatomicalLeftCheek');
    assert.equal(leftCheek?.activeBlemishCount, 1);
    assert.equal(leftCheek?.residualMarkCount, 2);
  });

  it('excludes user_rejected lesions and separates uncertain detections', () => {
    const cap = makeCapture('s1');
    const lesions: CandidateLesion[] = [
      {
        id: 'a1',
        region: 'forehead',
        category: 'comedone',
        centerNormalized: { x: 0.5, y: 0.2 },
        bboxNormalized: { x: 0.495, y: 0.195, width: 0.01, height: 0.01 },
        confidence: 0.8,
        uncertaintyState: 'confident',
        source: 'research_coreml_model',
      },
      {
        id: 'a2',
        region: 'forehead',
        category: 'papule_pustule',
        centerNormalized: { x: 0.45, y: 0.2 },
        bboxNormalized: { x: 0.445, y: 0.195, width: 0.01, height: 0.01 },
        confidence: 0.31,
        uncertaintyState: 'uncertain',
        source: 'research_coreml_model',
      },
      {
        id: 'a3',
        region: 'forehead',
        category: 'papule_pustule',
        centerNormalized: { x: 0.55, y: 0.2 },
        bboxNormalized: { x: 0.545, y: 0.195, width: 0.01, height: 0.01 },
        confidence: 0.75,
        uncertaintyState: 'user_rejected',
        source: 'research_coreml_model',
      },
    ];

    const summary = summarizeRegionMetrics(lesions, cap);
    const forehead = summary.find((r) => r.region === 'forehead');
    assert.equal(forehead?.activeBlemishCount, 1);
    assert.equal(forehead?.uncertainCount, 1);
    assert.ok(Math.abs((forehead?.affectedAreaNormalized ?? 0) - 0.0001) < 1e-8);
  });

  it('computes affectedAreaMm2 when calibrated and null when uncalibrated', () => {
    const calibrated = makeCapture('s1');
    const uncalibrated = makeCapture('s2', {
      depth: { available: false },
    });
    const lesions: CandidateLesion[] = [
      {
        id: 'l1',
        region: 'chin',
        category: 'papule_pustule',
        centerNormalized: { x: 0.5, y: 0.78 },
        bboxNormalized: { x: 0.495, y: 0.775, width: 0.01, height: 0.01 },
        confidence: null,
        uncertaintyState: 'user_verified',
        source: 'manual_annotation',
      },
    ];

    const calChin = summarizeRegionMetrics(lesions, calibrated).find(
      (r) => r.region === 'chin'
    );
    // 4032 * 3024 * 0.0001 * (0.1^2) = 12.192768 mm^2
    assert.ok(
      calChin !== undefined &&
        calChin.affectedAreaMm2 !== null &&
        Math.abs(calChin.affectedAreaMm2 - 12.192768) < 0.01
    );

    const uncalChin = summarizeRegionMetrics(lesions, uncalibrated).find(
      (r) => r.region === 'chin'
    );
    assert.equal(uncalChin?.affectedAreaMm2, null);
  });

  it('refuses longitudinal comparison on version drift or non-comparable captures', () => {
    const s1 = makeCapture('s1');
    s1.blemishAnalysis = buildManualAnalysisRecord('s1', [], s1);

    const s2 = makeCapture('s2');
    s2.blemishAnalysis = {
      ...buildManualAnalysisRecord('s2', [], s2),
      source: 'research_coreml_model',
      modelVersion: 'acne-research-v1',
    };

    const sourceMismatch = compareBlemishAnalyses(
      s1,
      s2,
      makeComparableGate('s1', 's2')
    );
    assert.equal(sourceMismatch.state, 'not_comparable');

    const s3 = makeCapture('s3');
    s3.blemishAnalysis = {
      ...buildManualAnalysisRecord('s3', [], s3),
      modelVersion: 'manual-v2',
    };
    const versionMismatch = compareBlemishAnalyses(
      s1,
      s3,
      makeComparableGate('s1', 's3')
    );
    assert.equal(versionMismatch.state, 'not_comparable');

    const s4 = makeCapture('s4');
    s4.blemishAnalysis = buildManualAnalysisRecord('s4', [], s4);
    const nonComparableGate = compareBlemishAnalyses(
      s1,
      s4,
      makeComparableGate('s1', 's4', 'not_comparable')
    );
    assert.equal(nonComparableGate.state, 'not_comparable');
  });

  it('associates persisting, candidate_new, and no_longer_detected lesions using alignment transform', () => {
    const s1 = makeCapture('s1');
    s1.blemishAnalysis = buildManualAnalysisRecord(
      's1',
      [
        {
          id: 'b1',
          region: 'anatomicalRightCheek',
          category: 'papule_pustule',
          centerNormalized: { x: 0.3, y: 0.5 },
          bboxNormalized: { x: 0.295, y: 0.495, width: 0.01, height: 0.01 },
          confidence: null,
          uncertaintyState: 'user_verified',
          source: 'manual_annotation',
        },
        {
          id: 'b2',
          region: 'forehead',
          category: 'comedone',
          centerNormalized: { x: 0.45, y: 0.2 },
          bboxNormalized: { x: 0.445, y: 0.195, width: 0.01, height: 0.01 },
          confidence: null,
          uncertaintyState: 'user_verified',
          source: 'manual_annotation',
        },
      ],
      s1
    );

    const s2 = makeCapture('s2', {
      facialAlignment: {
        ...s1.facialAlignment!,
        // Shifted right by +0.02 in normalized coordinates
        eyeCenterMidpoint: { x: 0.52, y: 0.4 },
      },
    });
    s2.blemishAnalysis = buildManualAnalysisRecord(
      's2',
      [
        {
          id: 'c1',
          region: 'anatomicalRightCheek',
          category: 'papule_pustule',
          // Same anatomical spot shifted by +0.02 + tiny 0.004 jitter
          centerNormalized: { x: 0.324, y: 0.502 },
          bboxNormalized: { x: 0.319, y: 0.497, width: 0.01, height: 0.01 },
          confidence: null,
          uncertaintyState: 'user_verified',
          source: 'manual_annotation',
        },
        {
          id: 'c2',
          region: 'chin',
          category: 'papule_pustule',
          centerNormalized: { x: 0.5, y: 0.8 },
          bboxNormalized: { x: 0.495, y: 0.795, width: 0.01, height: 0.01 },
          confidence: null,
          uncertaintyState: 'user_verified',
          source: 'manual_annotation',
        },
      ],
      s2
    );

    const res = compareBlemishAnalyses(s1, s2, makeComparableGate('s1', 's2'));
    assert.equal(res.state, 'measured');
    assert.equal(res.spatialMatchingAvailable, true);
    assert.equal(
      res.trackedLesions.filter((t) => t.status === 'persisting').length,
      1
    );
    assert.equal(
      res.trackedLesions.filter((t) => t.status === 'candidate_new').length,
      1
    );
    assert.equal(
      res.trackedLesions.filter((t) => t.status === 'no_longer_detected')
        .length,
      1
    );
  });

  it('handles older sessions missing facialAlignment without throwing', () => {
    assert.equal(assignLesionToRegion({ x: 0.5, y: 0.5 }, undefined), 'other');
    const legacy = makeCapture('old', { facialAlignment: undefined });
    const summary = summarizeRegionMetrics([], legacy);
    assert.equal(summary.length, 4);
  });
});
