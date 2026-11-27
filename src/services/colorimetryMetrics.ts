import type {
  FacialRegionId,
  NativeCaptureRecord,
  RegionColorimetryMetrics,
} from '@skin-trace/truedepth-camera';
import type { ComparisonRecord, MetricAvailabilityState } from '../types/domain';
import { STANDARD_FACIAL_REGIONS } from './blemishMetrics';

export const COLORIMETRY_ALGORITHM_VERSION = 'cielab-roi-srgb-v1';
export const COLORIMETRY_METRIC_VERSION = 'colorimetry-metrics-v1';

// Stricter color-consistency bounds than M1 geometric comparability.
const MAX_COLOR_EV_DELTA = 0.75;
const MAX_COLOR_WB_DELTA = 0.2;
const MAX_COLOR_DISTANCE_DELTA_CM = 4.0;

// Provisional within-ROI relative thresholds & valid-skin denominator.
const MIN_VALID_SKIN_RATIO = 0.35;
const REDNESS_ASTAR_MARGIN = 3.0;
const DARK_SPOT_LSTAR_MARGIN = 6.0;

// Provisional noise-floor cutoffs to avoid over-interpreting capture jitter.
const NOISE_ASTAR_DELTA = 0.8;
const NOISE_AREA_FRACTION_DELTA = 0.015;

export type AppearanceChangeDirection =
  | 'no_clear_change'
  | 'decreased_appearance'
  | 'increased_appearance'
  | 'unavailable';

export interface RegionColorimetryDelta {
  region: FacialRegionId;
  state: 'measured' | 'unavailable';
  deltaAStar: number | null;
  deltaErythemaIndex: number | null;
  deltaRednessAreaPctPts: number | null;
  deltaDarkSpotAreaPctPts: number | null;
  deltaDarkSpotContrastL: number | null;
  rednessStatus: AppearanceChangeDirection;
  darkSpotStatus: AppearanceChangeDirection;
}

export interface ColorimetryComparisonResult {
  state: MetricAvailabilityState;
  reasons: string[];
  regionDeltas: RegionColorimetryDelta[];
}

function srgbChannelToLinear(c255: number): number {
  const c = Math.min(1, Math.max(0, c255 / 255));
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labF(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

export function srgbToLab(
  r255: number,
  g255: number,
  b255: number
): { l: number; a: number; b: number; rLin: number; gLin: number } {
  const rLin = srgbChannelToLinear(r255);
  const gLin = srgbChannelToLinear(g255);
  const bLin = srgbChannelToLinear(b255);

  // sRGB -> CIE XYZ (D65 reference white: Xn=0.95047, Yn=1.00000, Zn=1.08883)
  const x = (0.4124564 * rLin + 0.3575761 * gLin + 0.1804375 * bLin) / 0.95047;
  const y = 0.2126729 * rLin + 0.7151522 * gLin + 0.072175 * bLin;
  const z = (0.0193339 * rLin + 0.119192 * gLin + 0.9503041 * bLin) / 1.08883;

  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
    rLin,
    gLin,
  };
}

function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * p))
  );
  return sorted[idx];
}

