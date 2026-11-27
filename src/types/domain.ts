import type {
  BlemishAnalysisRecord,
  CaptureView,
  NativeCaptureRecord,
} from '@skin-trace/truedepth-camera';

/**
 * Explicit data states from docs/skincare-iphone16pro-handoff.md §6.
 * Never coerce missing, unavailable, or unanalyzed states into 0.
 */
export type MetricAvailabilityState =
  | 'not_analyzed'
  | 'unavailable'
  | 'not_comparable'
  | 'measured';

export interface QualityAssessment {
  sessionId: string;
  algorithmVersion: string;
  acceptanceState: 'not_evaluated' | 'accepted' | 'rejected';
  depthValid: boolean | null;
  rejectionReasons: string[];
}

export interface ConcernMeasurement {
  concern: 'acne_blemishes' | 'dark_spots' | 'redness';
  state: MetricAvailabilityState;
  reason?: string;
}

export interface AnalysisResult {
  sessionId: string;
  modelVersion: string | null;
  preprocessingVersion: string | null;
  metricDefinitionVersion: string | null;
  state: MetricAvailabilityState;
  concerns: ConcernMeasurement[];
  note: string;
}

export interface ComparisonDeltas {
  distanceDeltaCm?: number;
  scaleDeltaPct?: number;
  yawDeltaDeg?: number;
  rollDeltaDeg?: number;
  exposureEvDelta?: number;
  wbRedDelta?: number;
  wbBlueDelta?: number;
}

export interface ComparisonRecord {
  baselineSessionId: string;
  currentSessionId: string;
  view: CaptureView;
  comparabilityState: 'not_comparable' | 'unavailable' | 'comparable';
  alignmentMode: 'eye_landmarks' | 'face_box' | 'unaligned';
  reasons: string[];
  cautions: string[];
  deltas: ComparisonDeltas;
  analysisStatus: MetricAvailabilityState;
}

export interface SessionEnvelope {
  capture: NativeCaptureRecord;
  quality: QualityAssessment;
  analysis: AnalysisResult;
}

export function buildM0SessionEnvelope(
  capture: NativeCaptureRecord
): SessionEnvelope {
  const shutterGuidance = capture.liveGuidanceAtShutter;
  const rejectionReasons: string[] = [];
  if (shutterGuidance && !shutterGuidance.readyToCapture) {
    rejectionReasons.push(...(shutterGuidance.guidanceMessages ?? []));
  }

  const blemish: BlemishAnalysisRecord | undefined = capture.blemishAnalysis;
  const blemishState: MetricAvailabilityState = blemish
    ? blemish.state
    : 'not_analyzed';

  return {
    capture,
    quality: {
      sessionId: capture.sessionId,
      algorithmVersion: shutterGuidance
        ? 'm0-live-guidance-pilot-v0'
        : 'm0-placeholder-v0',
      acceptanceState: shutterGuidance
        ? shutterGuidance.readyToCapture
          ? 'accepted'
          : 'rejected'
        : 'not_evaluated',
      depthValid: capture.depth?.available
        ? (capture.depth.validPixelRatio ?? 0) >= 0.5
        : null,
      rejectionReasons,
    },
    analysis: {
      sessionId: capture.sessionId,
      modelVersion: blemish?.modelVersion ?? null,
      preprocessingVersion: blemish?.preprocessingVersion ?? null,
      metricDefinitionVersion: blemish?.metricDefinitionVersion ?? null,
      state: blemishState,
      concerns: [
        {
          concern: 'acne_blemishes',
          state: blemishState,
          reason:
            blemish?.unavailableReason ??
            (blemish
              ? `Source: ${blemish.source} (${blemish.licenseScope})`
              : 'No blemish annotation or model analysis run yet.'),
        },
        {
          concern: 'dark_spots',
          state: 'not_analyzed',
          reason: 'Staged for Milestone M3.',
        },
        {
          concern: 'redness',
          state: 'not_analyzed',
          reason: 'Staged for Milestone M3.',
        },
      ],
      note: blemish
        ? `Persisted ${blemish.source} record (${blemish.modelVersion ?? 'unversioned'}).`
        : 'Capture recorded locally; blemish analysis has not been run.',
    },
  };
}
