import type {
  BlemishAnalysisRecord,
  CandidateLesion,
  FacialRegionId,
  FacialRegionMap,
  LesionCategory,
  NativeCaptureRecord,
  NormalizedPoint,
  NormalizedRect,
  RegionBlemishSummary,
} from '@skin-trace/truedepth-camera';
import type { ComparisonRecord, MetricAvailabilityState } from '../types/domain';
import { computePairAlignmentTransform } from './alignment';

export const STANDARD_FACIAL_REGIONS: FacialRegionId[] = [
  'forehead',
  'anatomicalLeftCheek',
  'anatomicalRightCheek',
  'chin',
];

export const METRIC_DEFINITION_VERSION = 'blemish-metrics-v1';

export interface RegionBlemishDelta {
  region: FacialRegionId;
  baselineActiveCount: number;
  currentActiveCount: number;
  activeDelta: number;
  baselineResidualCount: number;
  currentResidualCount: number;
  residualDelta: number;
  baselineAreaMm2: number | null;
  currentAreaMm2: number | null;
  areaDeltaMm2: number | null;
}

export type TrackedLesionStatus =
  | 'persisting'
  | 'candidate_new'
  | 'no_longer_detected';

export interface TrackedLesionMatch {
  id: string;
  status: TrackedLesionStatus;
  region: FacialRegionId;
  category: LesionCategory;
  /** Position in baseline image normalized [0, 1] coordinates for overlay rendering. */
  alignedCenterNormalized: NormalizedPoint;
  baselineLesionId?: string;
  currentLesionId?: string;
  distanceNormalized?: number;
}

export interface BlemishComparisonResult {
  state: MetricAvailabilityState;
  reasons: string[];
  spatialMatchingAvailable: boolean;
  regionDeltas: RegionBlemishDelta[];
  trackedLesions: TrackedLesionMatch[];
}

export function isActiveBlemishCategory(category: LesionCategory): boolean {
  return (
    category === 'comedone' ||
    category === 'papule_pustule' ||
    category === 'nodule_cyst' ||
    category === 'active_blemish_unspecified'
  );
}

function pointInRect(pt: NormalizedPoint, rect?: NormalizedRect): boolean {
  if (!rect) return false;
  return (
    pt.x >= rect.x &&
    pt.x <= rect.x + rect.width &&
    pt.y >= rect.y &&
    pt.y <= rect.y + rect.height
  );
}

export function assignLesionToRegion(
  center: NormalizedPoint,
  regions?: FacialRegionMap
): FacialRegionId {
  if (!regions) return 'other';
  if (pointInRect(center, regions.forehead)) return 'forehead';
  if (pointInRect(center, regions.anatomicalLeftCheek)) {
    return 'anatomicalLeftCheek';
  }
  if (pointInRect(center, regions.anatomicalRightCheek)) {
    return 'anatomicalRightCheek';
  }
  if (pointInRect(center, regions.chin)) return 'chin';
  return 'other';
}

export function summarizeRegionMetrics(
  lesions: CandidateLesion[],
  capture: NativeCaptureRecord
): RegionBlemishSummary[] {
  const mmPerPx = capture.depth?.estimatedMmPerPixelAtRgb;
  const hasScale =
    typeof mmPerPx === 'number' &&
    Number.isFinite(mmPerPx) &&
    mmPerPx > 0 &&
    capture.rgbDimensions.width > 0 &&
    capture.rgbDimensions.height > 0;
  const totalRgbPixels =
    capture.rgbDimensions.width * capture.rgbDimensions.height;

  const buckets = new Map<
    FacialRegionId,
    { active: number; residual: number; uncertain: number; normArea: number }
  >();

  for (const r of STANDARD_FACIAL_REGIONS) {
    buckets.set(r, { active: 0, residual: 0, uncertain: 0, normArea: 0 });
  }

  for (const lesion of lesions) {
    if (lesion.uncertaintyState === 'user_rejected') continue;
    const region = lesion.region;
    let bucket = buckets.get(region);
    if (!bucket) {
      bucket = { active: 0, residual: 0, uncertain: 0, normArea: 0 };
      buckets.set(region, bucket);
    }

    if (lesion.uncertaintyState === 'uncertain') {
      bucket.uncertain += 1;
      continue;
    }

    const boxArea = Math.max(
      0,
      lesion.bboxNormalized.width * lesion.bboxNormalized.height
    );
    bucket.normArea += boxArea;

    if (isActiveBlemishCategory(lesion.category)) {
      bucket.active += 1;
    } else {
      bucket.residual += 1;
    }
  }

  const orderedRegions: FacialRegionId[] = [...STANDARD_FACIAL_REGIONS];
  if (buckets.has('other')) {
    orderedRegions.push('other');
  }

  return orderedRegions.map((region) => {
    const b = buckets.get(region)!;
    const affectedAreaMm2 = hasScale
      ? b.normArea * totalRgbPixels * mmPerPx * mmPerPx
      : null;
    return {
      region,
      activeBlemishCount: b.active,
      residualMarkCount: b.residual,
      uncertainCount: b.uncertain,
      affectedAreaNormalized: b.normArea,
      affectedAreaMm2,
    };
  });
}