export function computeRegionColorimetryFromRgba(
  rgba: Uint8ClampedArray,
  region: FacialRegionId
): RegionColorimetryMetrics {
  const sampledPixelCount = Math.floor(rgba.length / 4);
  if (sampledPixelCount === 0) {
    return {
      region,
      state: 'unavailable',
      unavailableReason: 'No pixels sampled in ROI.',
      sampledPixelCount: 0,
      validSkinPixelRatio: 0,
      meanLStar: null,
      meanAStar: null,
      meanBStar: null,
      erythemaIndex: null,
      melaninIndexProxy: null,
      elevatedRednessAreaFraction: null,
      darkSpotContrastAreaFraction: null,
      darkSpotContrastDeltaL: null,
    };
  }

  const lValues: number[] = [];
  const aValues: number[] = [];
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  let sumEi = 0;
  let sumMi = 0;

  for (let i = 0; i < sampledPixelCount; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];

    // Exclude clipped specular highlights and deep shadow/hair occlusions.
    if ((r >= 248 && g >= 248 && b >= 248) || (r <= 15 && g <= 15 && b <= 15)) {
      continue;
    }

    const lab = srgbToLab(r, g, b);
    if (lab.l < 15 || lab.l > 92) continue;

    lValues.push(lab.l);
    aValues.push(lab.a);
    sumL += lab.l;
    sumA += lab.a;
    sumB += lab.b;

    const rClamped = Math.max(lab.rLin, 1e-4);
    const gClamped = Math.max(lab.gLin, 1e-4);
    sumEi += 100 * Math.log10(rClamped / gClamped);
    sumMi += 100 * Math.log10(1 / rClamped);
  }

  const validCount = lValues.length;
  const validSkinPixelRatio = validCount / sampledPixelCount;

  if (validCount === 0 || validSkinPixelRatio < MIN_VALID_SKIN_RATIO) {
    return {
      region,
      state: 'unavailable',
      unavailableReason: `Valid skin pixel ratio too low (${(validSkinPixelRatio * 100).toFixed(1)}%; minimum ${(MIN_VALID_SKIN_RATIO * 100).toFixed(0)}%).`,
      sampledPixelCount,
      validSkinPixelRatio,
      meanLStar: null,
      meanAStar: null,
      meanBStar: null,
      erythemaIndex: null,
      melaninIndexProxy: null,
      elevatedRednessAreaFraction: null,
      darkSpotContrastAreaFraction: null,
      darkSpotContrastDeltaL: null,
    };
  }

  const sortedA = [...aValues].sort((x, y) => x - y);
  const sortedL = [...lValues].sort((x, y) => x - y);
  const medianA = percentileSorted(sortedA, 0.5);
  const p75L = percentileSorted(sortedL, 0.75);

  let elevatedRedCount = 0;
  let darkSpotCount = 0;
  let darkSpotDeltaSum = 0;

  for (let i = 0; i < validCount; i++) {
    if (aValues[i] - medianA >= REDNESS_ASTAR_MARGIN) {
      elevatedRedCount += 1;
    }
    const deltaL = p75L - lValues[i];
    if (deltaL >= DARK_SPOT_LSTAR_MARGIN) {
      darkSpotCount += 1;
      darkSpotDeltaSum += deltaL;
    }
  }

  return {
    region,
    state: 'measured',
    sampledPixelCount,
    validSkinPixelRatio,
    meanLStar: sumL / validCount,
    meanAStar: sumA / validCount,
    meanBStar: sumB / validCount,
    erythemaIndex: sumEi / validCount,
    melaninIndexProxy: sumMi / validCount,
    elevatedRednessAreaFraction: elevatedRedCount / validCount,
    darkSpotContrastAreaFraction: darkSpotCount / validCount,
    darkSpotContrastDeltaL:
      darkSpotCount > 0 ? darkSpotDeltaSum / darkSpotCount : 0,
  };
}

function classifyDirection(
  primaryDelta: number | null,
  primaryNoise: number,
  secondaryDelta: number | null,
  secondaryNoise: number
): AppearanceChangeDirection {
  if (primaryDelta === null && secondaryDelta === null) return 'unavailable';
  const p = primaryDelta ?? 0;
  const s = secondaryDelta ?? 0;
  const pSig = primaryDelta !== null && Math.abs(p) >= primaryNoise;
  const sSig = secondaryDelta !== null && Math.abs(s) >= secondaryNoise;
  if (!pSig && !sSig) return 'no_clear_change';
  if (pSig && sSig && Math.sign(p) !== Math.sign(s)) {
    return 'no_clear_change';
  }
  const signal = pSig ? p : s;
  return signal < 0 ? 'decreased_appearance' : 'increased_appearance';
}

