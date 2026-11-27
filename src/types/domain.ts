import type {
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
    rejectionReasons.push(...shutterGuidance.guidanceMessages);
  }

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
      depthValid: capture.depth.available
        ? (capture.depth.validPixelRatio ?? 0) >= 0.5
        : null,
      rejectionReasons,
    },
    analysis: {
      sessionId: capture.sessionId,
      modelVersion: null,
      preprocessingVersion: null,
      metricDefinitionVersion: null,
      state: 'not_analyzed',
      concerns: [
        {
          concern: 'acne_blemishes',
          state: 'not_analyzed',
          reason: 'No validated blemish model integrated in Milestone M0.',
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
      note: 'M0 records capture hardware behavior and local files only; detections are never fabricated.',
    },
  };
}
