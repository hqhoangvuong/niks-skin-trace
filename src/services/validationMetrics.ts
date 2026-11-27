import type {
  CaptureView,
  ExperimentVariant,
  FacialRegionId,
  NativeCaptureRecord,
} from '@skin-trace/truedepth-camera';
import type { MetricAvailabilityState } from '../types/domain';
import { computePairAlignmentTransform } from './alignment';
import {
  compareBlemishAnalyses,
  STANDARD_FACIAL_REGIONS,
} from './blemishMetrics';
import { compareColorimetryAnalyses } from './colorimetryMetrics';
import { evaluateComparability } from './comparison';

export const VALIDATION_PROTOCOL_VERSION = 'm4-repeatability-v1';

export type RefusalReasonBucket =
  | 'view_mismatch'
  | 'mode_mismatch'
  | 'device_mismatch'
  | 'distance_shift'
  | 'yaw_shift'
  | 'exposure_ev_shift'
  | 'white_balance_shift'
  | 'missing_metadata'
  | 'version_mismatch'
  | 'other';

export interface ValidationThresholdConfig {
  thresholdsStatus: 'provisional_pilot_thresholds' | 'calibrated_thresholds';
  minSamplesPerVariant: number;
  minGeometricComparableRate: number;
  minColorComparableRate: number;
  maxInterEyeDistanceCvPct: number;
  maxYawSdDeg: number;
  maxRednessFalseChangeRate: number;
  maxDarkSpotFalseChangeRate: number;
  minDepthBenefitRelativeReduction: number;
}

export const DEFAULT_M4_THRESHOLDS: ValidationThresholdConfig = {
  thresholdsStatus: 'provisional_pilot_thresholds',
  minSamplesPerVariant: 5,
  minGeometricComparableRate: 0.8,
  minColorComparableRate: 0.8,
  maxInterEyeDistanceCvPct: 5.0,
  maxYawSdDeg: 4.0,
  maxRednessFalseChangeRate: 0.1,
  maxDarkSpotFalseChangeRate: 0.1,
  minDepthBenefitRelativeReduction: 0.15,
};

export interface VariantRepeatabilitySummary {
  variant: ExperimentVariant;
  sampleCount: number;
  sufficientForPreliminaryStats: boolean;
  sufficientForVerdict: boolean;
  evaluatedQualityCount: number;
  qualityAcceptanceRate: number | null;
  analyzedBlemishCount: number;
  analyzedColorimetryCount: number;
  // Geometric framing repeatability (apples-to-apples across A, B, C)
  interEyeDistanceMean: number | null;
  interEyeDistanceCvPct: number | null;
  yawSdDeg: number | null;
  rollSdDeg: number | null;
  pitchSdDeg: number | null;
  pairwiseScaleSpreadMedianPct: number | null;
  pairwiseScaleSpreadMaxPct: number | null;
  pairwiseTranslationMedianPct: number | null;
  pairwiseTranslationMaxPct: number | null;
  // TrueDepth metric repeatability (null when depth unavailable — never coerced to 0)
  depthAvailableCount: number;
  depthDistanceSdCm: number | null;
  depthDistanceRangeCm: number | null;
  mmPerPixelCvPct: number | null;
  meanValidDepthRatio: number | null;
  calibrationAvailableRate: number | null;
  // Pairwise comparability & refusal audit
  totalPairs: number;
  geometricComparablePairs: number;
  geometricComparableRate: number | null;
  colorComparablePairs: number;
  colorComparableRate: number | null;
  blemishComparablePairs: number;
  refusalReasonCounts: Partial<Record<RefusalReasonBucket, number>>;
  // Blemish repeatability (unchanged skin)
  activeBlemishCountSd: number | null;
  activeBlemishCountRange: number | null;
  normalizedAreaCvPct: number | null;
  calibratedAreaMm2CvPct: number | null;
  blemishFalseChangePairRate: number | null;
  // Colorimetry repeatability / false-change rate (unchanged skin)
  measuredRednessRegionPairs: number;
  measuredDarkSpotRegionPairs: number;
  rednessFalseChangeRegionRate: number | null;
  darkSpotFalseChangeRegionRate: number | null;
  medianAbsDeltaAStar: number | null;
  maxAbsDeltaAStar: number | null;
  maxAbsDeltaRednessAreaPctPts: number | null;
  maxAbsDeltaDarkSpotAreaPctPts: number | null;
  // Device performance
  medianCaptureDurationMs: number | null;
  p95CaptureDurationMs: number | null;
  medianBlemishComputeMs: number | null;
  medianColorimetryComputeMs: number | null;
}

export interface ThresholdGateCheck {
  id:
    | 'geometric_comparable_rate'
    | 'color_comparable_rate'
    | 'inter_eye_cv_pct'
    | 'yaw_sd_deg'
    | 'redness_false_change_rate'
    | 'dark_spot_false_change_rate';
  label: string;
  variant: ExperimentVariant;
  actualValue: number | null;
  actualDisplay: string;
  thresholdText: string;
  passed: boolean | null;
  note?: string;
}

export type TrueDepthDecisionVerdict =
  | 'insufficient_data'
  | 'truedepth_demonstrated_benefit'
  | 'guidance_sufficient_depth_optional'
  | 'thresholds_not_met';

export interface DepthVsGuidedComparison {
  interEyeCvRelativeReduction: number | null;
  yawSdRelativeReduction: number | null;
  colorComparableRateGain: number | null;
  withinVariantCMm2VsNormCvReduction: number | null;
  benefitReasons: string[];
}

export interface CohortVersionConsistency {
  blemishVersions: string[];
  colorimetryVersions: string[];
  blemishConsistent: boolean;
  colorimetryConsistent: boolean;
}

export interface ValidationCohortEvaluation {
  protocolVersion: string;
  thresholds: ValidationThresholdConfig;
  cohortValid: boolean;
  deviceModels: string[];
  systemVersions: string[];
  views: CaptureView[];
  totalSessionCount: number;
  blockers: string[];
  warnings: string[];
  versionConsistency: CohortVersionConsistency;
  variants: Record<ExperimentVariant, VariantRepeatabilitySummary>;
  gates: ThresholdGateCheck[];
  depthVsGuidedComparison: DepthVsGuidedComparison;
  verdict: TrueDepthDecisionVerdict;
  verdictRationale: string;
}

export interface LongitudinalRegionPoint {
  region: FacialRegionId;
  activeBlemishes: number | null;
  areaMm2: number | null;
  meanAStar: number | null;
  elevatedRednessPct: number | null;
  darkSpotAreaPct: number | null;
}

