import type { NativeCaptureRecord } from '@skin-trace/truedepth-camera';

export type AlignmentMode = 'eye_landmarks' | 'face_box' | 'unaligned';

export interface PairAlignmentTransform {
  mode: AlignmentMode;
  summary: string;
  /** CSS transform applied to the Current image to align onto the Baseline image. */
  currentCssTransform: string;
  /** Transform origin in percentage CSS coordinates (matches anchor point). */
  transformOrigin: string;
  scaleFactor: number;
  rotationDeltaDeg: number;
  translateXPct: number;
  translateYPct: number;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Computes a geometric 2D similarity transform (translate + rotate + scale) that maps
 * the Current session's facial landmarks onto the Baseline session's facial frame.
 * Falls back honestly to 'face_box' (e.g. cheek views where one eye is occluded) or 'unaligned'.
 */
export function computePairAlignmentTransform(
  baseline: NativeCaptureRecord,
  current: NativeCaptureRecord
): PairAlignmentTransform {
  const baseAlign = baseline.facialAlignment;
  const currAlign = current.facialAlignment;

  if (!baseAlign?.detected || !currAlign?.detected) {
    return {
      mode: 'unaligned',
      summary:
        'Landmark anchors unavailable on one or both sessions — displaying unaligned originals.',
      currentCssTransform: 'none',
      transformOrigin: '50% 50%',
      scaleFactor: 1,
      rotationDeltaDeg: 0,
      translateXPct: 0,
      translateYPct: 0,
    };
  }

  // Primary: eye-center midpoint + inter-eye scale + eye-line roll angle.
  if (
    baseAlign.eyeCenterMidpoint &&
    currAlign.eyeCenterMidpoint &&
    isFiniteNum(baseAlign.interEyeDistance) &&
    isFiniteNum(currAlign.interEyeDistance) &&
    currAlign.interEyeDistance > 0.02
  ) {
    const rawScale = baseAlign.interEyeDistance / currAlign.interEyeDistance;
    const scaleFactor = clamp(rawScale, 0.72, 1.38);

    const baseAngle = isFiniteNum(baseAlign.eyeLineAngleDegrees)
      ? baseAlign.eyeLineAngleDegrees
      : 0;
    const currAngle = isFiniteNum(currAlign.eyeLineAngleDegrees)
      ? currAlign.eyeLineAngleDegrees
      : 0;
    const rotationDeltaDeg = clamp(baseAngle - currAngle, -20, 20);

    const translateXPct = clamp(
      (baseAlign.eyeCenterMidpoint.x - currAlign.eyeCenterMidpoint.x) * 100,
      -30,
      30
    );
    const translateYPct = clamp(
      (baseAlign.eyeCenterMidpoint.y - currAlign.eyeCenterMidpoint.y) * 100,
      -30,
      30
    );

    const originX = (currAlign.eyeCenterMidpoint.x * 100).toFixed(2);
    const originY = (currAlign.eyeCenterMidpoint.y * 100).toFixed(2);
    const transformOrigin = `${originX}% ${originY}%`;

    const currentCssTransform = `translate(${translateXPct.toFixed(2)}%, ${translateYPct.toFixed(2)}%) rotate(${rotationDeltaDeg.toFixed(2)}deg) scale(${scaleFactor.toFixed(3)})`;

    return {
      mode: 'eye_landmarks',
      summary: `Eye-landmark aligned (scale ${scaleFactor.toFixed(2)}×, rot ${rotationDeltaDeg >= 0 ? '+' : ''}${rotationDeltaDeg.toFixed(1)}°).`,
      currentCssTransform,
      transformOrigin,
      scaleFactor,
      rotationDeltaDeg,
      translateXPct,
      translateYPct,
    };
  }

  // Secondary: face bounding box alignment (useful on side-cheek views).
  if (
    baseAlign.faceBoundingBox &&
    currAlign.faceBoundingBox &&
    currAlign.faceBoundingBox.width > 0.05
  ) {
    const baseBox = baseAlign.faceBoundingBox;
    const currBox = currAlign.faceBoundingBox;

    const baseCx = baseBox.x + baseBox.width / 2;
    const baseCy = baseBox.y + baseBox.height / 2;
    const currCx = currBox.x + currBox.width / 2;
    const currCy = currBox.y + currBox.height / 2;

    const scaleFactor = clamp(baseBox.width / currBox.width, 0.75, 1.35);
    const translateXPct = clamp((baseCx - currCx) * 100, -30, 30);
    const translateYPct = clamp((baseCy - currCy) * 100, -30, 30);

    const transformOrigin = `${(currCx * 100).toFixed(2)}% ${(currCy * 100).toFixed(2)}%`;
    const currentCssTransform = `translate(${translateXPct.toFixed(2)}%, ${translateYPct.toFixed(2)}%) scale(${scaleFactor.toFixed(3)})`;

    return {
      mode: 'face_box',
      summary: `Face-box aligned (scale ${scaleFactor.toFixed(2)}×; eye anchors partial on this view).`,
      currentCssTransform,
      transformOrigin,
      scaleFactor,
      rotationDeltaDeg: 0,
      translateXPct,
      translateYPct,
    };
  }

  return {
    mode: 'unaligned',
    summary: 'Insufficient landmark geometry for auto-alignment.',
    currentCssTransform: 'none',
    transformOrigin: '50% 50%',
    scaleFactor: 1,
    rotationDeltaDeg: 0,
    translateXPct: 0,
    translateYPct: 0,
  };
}