function classifyDarkSpotDirection(
  baseAreaFrac: number | null,
  currAreaFrac: number | null,
  deltaSpotContrastL: number | null
): AppearanceChangeDirection {
  if (!isFiniteNum(baseAreaFrac) || !isFiniteNum(currAreaFrac)) {
    return 'unavailable';
  }
  const deltaSpotFrac = currAreaFrac - baseAreaFrac;
  // Continuous area-fraction change drives direction above noise floor (prevents survivorship bias).
  if (Math.abs(deltaSpotFrac) >= NOISE_AREA_FRACTION_DELTA) {
    return deltaSpotFrac < 0 ? 'decreased_appearance' : 'increased_appearance';
  }
  // Only inspect contrast DeltaL when both captures have above-noise spot coverage
  // (avoids the 0 -> 1 pixel step jump from 0.0 to >= 6.0 L*).
  const bothHaveSpots =
    baseAreaFrac >= NOISE_AREA_FRACTION_DELTA &&
    currAreaFrac >= NOISE_AREA_FRACTION_DELTA;
  if (
    bothHaveSpots &&
    isFiniteNum(deltaSpotContrastL) &&
    Math.abs(deltaSpotContrastL) >= 1.2
  ) {
    return deltaSpotContrastL < 0
      ? 'decreased_appearance'
      : 'increased_appearance';
  }
  return 'no_clear_change';
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function compareColorimetryAnalyses(
  baseline: NativeCaptureRecord,
  current: NativeCaptureRecord,
  comparability: ComparisonRecord
): ColorimetryComparisonResult {
  const baseCol = baseline.colorimetryAnalysis;
  const currCol = current.colorimetryAnalysis;

  if (!baseCol || !currCol) {
    return {
      state: 'not_analyzed',
      reasons: [
        'Run Redness & Spots (CIELAB) analysis on both Baseline and Current sessions to compare appearance proxies.',
      ],
      regionDeltas: [],
    };
  }

  if (baseCol.state === 'unavailable' || currCol.state === 'unavailable') {
    const reasons: string[] = [];
    if (baseCol.state === 'unavailable') {
      reasons.push(
        `Baseline colorimetry unavailable: ${baseCol.unavailableReason ?? 'insufficient valid skin or missing ROI data.'}`
      );
    }
    if (currCol.state === 'unavailable') {
      reasons.push(
        `Current colorimetry unavailable: ${currCol.unavailableReason ?? 'insufficient valid skin or missing ROI data.'}`
      );
    }
    return {
      state: 'unavailable',
      reasons,
      regionDeltas: [],
    };
  }

  const blockers: string[] = [];
  if (comparability.comparabilityState !== 'comparable') {
    blockers.push(
      `Capture comparability gate is "${comparability.comparabilityState}" — colorimetry comparison withheld.`
    );
  }
  if (baseCol.algorithmVersion !== currCol.algorithmVersion) {
    blockers.push(
      `Colorimetry algorithm mismatch (${baseCol.algorithmVersion} vs ${currCol.algorithmVersion}).`
    );
  }
  if (baseCol.metricDefinitionVersion !== currCol.metricDefinitionVersion) {
    blockers.push(
      `Metric definition mismatch (${baseCol.metricDefinitionVersion} vs ${currCol.metricDefinitionVersion}).`
    );
  }
  if (baseCol.colorSpace !== currCol.colorSpace) {
    blockers.push(
      `Color space mismatch (${baseCol.colorSpace} vs ${currCol.colorSpace}).`
    );
  }

  // Require exposure EV & white-balance metadata to verify color consistency.
  const dEv = comparability.deltas.exposureEvDelta;
  if (!isFiniteNum(dEv)) {
    blockers.push(
      'Exposure metadata missing on one or both sessions — lighting consistency cannot be verified for colorimetry.'
    );
  } else if (Math.abs(dEv) > MAX_COLOR_EV_DELTA) {
    blockers.push(
      `Exposure shifted by ${Math.abs(dEv).toFixed(2)} EV stops (color comparison limit ≤ ${MAX_COLOR_EV_DELTA} EV).`
    );
  }

  const dWbR = comparability.deltas.wbRedDelta;
  const dWbB = comparability.deltas.wbBlueDelta;
  if (!isFiniteNum(dWbR) || !isFiniteNum(dWbB)) {
    blockers.push(
      'White-balance gain metadata missing on one or both sessions — color temperature consistency cannot be verified.'
    );
  } else if (
    Math.abs(dWbR) > MAX_COLOR_WB_DELTA ||
    Math.abs(dWbB) > MAX_COLOR_WB_DELTA
  ) {
    blockers.push(
      `White balance shifted beyond color limit ≤ ${MAX_COLOR_WB_DELTA} (ΔR ${dWbR.toFixed(2)}, ΔB ${dWbB.toFixed(2)}).`
    );
  }

  const dDist = comparability.deltas.distanceDeltaCm;
  const dScale = comparability.deltas.scaleDeltaPct;
  let geometryNote = 'distance';
  if (isFiniteNum(dDist)) {
    if (Math.abs(dDist) > MAX_COLOR_DISTANCE_DELTA_CM) {
      blockers.push(
        `Camera distance shifted by ${Math.abs(dDist).toFixed(1)} cm (color limit ≤ ${MAX_COLOR_DISTANCE_DELTA_CM} cm).`
      );
    }
  } else if (isFiniteNum(dScale)) {
    geometryNote = 'scale';
    if (Math.abs(dScale) > 12) {
      blockers.push(
        `Image scale shifted by ${Math.abs(dScale).toFixed(1)}% (color limit ≤ 12% when depth distance unavailable).`
      );
    }
  } else {
    blockers.push(
      'Camera distance and scale deltas unavailable — stand-off geometry cannot be verified for colorimetry.'
    );
  }

  if (blockers.length > 0) {
    return {
      state: 'not_comparable',
      reasons: blockers,
      regionDeltas: [],
    };
  }

  const regionDeltas: RegionColorimetryDelta[] = STANDARD_FACIAL_REGIONS.map(
    (region) => {
      const b = baseCol.regions.find((r) => r.region === region);
      const c = currCol.regions.find((r) => r.region === region);
      if (!b || !c || b.state !== 'measured' || c.state !== 'measured') {
        return {
          region,
          state: 'unavailable',
          deltaAStar: null,
          deltaErythemaIndex: null,
          deltaRednessAreaPctPts: null,
          deltaDarkSpotAreaPctPts: null,
          deltaDarkSpotContrastL: null,
          rednessStatus: 'unavailable',
          darkSpotStatus: 'unavailable',
        };
      }

      const deltaAStar =
        isFiniteNum(b.meanAStar) && isFiniteNum(c.meanAStar)
          ? c.meanAStar - b.meanAStar
          : null;
      const deltaErythemaIndex =
        isFiniteNum(b.erythemaIndex) && isFiniteNum(c.erythemaIndex)
          ? c.erythemaIndex - b.erythemaIndex
          : null;
      const deltaRedFrac =
        isFiniteNum(b.elevatedRednessAreaFraction) &&
        isFiniteNum(c.elevatedRednessAreaFraction)
          ? c.elevatedRednessAreaFraction - b.elevatedRednessAreaFraction
          : null;
      const deltaSpotFrac =
        isFiniteNum(b.darkSpotContrastAreaFraction) &&
        isFiniteNum(c.darkSpotContrastAreaFraction)
          ? c.darkSpotContrastAreaFraction - b.darkSpotContrastAreaFraction
          : null;
      const deltaSpotContrastL =
        isFiniteNum(b.darkSpotContrastDeltaL) &&
        isFiniteNum(c.darkSpotContrastDeltaL)
          ? c.darkSpotContrastDeltaL - b.darkSpotContrastDeltaL
          : null;

      return {
        region,
        state: 'measured',
        deltaAStar,
        deltaErythemaIndex,
        deltaRednessAreaPctPts:
          deltaRedFrac !== null ? deltaRedFrac * 100 : null,
        deltaDarkSpotAreaPctPts:
          deltaSpotFrac !== null ? deltaSpotFrac * 100 : null,
        deltaDarkSpotContrastL: deltaSpotContrastL,
        rednessStatus: classifyDirection(
          deltaAStar,
          NOISE_ASTAR_DELTA,
          deltaRedFrac,
          NOISE_AREA_FRACTION_DELTA
        ),
        darkSpotStatus: classifyDarkSpotDirection(
          b.darkSpotContrastAreaFraction,
          c.darkSpotContrastAreaFraction,
          deltaSpotContrastL
        ),
      };
    }
  );

  const hasAnyMeasuredRegion = regionDeltas.some((r) => r.state === 'measured');
  if (!hasAnyMeasuredRegion) {
    return {
      state: 'unavailable',
      reasons: [
        'No shared facial ROI had sufficient valid skin pixels in both sessions.',
      ],
      regionDeltas,
    };
  }

  return {
    state: 'measured',
    reasons: [
      `Compared compatible sRGB CIELAB appearance proxies (${currCol.algorithmVersion}) within strict lighting, WB, and ${geometryNote} bounds.`,
    ],
    regionDeltas,
  };
}