export interface LongitudinalDayPoint {
  dayKey: string;
  sessionId: string;
  capturedAtIso: string;
  variant: ExperimentVariant;
  effectiveCaptureMode: NativeCaptureRecord['effectiveCaptureMode'];
  comparabilityVsBaseline: 'baseline' | 'comparable' | 'not_comparable';
  comparabilityReasons: string[];
  blemishState: MetricAvailabilityState;
  colorimetryState: MetricAvailabilityState;
  totalActiveBlemishes: number | null;
  totalResidualMarks: number | null;
  totalAreaMm2: number | null;
  meanFaceAStar: number | null;
  meanRednessAreaPct: number | null;
  meanDarkSpotAreaPct: number | null;
  regions: LongitudinalRegionPoint[];
}

export interface LongitudinalTrendSummary {
  deviceModel: string | null;
  view: CaptureView | null;
  baselineSessionId: string | null;
  totalDays: number;
  comparableDays: number;
  notComparableDays: number;
  points: LongitudinalDayPoint[];
  notes: string[];
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function sampleSd(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values)!;
  const sumSq = values.reduce((acc, v) => acc + (v - avg) * (v - avg), 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

function cvPct(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values)!;
  if (Math.abs(avg) <= 1e-9) return null;
  const sd = sampleSd(values)!;
  return (sd / Math.abs(avg)) * 100;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * p))
  );
  return sorted[idx];
}

function classifyRefusalReason(reason: string): RefusalReasonBucket {
  const lower = reason.toLowerCase();
  if (lower.includes('view mismatch')) return 'view_mismatch';
  if (lower.includes('capture mode mismatch')) return 'mode_mismatch';
  if (lower.includes('different devices')) return 'device_mismatch';
  if (lower.includes('image scale shifted') || lower.includes('framing scale shift')) {
    return 'distance_shift';
  }
  if (lower.includes('missing') || lower.includes('unavailable')) {
    return 'missing_metadata';
  }
  if (lower.includes('distance')) return 'distance_shift';
  if (lower.includes('yaw')) return 'yaw_shift';
  if (lower.includes('ev') || lower.includes('exposure') || lower.includes('lighting')) {
    return 'exposure_ev_shift';
  }
  if (lower.includes('white-balance') || lower.includes('white balance')) {
    return 'white_balance_shift';
  }
  if (lower.includes('version') || lower.includes('mismatch')) {
    return 'version_mismatch';
  }
  return 'other';
}

function incrementBucket(
  counts: Partial<Record<RefusalReasonBucket, number>>,
  bucket: RefusalReasonBucket
) {
  counts[bucket] = (counts[bucket] ?? 0) + 1;
}

function blemishVersionSignature(s: NativeCaptureRecord): string | null {
  const b = s.blemishAnalysis;
  if (!b || b.state !== 'measured') return null;
  return `${b.source}|${b.modelVersion ?? 'none'}|${b.preprocessingVersion ?? 'none'}|${b.metricDefinitionVersion}`;
}

function colorimetryVersionSignature(s: NativeCaptureRecord): string | null {
  const c = s.colorimetryAnalysis;
  if (!c || c.state !== 'measured') return null;
  return `${c.algorithmVersion}|${c.metricDefinitionVersion}|${c.colorSpace}`;
}

