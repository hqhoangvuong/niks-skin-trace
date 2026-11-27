import type { NativeCaptureRecord } from '@skin-trace/truedepth-camera';
import type { ComparisonRecord } from '../types/domain';
import { computePairAlignmentTransform } from './alignment';

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Evaluates longitudinal comparability between a baseline and current capture session.
 * Provisional thresholds are explicitly documented and never fabricate skin-health scores.
 */
export function evaluateComparability(
  baseline: NativeCaptureRecord,
  current: NativeCaptureRecord
): ComparisonRecord {
  const alignment = computePairAlignmentTransform(baseline, current);
  const blockers: string[] = [];
  const cautions: string[] = [];

  if (baseline.sessionId === current.sessionId) {
    return {
      baselineSessionId: baseline.sessionId,
      currentSessionId: current.sessionId,
      view: baseline.view,
      comparabilityState: 'unavailable',
      alignmentMode: alignment.mode,
      reasons: ['Select two different sessions to compare.'],
      cautions: [],
      deltas: {},
      analysisStatus: 'not_analyzed',
    };
  }

  // 1. View match (hard gate)
  if (baseline.view !== current.view) {
    blockers.push(
      `View mismatch: baseline is "${baseline.view}" vs current "${current.view}".`
    );
  }

  // 2. Capture mode & device consistency
  if (baseline.effectiveCaptureMode !== current.effectiveCaptureMode) {
    blockers.push(
      `Capture mode mismatch (${baseline.effectiveCaptureMode} vs ${current.effectiveCaptureMode}).`
    );
  }
  if (baseline.deviceModel !== current.deviceModel) {
    blockers.push(
      `Different devices (${baseline.deviceModel} vs ${current.deviceModel}) — cross-device color/optics are unvalidated.`
    );
  }
  if (baseline.isSimulatedOrWebFallback || current.isSimulatedOrWebFallback) {
    cautions.push('One or both captures came from browser/simulator fallback.');
  }

  // 3. Stand-off distance & metric scale delta
  let distanceDeltaCm: number | undefined;
  let scaleDeltaPct: number | undefined;
  const baseDist = baseline.depth?.centerWindowMedianMeters;
  const currDist = current.depth?.centerWindowMedianMeters;
  if (isFiniteNum(baseDist) && isFiniteNum(currDist)) {
    distanceDeltaCm = (currDist - baseDist) * 100;
    const absDist = Math.abs(distanceDeltaCm);
    if (absDist > 6.0) {
      blockers.push(
        `Large camera distance shift (${absDist.toFixed(1)} cm; limit ≤ 6.0 cm).`
      );
    } else if (absDist > 3.0) {
      cautions.push(
        `Moderate camera distance shift (${absDist.toFixed(1)} cm).`
      );
    }
  }

  const baseScale = baseline.depth?.estimatedMmPerPixelAtRgb;
  const currScale = current.depth?.estimatedMmPerPixelAtRgb;
  if (isFiniteNum(baseScale) && isFiniteNum(currScale) && baseScale > 0) {
    scaleDeltaPct = ((currScale - baseScale) / baseScale) * 100;
  } else if (
    alignment.mode !== 'unaligned' &&
    isFiniteNum(alignment.scaleFactor) &&
    alignment.scaleFactor > 0
  ) {
    // Fallback for RGB-only captures (Variant A/B): derive relative 2D facial scale delta
    // from landmark alignment so colorimetry can enforce its <=12% scale consistency gate fairly.
    scaleDeltaPct = (alignment.scaleFactor - 1) * 100;
  }

  // 4. Head pose delta (prefer still-photo alignment pose, fallback to shutter guidance)
  let yawDeltaDeg: number | undefined;
  let rollDeltaDeg: number | undefined;
  const baseYaw =
    baseline.facialAlignment?.poseDegrees?.yawDegrees ??
    baseline.liveGuidanceAtShutter?.yawDegrees;
  const currYaw =
    current.facialAlignment?.poseDegrees?.yawDegrees ??
    current.liveGuidanceAtShutter?.yawDegrees;
  if (isFiniteNum(baseYaw) && isFiniteNum(currYaw)) {
    yawDeltaDeg = currYaw - baseYaw;
    if (Math.abs(yawDeltaDeg) > 15) {
      blockers.push(
        `Head yaw differs by ${Math.abs(yawDeltaDeg).toFixed(0)}° (limit ≤ 15°).`
      );
    }
  }

  const baseRoll =
    baseline.facialAlignment?.poseDegrees?.rollDegrees ??
    baseline.liveGuidanceAtShutter?.rollDegrees;
  const currRoll =
    current.facialAlignment?.poseDegrees?.rollDegrees ??
    current.liveGuidanceAtShutter?.rollDegrees;
  if (isFiniteNum(baseRoll) && isFiniteNum(currRoll)) {
    rollDeltaDeg = currRoll - baseRoll;
    if (Math.abs(rollDeltaDeg) > 12) {
      cautions.push(
        `Head tilt (roll) differs by ${Math.abs(rollDeltaDeg).toFixed(0)}°.`
      );
    }
  }

  // 5. Exposure EV & White-Balance drift
  let exposureEvDelta: number | undefined;
  let wbRedDelta: number | undefined;
  let wbBlueDelta: number | undefined;
  const baseCam = baseline.cameraMetadata;
  const currCam = current.cameraMetadata;
  if (
    baseCam &&
    currCam &&
    isFiniteNum(baseCam.iso) &&
    isFiniteNum(currCam.iso) &&
    isFiniteNum(baseCam.exposureDurationMs) &&
    isFiniteNum(currCam.exposureDurationMs) &&
    baseCam.iso * baseCam.exposureDurationMs > 0 &&
    currCam.iso * currCam.exposureDurationMs > 0
  ) {
    // Positive EV delta means current needed more gain/shutter (dimmer ambient light).
    exposureEvDelta = Math.log2(
      (currCam.iso * currCam.exposureDurationMs) /
        (baseCam.iso * baseCam.exposureDurationMs)
    );
    const absEv = Math.abs(exposureEvDelta);
    if (absEv > 1.5) {
      blockers.push(
        `Lighting/exposure shifted by ${absEv.toFixed(2)} EV stops (limit ≤ 1.5 EV).`
      );
    } else if (absEv > 0.75) {
      cautions.push(
        `Moderate lighting shift (${absEv.toFixed(2)} EV stops) — inspect redness/spots cautiously.`
      );
    }
  }

  if (
    baseCam &&
    currCam &&
    isFiniteNum(baseCam.whiteBalanceRedGain) &&
    isFiniteNum(currCam.whiteBalanceRedGain) &&
    isFiniteNum(baseCam.whiteBalanceBlueGain) &&
    isFiniteNum(currCam.whiteBalanceBlueGain)
  ) {
    wbRedDelta = currCam.whiteBalanceRedGain - baseCam.whiteBalanceRedGain;
    wbBlueDelta = currCam.whiteBalanceBlueGain - baseCam.whiteBalanceBlueGain;
    if (Math.abs(wbRedDelta) > 0.35 || Math.abs(wbBlueDelta) > 0.35) {
      blockers.push(
        `White-balance color temperature shifted significantly (ΔR ${wbRedDelta.toFixed(2)}, ΔB ${wbBlueDelta.toFixed(2)}).`
      );
    }
  }

  // 6. Shutter quality acceptance check
  if (baseline.liveGuidanceAtShutter?.readyToCapture === false) {
    cautions.push('Baseline capture did not pass all live quality checks.');
  }
  if (current.liveGuidanceAtShutter?.readyToCapture === false) {
    cautions.push('Current capture did not pass all live quality checks.');
  }

  const comparabilityState =
    blockers.length > 0 ? 'not_comparable' : 'comparable';

  return {
    baselineSessionId: baseline.sessionId,
    currentSessionId: current.sessionId,
    view: baseline.view,
    comparabilityState,
    alignmentMode: alignment.mode,
    reasons:
      blockers.length > 0
        ? blockers
        : [
            'Capture view, mode, distance, pose, and lighting are within provisional M1 comparability bounds.',
          ],
    cautions,
    deltas: {
      distanceDeltaCm,
      scaleDeltaPct,
      yawDeltaDeg,
      rollDeltaDeg,
      exposureEvDelta,
      wbRedDelta,
      wbBlueDelta,
    },
    analysisStatus: 'not_analyzed',
  };
}