export function buildManualAnalysisRecord(
  sessionId: string,
  lesions: CandidateLesion[],
  capture: NativeCaptureRecord
): BlemishAnalysisRecord {
  const normalizedLesions = lesions.map((l) => ({
    ...l,
    region:
      l.region === 'other' && capture.facialAlignment?.regions
        ? assignLesionToRegion(l.centerNormalized, capture.facialAlignment.regions)
        : l.region,
  }));

  return {
    sessionId,
    analyzedAtIso: new Date().toISOString(),
    state: 'measured',
    source: 'manual_annotation',
    licenseScope: 'user_authored',
    modelVersion: 'manual-v1',
    preprocessingVersion: 'original-rgb-v1',
    metricDefinitionVersion: METRIC_DEFINITION_VERSION,
    computationTimeMs: 0,
    lesions: normalizedLesions,
    regions: summarizeRegionMetrics(normalizedLesions, capture),
    warnings: [],
  };
}

function projectCurrentPointToBaseline(
  pt: NormalizedPoint,
  baseline: NativeCaptureRecord,
  current: NativeCaptureRecord
): NormalizedPoint {
  const alignment = computePairAlignmentTransform(baseline, current);
  if (alignment.mode === 'unaligned') return pt;

  const currAnchor =
    alignment.mode === 'eye_landmarks' &&
    current.facialAlignment?.eyeCenterMidpoint
      ? current.facialAlignment.eyeCenterMidpoint
      : current.facialAlignment?.faceBoundingBox
        ? {
            x:
              current.facialAlignment.faceBoundingBox.x +
              current.facialAlignment.faceBoundingBox.width / 2,
            y:
              current.facialAlignment.faceBoundingBox.y +
              current.facialAlignment.faceBoundingBox.height / 2,
          }
        : { x: 0.5, y: 0.5 };

  const dx = (pt.x - currAnchor.x) * alignment.scaleFactor;
  const dy = (pt.y - currAnchor.y) * alignment.scaleFactor;
  const rad = (alignment.rotationDeltaDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;

  return {
    x: currAnchor.x + rx + alignment.translateXPct / 100,
    y: currAnchor.y + ry + alignment.translateYPct / 100,
  };
}

export function compareBlemishAnalyses(
  baseline: NativeCaptureRecord,
  current: NativeCaptureRecord,
  comparability: ComparisonRecord
): BlemishComparisonResult {
  const baseAnalysis = baseline.blemishAnalysis;
  const currAnalysis = current.blemishAnalysis;

  if (
    !baseAnalysis ||
    !currAnalysis ||
    baseAnalysis.state !== 'measured' ||
    currAnalysis.state !== 'measured'
  ) {
    return {
      state: 'not_analyzed',
      reasons: [
        'Both Baseline and Current sessions must have measured blemish annotations or model analysis to compare counts.',
      ],
      spatialMatchingAvailable: false,
      regionDeltas: [],
      trackedLesions: [],
    };
  }

  const mismatchReasons: string[] = [];
  if (comparability.comparabilityState !== 'comparable') {
    mismatchReasons.push(
      `Capture comparability gate is "${comparability.comparabilityState}" — blemish deltas are withheld.`
    );
  }
  if (baseAnalysis.source !== currAnalysis.source) {
    mismatchReasons.push(
      `Analysis source mismatch (${baseAnalysis.source} vs ${currAnalysis.source}).`
    );
  }
  if (baseAnalysis.modelVersion !== currAnalysis.modelVersion) {
    mismatchReasons.push(
      `Model version mismatch (${baseAnalysis.modelVersion ?? 'none'} vs ${currAnalysis.modelVersion ?? 'none'}).`
    );
  }
  if (baseAnalysis.preprocessingVersion !== currAnalysis.preprocessingVersion) {
    mismatchReasons.push(
      `Preprocessing version mismatch (${baseAnalysis.preprocessingVersion ?? 'none'} vs ${currAnalysis.preprocessingVersion ?? 'none'}).`
    );
  }
  if (
    baseAnalysis.metricDefinitionVersion !==
    currAnalysis.metricDefinitionVersion
  ) {
    mismatchReasons.push(
      `Metric definition version mismatch (${baseAnalysis.metricDefinitionVersion} vs ${currAnalysis.metricDefinitionVersion}).`
    );
  }

  if (mismatchReasons.length > 0) {
    return {
      state: 'not_comparable',
      reasons: mismatchReasons,
      spatialMatchingAvailable: false,
      regionDeltas: [],
      trackedLesions: [],
    };
  }

  const baseRegions = summarizeRegionMetrics(baseAnalysis.lesions, baseline);
  const currRegions = summarizeRegionMetrics(currAnalysis.lesions, current);
  const allRegionIds = new Set<FacialRegionId>([
    ...STANDARD_FACIAL_REGIONS,
    ...baseRegions.map((r) => r.region),
    ...currRegions.map((r) => r.region),
  ]);

  const regionDeltas: RegionBlemishDelta[] = Array.from(allRegionIds).map(
    (region) => {
      const b = baseRegions.find((r) => r.region === region);
      const c = currRegions.find((r) => r.region === region);
      const bAct = b?.activeBlemishCount ?? 0;
      const cAct = c?.activeBlemishCount ?? 0;
      const bRes = b?.residualMarkCount ?? 0;
      const cRes = c?.residualMarkCount ?? 0;
      const bMm2 = b?.affectedAreaMm2 ?? null;
      const cMm2 = c?.affectedAreaMm2 ?? null;
      return {
        region,
        baselineActiveCount: bAct,
        currentActiveCount: cAct,
        activeDelta: cAct - bAct,
        baselineResidualCount: bRes,
        currentResidualCount: cRes,
        residualDelta: cRes - bRes,
        baselineAreaMm2: bMm2,
        currentAreaMm2: cMm2,
        areaDeltaMm2: bMm2 !== null && cMm2 !== null ? cMm2 - bMm2 : null,
      };
    }
  );

  const alignment = computePairAlignmentTransform(baseline, current);
  const spatialMatchingAvailable = alignment.mode !== 'unaligned';
  const trackedLesions: TrackedLesionMatch[] = [];

  if (spatialMatchingAvailable) {
    const matchRadius = 0.03;
    const baseConfirmed = baseAnalysis.lesions.filter(
      (l) =>
        l.uncertaintyState !== 'user_rejected' &&
        l.uncertaintyState !== 'uncertain'
    );
    const currConfirmed = currAnalysis.lesions
      .filter(
        (l) =>
          l.uncertaintyState !== 'user_rejected' &&
          l.uncertaintyState !== 'uncertain'
      )
      .map((l) => ({
        lesion: l,
        alignedCenter: projectCurrentPointToBaseline(
          l.centerNormalized,
          baseline,
          current
        ),
      }));

    const matchedCurrIds = new Set<string>();
    for (const b of baseConfirmed) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < currConfirmed.length; i++) {
        const c = currConfirmed[i];
        if (matchedCurrIds.has(c.lesion.id)) continue;
        const dist = Math.hypot(
          b.centerNormalized.x - c.alignedCenter.x,
          b.centerNormalized.y - c.alignedCenter.y
        );
        if (dist <= matchRadius && dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        const c = currConfirmed[bestIdx];
        matchedCurrIds.add(c.lesion.id);
        trackedLesions.push({
          id: `persist-${b.id}-${c.lesion.id}`,
          status: 'persisting',
          region: c.lesion.region,
          category: c.lesion.category,
          alignedCenterNormalized: c.alignedCenter,
          baselineLesionId: b.id,
          currentLesionId: c.lesion.id,
          distanceNormalized: bestDist,
        });
      } else {
        trackedLesions.push({
          id: `gone-${b.id}`,
          status: 'no_longer_detected',
          region: b.region,
          category: b.category,
          alignedCenterNormalized: b.centerNormalized,
          baselineLesionId: b.id,
        });
      }
    }

    for (const c of currConfirmed) {
      if (matchedCurrIds.has(c.lesion.id)) continue;
      trackedLesions.push({
        id: `new-${c.lesion.id}`,
        status: 'candidate_new',
        region: c.lesion.region,
        category: c.lesion.category,
        alignedCenterNormalized: c.alignedCenter,
        currentLesionId: c.lesion.id,
      });
    }
  }

  return {
    state: 'measured',
    reasons: [
      `Compared compatible ${currAnalysis.source} (${currAnalysis.modelVersion ?? 'unversioned'}) records.`,
    ],
    spatialMatchingAvailable,
    regionDeltas,
    trackedLesions,
  };
}