export function computeVariantRepeatability(
  sessions: NativeCaptureRecord[],
  variant: ExperimentVariant,
  minSamplesForVerdict = DEFAULT_M4_THRESHOLDS.minSamplesPerVariant
): VariantRepeatabilitySummary {
  const filtered = sessions
    .filter((s) => s.requestedVariant === variant)
    .sort((a, b) => a.capturedAtIso.localeCompare(b.capturedAtIso));

  const n = filtered.length;
  const evaluatedQuality = filtered.filter(
    (s) => typeof s.liveGuidanceAtShutter?.readyToCapture === 'boolean'
  );
  const acceptedQuality = evaluatedQuality.filter(
    (s) => s.liveGuidanceAtShutter?.readyToCapture === true
  );

  const interEyes: number[] = [];
  const yaws: number[] = [];
  const rolls: number[] = [];
  const pitches: number[] = [];
  const depthDistancesCm: number[] = [];
  const mmPerPixels: number[] = [];
  const validDepthRatios: number[] = [];
  let depthAvailableCount = 0;
  let calibrationPresentCount = 0;

  const captureDurations: number[] = [];
  const blemishComputeMs: number[] = [];
  const colorimetryComputeMs: number[] = [];

  const activeCounts: number[] = [];
  const normalizedAreas: number[] = [];
  const calibratedAreasMm2: number[] = [];

  let analyzedBlemishCount = 0;
  let analyzedColorimetryCount = 0;

  // Identify dominant blemish version signature so per-session area CV% never mixes model versions.
  const blemishVersionCounts = new Map<string, number>();
  for (const s of filtered) {
    const sig = blemishVersionSignature(s);
    if (sig) {
      blemishVersionCounts.set(sig, (blemishVersionCounts.get(sig) ?? 0) + 1);
    }
  }
  let dominantBlemishSig: string | null = null;
  let dominantBlemishMax = 0;
  for (const [sig, count] of blemishVersionCounts.entries()) {
    if (count > dominantBlemishMax) {
      dominantBlemishMax = count;
      dominantBlemishSig = sig;
    }
  }

  for (const s of filtered) {
    if (isFiniteNum(s.captureDurationMs)) {
      captureDurations.push(s.captureDurationMs);
    }
    if (isFiniteNum(s.facialAlignment?.interEyeDistance)) {
      interEyes.push(s.facialAlignment!.interEyeDistance!);
    }
    const yaw =
      s.facialAlignment?.poseDegrees?.yawDegrees ??
      s.liveGuidanceAtShutter?.yawDegrees;
    const roll =
      s.facialAlignment?.poseDegrees?.rollDegrees ??
      s.liveGuidanceAtShutter?.rollDegrees;
    const pitch =
      s.facialAlignment?.poseDegrees?.pitchDegrees ??
      s.liveGuidanceAtShutter?.pitchDegrees;
    if (isFiniteNum(yaw)) yaws.push(yaw);
    if (isFiniteNum(roll)) rolls.push(roll);
    if (isFiniteNum(pitch)) pitches.push(pitch);

    if (s.depth?.available) {
      depthAvailableCount += 1;
      if (isFiniteNum(s.depth.centerWindowMedianMeters)) {
        depthDistancesCm.push(s.depth.centerWindowMedianMeters * 100);
      }
      if (isFiniteNum(s.depth.estimatedMmPerPixelAtRgb)) {
        mmPerPixels.push(s.depth.estimatedMmPerPixelAtRgb);
      }
      if (isFiniteNum(s.depth.validPixelRatio)) {
        validDepthRatios.push(s.depth.validPixelRatio);
      }
      if (s.depth.calibration?.present) {
        calibrationPresentCount += 1;
      }
    }

    if (s.blemishAnalysis?.state === 'measured') {
      analyzedBlemishCount += 1;
      if (isFiniteNum(s.blemishAnalysis.computationTimeMs)) {
        blemishComputeMs.push(s.blemishAnalysis.computationTimeMs);
      }
      const sig = blemishVersionSignature(s);
      if (!dominantBlemishSig || sig === dominantBlemishSig) {
        const stdRegions = (s.blemishAnalysis.regions ?? []).filter((r) =>
          STANDARD_FACIAL_REGIONS.includes(r.region)
        );
        if (stdRegions.length > 0) {
          const totalActive = stdRegions.reduce(
            (sum, r) => sum + (isFiniteNum(r.activeBlemishCount) ? r.activeBlemishCount : 0),
            0
          );
          const totalNormArea = stdRegions.reduce(
            (sum, r) =>
              sum + (isFiniteNum(r.affectedAreaNormalized) ? r.affectedAreaNormalized : 0),
            0
          );
          activeCounts.push(totalActive);
          normalizedAreas.push(totalNormArea);

          if (stdRegions.every((r) => isFiniteNum(r.affectedAreaMm2))) {
            const totalMm2 = stdRegions.reduce(
              (sum, r) => sum + (r.affectedAreaMm2 as number),
              0
            );
            calibratedAreasMm2.push(totalMm2);
          }
        }
      }
    }

    if (s.colorimetryAnalysis?.state === 'measured') {
      analyzedColorimetryCount += 1;
      if (isFiniteNum(s.colorimetryAnalysis.computationTimeMs)) {
        colorimetryComputeMs.push(s.colorimetryAnalysis.computationTimeMs);
      }
    }
  }

  // Pairwise analysis across all unordered pairs (i < j)
  let totalPairs = 0;
  let geometricComparablePairs = 0;
  let analyzedColorPairs = 0;
  let colorComparablePairs = 0;
  let blemishComparablePairs = 0;
  let blemishFalseChangePairs = 0;
  let measuredRednessRegionPairs = 0;
  let rednessFalseChangeRegions = 0;
  let measuredDarkSpotRegionPairs = 0;
  let darkSpotFalseChangeRegions = 0;

  const scaleSpreadsPct: number[] = [];
  const translationShiftsPct: number[] = [];
  const absDeltaAStars: number[] = [];
  const absDeltaRednessAreas: number[] = [];
  const absDeltaDarkSpotAreas: number[] = [];
  const refusalReasonCounts: Partial<Record<RefusalReasonBucket, number>> = {};

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      totalPairs += 1;
      const base = filtered[i];
      const curr = filtered[j];

      const align = computePairAlignmentTransform(base, curr);
      if (align.mode !== 'unaligned') {
        scaleSpreadsPct.push(Math.abs(align.scaleFactor - 1) * 100);
        translationShiftsPct.push(
          Math.hypot(align.translateXPct, align.translateYPct)
        );
      }

      const comp = evaluateComparability(base, curr);
      if (comp.comparabilityState === 'comparable') {
        geometricComparablePairs += 1;
      } else {
        for (const r of comp.reasons) {
          incrementBucket(refusalReasonCounts, classifyRefusalReason(r));
        }
      }

      const blemishComp = compareBlemishAnalyses(base, curr, comp);
      if (blemishComp.state === 'measured') {
        blemishComparablePairs += 1;
        const anyDelta = blemishComp.regionDeltas.some(
          (d) => d.activeDelta !== 0
        );
        if (anyDelta) {
          blemishFalseChangePairs += 1;
        }
      }

      const bothColorAnalyzed =
        base.colorimetryAnalysis !== undefined &&
        curr.colorimetryAnalysis !== undefined;
      if (bothColorAnalyzed) {
        analyzedColorPairs += 1;
      }

      const colorComp = compareColorimetryAnalyses(base, curr, comp);
      if (colorComp.state === 'measured') {
        colorComparablePairs += 1;
        for (const rd of colorComp.regionDeltas) {
          if (rd.state !== 'measured') continue;
          if (rd.rednessStatus !== 'unavailable') {
            measuredRednessRegionPairs += 1;
            if (
              rd.rednessStatus === 'increased_appearance' ||
              rd.rednessStatus === 'decreased_appearance'
            ) {
              rednessFalseChangeRegions += 1;
            }
          }
          if (rd.darkSpotStatus !== 'unavailable') {
            measuredDarkSpotRegionPairs += 1;
            if (
              rd.darkSpotStatus === 'increased_appearance' ||
              rd.darkSpotStatus === 'decreased_appearance'
            ) {
              darkSpotFalseChangeRegions += 1;
            }
          }
          if (isFiniteNum(rd.deltaAStar)) {
            absDeltaAStars.push(Math.abs(rd.deltaAStar));
          }
          if (isFiniteNum(rd.deltaRednessAreaPctPts)) {
            absDeltaRednessAreas.push(Math.abs(rd.deltaRednessAreaPctPts));
          }
          if (isFiniteNum(rd.deltaDarkSpotAreaPctPts)) {
            absDeltaDarkSpotAreas.push(Math.abs(rd.deltaDarkSpotAreaPctPts));
          }
        }
      } else if (
        colorComp.state === 'not_comparable' &&
        comp.comparabilityState === 'comparable'
      ) {
        // Count stricter color-gate refusals that passed M1 geometric gate.
        for (const r of colorComp.reasons) {
          incrementBucket(refusalReasonCounts, classifyRefusalReason(r));
        }
      }
    }
  }

  const depthRangeCm =
    depthDistancesCm.length >= 2
      ? Math.max(...depthDistancesCm) - Math.min(...depthDistancesCm)
      : null;

  const activeRange =
    activeCounts.length >= 2
      ? Math.max(...activeCounts) - Math.min(...activeCounts)
      : null;

  return {
    variant,
    sampleCount: n,
    sufficientForPreliminaryStats: n >= 3,
    sufficientForVerdict: n >= minSamplesForVerdict,
    evaluatedQualityCount: evaluatedQuality.length,
    qualityAcceptanceRate:
      evaluatedQuality.length > 0
        ? acceptedQuality.length / evaluatedQuality.length
        : null,
    analyzedBlemishCount,
    analyzedColorimetryCount,
    interEyeDistanceMean: mean(interEyes),
    interEyeDistanceCvPct: cvPct(interEyes),
    yawSdDeg: sampleSd(yaws),
    rollSdDeg: sampleSd(rolls),
    pitchSdDeg: sampleSd(pitches),
    pairwiseScaleSpreadMedianPct: percentile(scaleSpreadsPct, 0.5),
    pairwiseScaleSpreadMaxPct:
      scaleSpreadsPct.length > 0 ? Math.max(...scaleSpreadsPct) : null,
    pairwiseTranslationMedianPct: percentile(translationShiftsPct, 0.5),
    pairwiseTranslationMaxPct:
      translationShiftsPct.length > 0 ? Math.max(...translationShiftsPct) : null,
    depthAvailableCount,
    depthDistanceSdCm: sampleSd(depthDistancesCm),
    depthDistanceRangeCm: depthRangeCm,
    mmPerPixelCvPct: cvPct(mmPerPixels),
    meanValidDepthRatio: mean(validDepthRatios),
    calibrationAvailableRate:
      depthAvailableCount > 0
        ? calibrationPresentCount / depthAvailableCount
        : null,
    totalPairs,
    geometricComparablePairs,
    geometricComparableRate:
      totalPairs > 0 ? geometricComparablePairs / totalPairs : null,
    colorComparablePairs,
    colorComparableRate:
      analyzedColorPairs > 0 ? colorComparablePairs / analyzedColorPairs : null,
    blemishComparablePairs,
    refusalReasonCounts,
    activeBlemishCountSd: sampleSd(activeCounts),
    activeBlemishCountRange: activeRange,
    normalizedAreaCvPct: cvPct(normalizedAreas),
    calibratedAreaMm2CvPct: cvPct(calibratedAreasMm2),
    blemishFalseChangePairRate:
      blemishComparablePairs > 0
        ? blemishFalseChangePairs / blemishComparablePairs
        : null,
    measuredRednessRegionPairs,
    measuredDarkSpotRegionPairs,
    rednessFalseChangeRegionRate:
      measuredRednessRegionPairs > 0
        ? rednessFalseChangeRegions / measuredRednessRegionPairs
        : null,
    darkSpotFalseChangeRegionRate:
      measuredDarkSpotRegionPairs > 0
        ? darkSpotFalseChangeRegions / measuredDarkSpotRegionPairs
        : null,
    medianAbsDeltaAStar: percentile(absDeltaAStars, 0.5),
    maxAbsDeltaAStar:
      absDeltaAStars.length > 0 ? Math.max(...absDeltaAStars) : null,
    maxAbsDeltaRednessAreaPctPts:
      absDeltaRednessAreas.length > 0 ? Math.max(...absDeltaRednessAreas) : null,
    maxAbsDeltaDarkSpotAreaPctPts:
      absDeltaDarkSpotAreas.length > 0
        ? Math.max(...absDeltaDarkSpotAreas)
        : null,
    medianCaptureDurationMs: percentile(captureDurations, 0.5),
    p95CaptureDurationMs: percentile(captureDurations, 0.95),
    medianBlemishComputeMs: percentile(blemishComputeMs, 0.5),
    medianColorimetryComputeMs: percentile(colorimetryComputeMs, 0.5),
  };
}

function fmtPct(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function fmtNum(val: number | null, suffix = '', decimals = 2): string {
  return val === null ? '—' : `${val.toFixed(decimals)}${suffix}`;
}

function evaluateVariantGates(
  summary: VariantRepeatabilitySummary,
  thresholds: ValidationThresholdConfig
): ThresholdGateCheck[] {
  const hasColorimetry = summary.analyzedColorimetryCount >= 2;
  const enoughForStats = summary.sampleCount >= 2;

  return [
    {
      id: 'geometric_comparable_rate',
      label: 'Geometric comparability rate',
      variant: summary.variant,
      actualValue: summary.geometricComparableRate,
      actualDisplay: fmtPct(summary.geometricComparableRate),
      thresholdText: `≥ ${(thresholds.minGeometricComparableRate * 100).toFixed(0)}%`,
      passed: enoughForStats
        ? summary.geometricComparableRate !== null &&
          summary.geometricComparableRate >= thresholds.minGeometricComparableRate
        : null,
    },
    {
      id: 'color_comparable_rate',
      label: 'Color-consistency comparability rate',
      variant: summary.variant,
      actualValue: summary.colorComparableRate,
      actualDisplay: fmtPct(summary.colorComparableRate),
      thresholdText: `≥ ${(thresholds.minColorComparableRate * 100).toFixed(0)}%`,
      passed: !hasColorimetry
        ? null
        : summary.colorComparableRate !== null &&
          summary.colorComparableRate >= thresholds.minColorComparableRate,
      note: !hasColorimetry
        ? 'Run CIELAB colorimetry on at least 2 sessions.'
        : undefined,
    },
    {
      id: 'inter_eye_cv_pct',
      label: 'Framing scale stability (Inter-eye CV%)',
      variant: summary.variant,
      actualValue: summary.interEyeDistanceCvPct,
      actualDisplay: fmtNum(summary.interEyeDistanceCvPct, '%', 2),
      thresholdText: `≤ ${thresholds.maxInterEyeDistanceCvPct.toFixed(1)}%`,
      passed: !enoughForStats
        ? null
        : summary.interEyeDistanceCvPct !== null &&
          summary.interEyeDistanceCvPct <= thresholds.maxInterEyeDistanceCvPct,
    },
    {
      id: 'yaw_sd_deg',
      label: 'Head yaw stability (SD)',
      variant: summary.variant,
      actualValue: summary.yawSdDeg,
      actualDisplay: fmtNum(summary.yawSdDeg, '°', 2),
      thresholdText: `≤ ${thresholds.maxYawSdDeg.toFixed(1)}°`,
      passed: !enoughForStats
        ? null
        : summary.yawSdDeg !== null &&
          summary.yawSdDeg <= thresholds.maxYawSdDeg,
    },
    {
      id: 'redness_false_change_rate',
      label: 'Redness false-change rate (unchanged skin)',
      variant: summary.variant,
      actualValue: summary.rednessFalseChangeRegionRate,
      actualDisplay: fmtPct(summary.rednessFalseChangeRegionRate),
      thresholdText: `≤ ${(thresholds.maxRednessFalseChangeRate * 100).toFixed(0)}%`,
      passed: !hasColorimetry
        ? null
        : summary.rednessFalseChangeRegionRate !== null &&
          summary.rednessFalseChangeRegionRate <=
            thresholds.maxRednessFalseChangeRate,
      note:
        hasColorimetry && summary.rednessFalseChangeRegionRate === null
          ? '0 comparable color pairs — cannot pass false-change gate.'
          : undefined,
    },
    {
      id: 'dark_spot_false_change_rate',
      label: 'Dark-spot false-change rate (unchanged skin)',
      variant: summary.variant,
      actualValue: summary.darkSpotFalseChangeRegionRate,
      actualDisplay: fmtPct(summary.darkSpotFalseChangeRegionRate),
      thresholdText: `≤ ${(thresholds.maxDarkSpotFalseChangeRate * 100).toFixed(0)}%`,
      passed: !hasColorimetry
        ? null
        : summary.darkSpotFalseChangeRegionRate !== null &&
          summary.darkSpotFalseChangeRegionRate <=
            thresholds.maxDarkSpotFalseChangeRate,
      note:
        hasColorimetry && summary.darkSpotFalseChangeRegionRate === null
          ? '0 comparable color pairs — cannot pass false-change gate.'
          : undefined,
    },
  ];
}

export function evaluateValidationCohort(
  sessions: NativeCaptureRecord[],
  options: { thresholds?: Partial<ValidationThresholdConfig> } = {}
): ValidationCohortEvaluation {
  const thresholds: ValidationThresholdConfig = {
    ...DEFAULT_M4_THRESHOLDS,
    ...(options.thresholds ?? {}),
  };

  const deviceModels = Array.from(new Set(sessions.map((s) => s.deviceModel))).sort();
  const systemVersions = Array.from(new Set(sessions.map((s) => s.systemVersion))).sort();
  const views = Array.from(new Set(sessions.map((s) => s.view))).sort() as CaptureView[];

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (sessions.length === 0) {
    blockers.push('No capture sessions selected for validation cohort.');
  }
  if (deviceModels.length > 1) {
    blockers.push(
      `Cross-device contamination blocked: cohort mixes ${deviceModels.join(', ')}. Filter to a single physical device.`
    );
  }
  if (views.length > 1) {
    blockers.push(
      `Cross-view contamination blocked: cohort mixes ${views.join(', ')}. Evaluate one capture view at a time.`
    );
  }
  if (sessions.some((s) => s.isSimulatedOrWebFallback)) {
    warnings.push(
      'One or more captures came from web fallback / simulator — hardware repeatability claims require physical iPhone captures.'
    );
  }

  const blemishVersions = Array.from(
    new Set(
      sessions
        .map(blemishVersionSignature)
        .filter((v): v is string => v !== null)
    )
  ).sort();
  const colorimetryVersions = Array.from(
    new Set(
      sessions
        .map(colorimetryVersionSignature)
        .filter((v): v is string => v !== null)
    )
  ).sort();

  const versionConsistency: CohortVersionConsistency = {
    blemishVersions,
    colorimetryVersions,
    blemishConsistent: blemishVersions.length <= 1,
    colorimetryConsistent: colorimetryVersions.length <= 1,
  };

  if (!versionConsistency.blemishConsistent) {
    blockers.push(
      `Blemish model/preprocessing version drift across cohort (${blemishVersions.join(' vs ')}). Re-run blemish analysis with one version before comparing variants.`
    );
  }
  if (!versionConsistency.colorimetryConsistent) {
    blockers.push(
      `Colorimetry algorithm version drift across cohort (${colorimetryVersions.join(' vs ')}). Re-run CIELAB analysis with one version before comparing variants.`
    );
  }

  const cohortValid =
    sessions.length > 0 && deviceModels.length === 1 && views.length === 1;
  const hasSimulatedOrFallback = sessions.some(
    (s) => s.isSimulatedOrWebFallback
  );

  const variantA = computeVariantRepeatability(
    sessions,
    'rgb_unguided',
    thresholds.minSamplesPerVariant
  );
  const variantB = computeVariantRepeatability(
    sessions,
    'rgb_guided',
    thresholds.minSamplesPerVariant
  );
  const variantC = computeVariantRepeatability(
    sessions,
    'rgb_depth_guided',
    thresholds.minSamplesPerVariant
  );

  const variantCMissingDepth =
    variantC.sampleCount > 0 &&
    variantC.depthAvailableCount < variantC.sampleCount;
  if (variantCMissingDepth) {
    warnings.push(
      `Variant C has ${variantC.sampleCount - variantC.depthAvailableCount} capture(s) without TrueDepth depth data — RGB-only fallbacks are not counted as depth-assisted captures.`
    );
  }

  const cohortBlocked =
    !cohortValid ||
    !versionConsistency.blemishConsistent ||
    !versionConsistency.colorimetryConsistent;

  const rawGatesB = evaluateVariantGates(variantB, thresholds);
  const rawGatesC = evaluateVariantGates(variantC, thresholds);
  const gates = cohortBlocked
    ? [...rawGatesB, ...rawGatesC].map((g) => ({
        ...g,
        passed: null,
        note: 'Withheld due to cohort device/view/version blocker.',
      }))
    : [...rawGatesB, ...rawGatesC];

  let interEyeCvRelativeReduction: number | null = null;
  let yawSdRelativeReduction: number | null = null;
  let colorComparableRateGain: number | null = null;
  let withinVariantCMm2VsNormCvReduction: number | null = null;
  const benefitReasons: string[] = [];

  const variantCHasTrueDepth =
    !hasSimulatedOrFallback &&
    variantC.depthAvailableCount >= thresholds.minSamplesPerVariant;

  if (!cohortBlocked && variantCHasTrueDepth) {
    interEyeCvRelativeReduction =
      variantB.interEyeDistanceCvPct !== null &&
      variantC.interEyeDistanceCvPct !== null &&
      variantB.interEyeDistanceCvPct > 1e-6
        ? (variantB.interEyeDistanceCvPct - variantC.interEyeDistanceCvPct) /
          variantB.interEyeDistanceCvPct
        : null;

    yawSdRelativeReduction =
      variantB.yawSdDeg !== null &&
      variantC.yawSdDeg !== null &&
      variantB.yawSdDeg > 1e-6
        ? (variantB.yawSdDeg - variantC.yawSdDeg) / variantB.yawSdDeg
        : null;

    colorComparableRateGain =
      variantB.colorComparableRate !== null &&
      variantC.colorComparableRate !== null
        ? variantC.colorComparableRate - variantB.colorComparableRate
        : null;

    withinVariantCMm2VsNormCvReduction =
      variantC.normalizedAreaCvPct !== null &&
      variantC.calibratedAreaMm2CvPct !== null &&
      variantC.normalizedAreaCvPct > 1e-6
        ? (variantC.normalizedAreaCvPct - variantC.calibratedAreaMm2CvPct) /
          variantC.normalizedAreaCvPct
        : null;

    if (
      interEyeCvRelativeReduction !== null &&
      interEyeCvRelativeReduction >= thresholds.minDepthBenefitRelativeReduction
    ) {
      benefitReasons.push(
        `Reduced framing scale CV% by ${(interEyeCvRelativeReduction * 100).toFixed(1)}% vs guided RGB alone.`
      );
    }
    if (
      yawSdRelativeReduction !== null &&
      yawSdRelativeReduction >= thresholds.minDepthBenefitRelativeReduction
    ) {
      benefitReasons.push(
        `Reduced head yaw SD by ${(yawSdRelativeReduction * 100).toFixed(1)}% vs guided RGB alone.`
      );
    }
    if (colorComparableRateGain !== null && colorComparableRateGain >= 0.1) {
      benefitReasons.push(
        `Increased color-comparable pair rate by +${(colorComparableRateGain * 100).toFixed(1)} percentage points vs guided RGB.`
      );
    }
    if (
      withinVariantCMm2VsNormCvReduction !== null &&
      withinVariantCMm2VsNormCvReduction >=
        thresholds.minDepthBenefitRelativeReduction
    ) {
      benefitReasons.push(
        `TrueDepth mm/px scaling reduced physical lesion area CV% by ${(withinVariantCMm2VsNormCvReduction * 100).toFixed(1)}% vs raw normalized area.`
      );
    }
  }

  let verdict: TrueDepthDecisionVerdict;
  let verdictRationale: string;

  const bAllColorAnalyzed =
    variantB.sampleCount > 0 &&
    variantB.analyzedColorimetryCount === variantB.sampleCount;
  const cAllColorAnalyzed =
    variantC.sampleCount > 0 &&
    variantC.analyzedColorimetryCount === variantC.sampleCount;

  if (cohortBlocked) {
    verdict = 'insufficient_data';
    verdictRationale =
      blockers[0] ?? 'Cohort has unresolved device, view, or version blockers.';
  } else if (hasSimulatedOrFallback) {
    verdict = 'insufficient_data';
    verdictRationale =
      'Cohort contains web-fallback or simulator captures — TrueDepth repeatability verdicts require physical iPhone captures.';
  } else if (
    !variantB.sufficientForVerdict ||
    !variantC.sufficientForVerdict
  ) {
    verdict = 'insufficient_data';
    verdictRationale = `Need at least ${thresholds.minSamplesPerVariant} captures in both Variant B (currently ${variantB.sampleCount}) and Variant C (currently ${variantC.sampleCount}) to evaluate TrueDepth benefit.`;
  } else if (!variantCHasTrueDepth) {
    verdict = 'insufficient_data';
    verdictRationale = `Variant C requires at least ${thresholds.minSamplesPerVariant} physical captures with TrueDepth depth data (currently ${variantC.depthAvailableCount}/${variantC.sampleCount}) before evaluating TrueDepth benefit.`;
  } else if (!bAllColorAnalyzed || !cAllColorAnalyzed) {
    verdict = 'insufficient_data';
    verdictRationale = `Analyze all Variant B (${variantB.analyzedColorimetryCount}/${variantB.sampleCount}) and Variant C (${variantC.analyzedColorimetryCount}/${variantC.sampleCount}) sessions with CIELAB colorimetry before scoring false-change thresholds.`;
  } else {
    const bAllPassed = rawGatesB.every((g) => g.passed === true);
    const cAllPassed = rawGatesC.every((g) => g.passed === true);

    if (cAllPassed && benefitReasons.length > 0) {
      verdict = 'truedepth_demonstrated_benefit';
      verdictRationale = `Variant C (RGB + TrueDepth) met all provisional pilot thresholds and outperformed Variant B: ${benefitReasons.join(' ')}`;
    } else if (bAllPassed) {
      verdict = 'guidance_sufficient_depth_optional';
      verdictRationale =
        'Variant B (2D RGB guidance) met all provisional pilot thresholds, and Variant C did not exceed the ≥15% relative improvement margin. Keep TrueDepth optional unless longitudinal data shows added value.';
    } else {
      verdict = 'thresholds_not_met';
      const failedLabels = gates
        .filter((g) => g.passed === false)
        .map((g) => `${g.variant}: ${g.label} (${g.actualDisplay}, need ${g.thresholdText})`);
      verdictRationale = `Provisional pilot thresholds not yet met: ${failedLabels.join('; ')}.`;
    }
  }

  return {
    protocolVersion: VALIDATION_PROTOCOL_VERSION,
    thresholds,
    cohortValid,
    deviceModels,
    systemVersions,
    views,
    totalSessionCount: sessions.length,
    blockers,
    warnings,
    versionConsistency,
    variants: {
      rgb_unguided: variantA,
      rgb_guided: variantB,
      rgb_depth_guided: variantC,
    },
    gates,
    depthVsGuidedComparison: {
      interEyeCvRelativeReduction,
      yawSdRelativeReduction,
      colorComparableRateGain,
      withinVariantCMm2VsNormCvReduction,
      benefitReasons,
    },
    verdict,
    verdictRationale,
  };
}

function toDayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function buildLongitudinalTrendSummary(
  sessions: NativeCaptureRecord[],
  options: { view?: CaptureView; deviceModel?: string } = {}
): LongitudinalTrendSummary {
  const filtered = sessions
    .filter((s) => (options.view ? s.view === options.view : true))
    .filter((s) =>
      options.deviceModel ? s.deviceModel === options.deviceModel : true
    )
    .sort((a, b) => a.capturedAtIso.localeCompare(b.capturedAtIso));

  if (filtered.length === 0) {
    return {
      deviceModel: options.deviceModel ?? null,
      view: options.view ?? null,
      baselineSessionId: null,
      totalDays: 0,
      comparableDays: 0,
      notComparableDays: 0,
      points: [],
      notes: ['No sessions match the selected device and view for longitudinal tracking.'],
    };
  }

  // Pick one representative session per calendar day (latest accepted/analyzed shot on that day).
  const byDay = new Map<string, NativeCaptureRecord[]>();
  for (const s of filtered) {
    const key = toDayKey(s.capturedAtIso);
    const list = byDay.get(key) ?? [];
    list.push(s);
    byDay.set(key, list);
  }

  const dayEntries = Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dayKey, list]) => {
      // Prefer TrueDepth guided captures (+8), then analyzed & accepted quality shots; tie-break by latest.
      const ranked = [...list].sort((a, b) => {
        const score = (s: NativeCaptureRecord) =>
          (s.requestedVariant === 'rgb_depth_guided' && s.depth?.available ? 8 : 0) +
          (s.colorimetryAnalysis?.state === 'measured' ? 4 : 0) +
          (s.blemishAnalysis?.state === 'measured' ? 2 : 0) +
          (s.liveGuidanceAtShutter?.readyToCapture === true ? 1 : 0);
        const diff = score(b) - score(a);
        return diff !== 0 ? diff : b.capturedAtIso.localeCompare(a.capturedAtIso);
      });
      return { dayKey, session: ranked[0] };
    });

  const baseline = dayEntries[0].session;
  let comparableDays = 0;
  let notComparableDays = 0;

  const points: LongitudinalDayPoint[] = dayEntries.map(({ dayKey, session }, idx) => {
    let comparabilityVsBaseline: LongitudinalDayPoint['comparabilityVsBaseline'] =
      'baseline';
    let comparabilityReasons: string[] = ['Longitudinal Day 1 baseline'];

    if (idx > 0) {
      const comp = evaluateComparability(baseline, session);
      const colorComp = compareColorimetryAnalyses(baseline, session, comp);
      const blemishComp = compareBlemishAnalyses(baseline, session, comp);

      const combinedBlockers: string[] = [];
      if (comp.comparabilityState !== 'comparable') {
        combinedBlockers.push(...comp.reasons);
      }
      if (colorComp.state === 'not_comparable') {
        combinedBlockers.push(...colorComp.reasons);
      }
      if (blemishComp.state === 'not_comparable') {
        combinedBlockers.push(...blemishComp.reasons);
      }

      if (combinedBlockers.length === 0) {
        comparabilityVsBaseline = 'comparable';
        comparabilityReasons = comp.reasons;
        comparableDays += 1;
      } else {
        comparabilityVsBaseline = 'not_comparable';
        comparabilityReasons = Array.from(new Set(combinedBlockers));
        notComparableDays += 1;
      }
    }

    const blemishState: MetricAvailabilityState = session.blemishAnalysis
      ? session.blemishAnalysis.state
      : 'not_analyzed';
    const colorimetryState: MetricAvailabilityState = session.colorimetryAnalysis
      ? session.colorimetryAnalysis.state
      : 'not_analyzed';

    const bRegions = session.blemishAnalysis?.regions ?? [];
    const cRegions = session.colorimetryAnalysis?.regions ?? [];

    const regions: LongitudinalRegionPoint[] = STANDARD_FACIAL_REGIONS.map(
      (region) => {
        const br =
          blemishState === 'measured'
            ? bRegions.find((r) => r.region === region)
            : undefined;
        const cr =
          colorimetryState === 'measured'
            ? cRegions.find((r) => r.region === region && r.state === 'measured')
            : undefined;
        return {
          region,
          activeBlemishes: br ? br.activeBlemishCount : null,
          areaMm2: br && isFiniteNum(br.affectedAreaMm2) ? br.affectedAreaMm2 : null,
          meanAStar: cr && isFiniteNum(cr.meanAStar) ? cr.meanAStar : null,
          elevatedRednessPct:
            cr && isFiniteNum(cr.elevatedRednessAreaFraction)
              ? cr.elevatedRednessAreaFraction * 100
              : null,
          darkSpotAreaPct:
            cr && isFiniteNum(cr.darkSpotContrastAreaFraction)
              ? cr.darkSpotContrastAreaFraction * 100
              : null,
        };
      }
    );

    const totalActiveBlemishes =
      blemishState === 'measured'
        ? regions.reduce((sum, r) => sum + (r.activeBlemishes ?? 0), 0)
        : null;
    const totalResidualMarks =
      blemishState === 'measured'
        ? bRegions
            .filter((r) => STANDARD_FACIAL_REGIONS.includes(r.region))
            .reduce((sum, r) => sum + r.residualMarkCount, 0)
        : null;
    const mm2Vals = regions
      .map((r) => r.areaMm2)
      .filter((v): v is number => v !== null);
    const totalAreaMm2 =
      blemishState === 'measured' && mm2Vals.length === STANDARD_FACIAL_REGIONS.length
        ? mm2Vals.reduce((sum, v) => sum + v, 0)
        : null;

    const aVals = regions
      .map((r) => r.meanAStar)
      .filter((v): v is number => v !== null);
    const redVals = regions
      .map((r) => r.elevatedRednessPct)
      .filter((v): v is number => v !== null);
    const spotVals = regions
      .map((r) => r.darkSpotAreaPct)
      .filter((v): v is number => v !== null);

    return {
      dayKey,
      sessionId: session.sessionId,
      capturedAtIso: session.capturedAtIso,
      variant: session.requestedVariant,
      effectiveCaptureMode: session.effectiveCaptureMode,
      comparabilityVsBaseline,
      comparabilityReasons,
      blemishState,
      colorimetryState,
      totalActiveBlemishes,
      totalResidualMarks,
      totalAreaMm2,
      meanFaceAStar: mean(aVals),
      meanRednessAreaPct: mean(redVals),
      meanDarkSpotAreaPct: mean(spotVals),
      regions,
    };
  });

  const notes: string[] = [
    'Concerns (active blemishes, redness appearance, dark-spot contrast) are reported separately; no composite skin-health score is computed.',
  ];
  if (points.length < 3) {
    notes.push(
      'Fewer than 3 distinct calendar days recorded — interpret day-to-day values cautiously until a multi-day trend accumulates.'
    );
  }

  return {
    deviceModel: options.deviceModel ?? baseline.deviceModel,
    view: options.view ?? baseline.view,
    baselineSessionId: baseline.sessionId,
    totalDays: points.length,
    comparableDays,
    notComparableDays,
    points,
    notes,
  };
}

export function buildM4ValidationReportMarkdown(
  evaluation: ValidationCohortEvaluation,
  trend: LongitudinalTrendSummary,
  context: { generatedAtIso?: string; targetHardwareModel?: string } = {}
): string {
  const generatedAt = context.generatedAtIso ?? new Date().toISOString();
  const targetHw = context.targetHardwareModel ?? 'iPhone 16 Pro';
  const testedDevices =
    evaluation.deviceModels.length > 0
      ? evaluation.deviceModels.join(', ')
      : 'None';
  const testedOnTarget = evaluation.deviceModels.some(
    (m) =>
      m.toLowerCase().includes('iphone17,1') ||
      m.toLowerCase().includes('iphone 16 pro')
  );

  const vA = evaluation.variants.rgb_unguided;
  const vB = evaluation.variants.rgb_guided;
  const vC = evaluation.variants.rgb_depth_guided;

  const lines: string[] = [
    '# Skin Trace — M4 Repeatability & Longitudinal Validation Report',
    '',
    `- **Generated:** ${generatedAt}`,
    `- **Protocol Version:** \`${evaluation.protocolVersion}\``,
    `- **Threshold Status:** \`${evaluation.thresholds.thresholdsStatus}\``,
    `- **Tested Device(s):** ${testedDevices} (iOS ${evaluation.systemVersions.join(', ') || '—'})`,
    `- **Capture View(s):** ${evaluation.views.join(', ') || '—'}`,
    `- **Blemish Version(s):** ${evaluation.versionConsistency.blemishVersions.join(', ') || 'not_analyzed'}`,
    `- **Colorimetry Version(s):** ${evaluation.versionConsistency.colorimetryVersions.join(', ') || 'not_analyzed'}`,
    `- **Target Hardware Verification (${targetHw}):** ${
      testedOnTarget
        ? 'Verified on target hardware'
        : `Pending — results below were collected on ${testedDevices}; physical ${targetHw} run remains unverified.`
    }`,
    '',
    '## 1. TrueDepth Value Verdict (§7.4)',
    '',
    `- **Verdict:** \`${evaluation.verdict}\``,
    `- **Rationale:** ${evaluation.verdictRationale}`,
    '',
    '## 2. Variant A vs B vs C Repeatability Summary (§7.2)',
    '',
    '| Metric | Variant A (RGB Unguided) | Variant B (RGB Guided) | Variant C (RGB + TrueDepth) |',
    '| --- | --- | --- | --- |',
    `| Captures (n) | ${vA.sampleCount} | ${vB.sampleCount} | ${vC.sampleCount} |`,
    `| Quality Acceptance Rate | ${fmtPct(vA.qualityAcceptanceRate)} | ${fmtPct(vB.qualityAcceptanceRate)} | ${fmtPct(vC.qualityAcceptanceRate)} |`,
    `| Framing Scale (Inter-Eye CV%) | ${fmtNum(vA.interEyeDistanceCvPct, '%')} | ${fmtNum(vB.interEyeDistanceCvPct, '%')} | ${fmtNum(vC.interEyeDistanceCvPct, '%')} |`,
    `| Head Yaw SD | ${fmtNum(vA.yawSdDeg, '°')} | ${fmtNum(vB.yawSdDeg, '°')} | ${fmtNum(vC.yawSdDeg, '°')} |`,
    `| TrueDepth Distance SD (cm) | ${fmtNum(vA.depthDistanceSdCm, ' cm')} | ${fmtNum(vB.depthDistanceSdCm, ' cm')} | ${fmtNum(vC.depthDistanceSdCm, ' cm')} |`,
    `| Metric Scale (mm/px CV%) | ${fmtNum(vA.mmPerPixelCvPct, '%')} | ${fmtNum(vB.mmPerPixelCvPct, '%')} | ${fmtNum(vC.mmPerPixelCvPct, '%')} |`,
    `| Geometric Comparability Rate | ${fmtPct(vA.geometricComparableRate)} | ${fmtPct(vB.geometricComparableRate)} | ${fmtPct(vC.geometricComparableRate)} |`,
    `| Color Comparability Rate | ${fmtPct(vA.colorComparableRate)} | ${fmtPct(vB.colorComparableRate)} | ${fmtPct(vC.colorComparableRate)} |`,
    `| Active Blemish Count SD | ${fmtNum(vA.activeBlemishCountSd)} | ${fmtNum(vB.activeBlemishCountSd)} | ${fmtNum(vC.activeBlemishCountSd)} |`,
    `| Raw Lesion Area CV% | ${fmtNum(vA.normalizedAreaCvPct, '%')} | ${fmtNum(vB.normalizedAreaCvPct, '%')} | ${fmtNum(vC.normalizedAreaCvPct, '%')} |`,
    `| Calibrated Lesion Area (mm²) CV% | ${fmtNum(vA.calibratedAreaMm2CvPct, '%')} | ${fmtNum(vB.calibratedAreaMm2CvPct, '%')} | ${fmtNum(vC.calibratedAreaMm2CvPct, '%')} |`,
    `| Redness False-Change Rate | ${fmtPct(vA.rednessFalseChangeRegionRate)} | ${fmtPct(vB.rednessFalseChangeRegionRate)} | ${fmtPct(vC.rednessFalseChangeRegionRate)} |`,
    `| Dark-Spot False-Change Rate | ${fmtPct(vA.darkSpotFalseChangeRegionRate)} | ${fmtPct(vB.darkSpotFalseChangeRegionRate)} | ${fmtPct(vC.darkSpotFalseChangeRegionRate)} |`,
    `| Median Capture / Blemish / Colorimetry (ms) | ${fmtNum(vA.medianCaptureDurationMs, '', 0)} / ${fmtNum(vA.medianBlemishComputeMs, '', 0)} / ${fmtNum(vA.medianColorimetryComputeMs, '', 0)} | ${fmtNum(vB.medianCaptureDurationMs, '', 0)} / ${fmtNum(vB.medianBlemishComputeMs, '', 0)} / ${fmtNum(vB.medianColorimetryComputeMs, '', 0)} | ${fmtNum(vC.medianCaptureDurationMs, '', 0)} / ${fmtNum(vC.medianBlemishComputeMs, '', 0)} / ${fmtNum(vC.medianColorimetryComputeMs, '', 0)} |`,
    '',
    '## 3. Provisional Release Threshold Gates (§7.3)',
    '',
    '| Variant | Gate | Actual | Threshold | Status |',
    '| --- | --- | --- | --- | --- |',
    ...evaluation.gates.map(
      (g) =>
        `| ${g.variant} | ${g.label} | ${g.actualDisplay} | ${g.thresholdText} | ${
          g.passed === true ? 'PASS' : g.passed === false ? 'FAIL' : 'PENDING'
        } |`
    ),
    '',
    '## 4. Longitudinal Multi-Day Trajectory',
    '',
    `- **Days Recorded:** ${trend.totalDays} (Comparable vs baseline: ${trend.comparableDays}, Refused / not_comparable: ${trend.notComparableDays})`,
    '',
  ];

  if (trend.points.length > 0) {
    lines.push(
      '| Day | Variant | Comparability | Active Blemishes | Area (mm²) | Mean a* | Redness Area % | Dark-Spot Area % |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |'
    );
    for (const pt of trend.points) {
      lines.push(
        `| ${pt.dayKey} | ${pt.variant} | ${pt.comparabilityVsBaseline} | ${
          pt.totalActiveBlemishes ?? pt.blemishState
        } | ${fmtNum(pt.totalAreaMm2, '', 1)} | ${fmtNum(pt.meanFaceAStar, '', 2)} | ${fmtNum(
          pt.meanRednessAreaPct,
          '%',
          1
        )} | ${fmtNum(pt.meanDarkSpotAreaPct, '%', 1)} |`
      );
    }
  } else {
    lines.push('_No multi-day sessions recorded yet._');
  }

  return lines.join('\n');
}
