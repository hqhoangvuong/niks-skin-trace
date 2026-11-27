import type { PluginListenerHandle } from '@capacitor/core';

export type CameraPermissionState =
  | 'prompt'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unsupported';

export type CaptureView = 'front' | 'left_cheek' | 'right_cheek';

export type ExperimentVariant =
  | 'rgb_unguided'
  | 'rgb_guided'
  | 'rgb_depth_guided';

export type EffectiveCaptureMode =
  | 'rgb_plus_truedepth'
  | 'rgb_only_native'
  | 'rgb_only_web_fallback';

export type GuidanceDistanceState =
  | 'unavailable'
  | 'too_close'
  | 'in_range'
  | 'too_far';

export interface Dimensions {
  width: number;
  height: number;
}

export interface DepthFormatInfo {
  width: number;
  height: number;
  pixelFormat: string;
  maxFrameRate: number;
}

export interface VideoFormatInfo {
  width: number;
  height: number;
  pixelFormat: string;
  supportedMaxPhotoDimensions: Dimensions[];
  supportedDepthFormats: DepthFormatInfo[];
}

export interface DeviceCapabilityReport {
  probedAtIso: string;
  platform: 'ios' | 'web';
  isSimulator: boolean;
  deviceModel: string;
  systemVersion: string;
  cameraPermission: CameraPermissionState;
  trueDepthSupported: boolean;
  activeDeviceType: string;
  photoOutputDepthDeliverySupported: boolean | null;
  totalFrontFormatCount: number;
  depthCapableFormats: VideoFormatInfo[];
  notes: string[];
}

export interface CalibrationSummary {
  present: boolean;
  intrinsicMatrix?: number[];
  intrinsicMatrixReferenceDimensions?: Dimensions;
  pixelSizeMm?: number;
  lensDistortionCenter?: { x: number; y: number };
  hasLensDistortionLookupTable?: boolean;
  hasInverseLensDistortionLookupTable?: boolean;
}

export interface DepthStats {
  available: boolean;
  unavailableReason?: string;
  originalPixelFormat?: string;
  width?: number;
  height?: number;
  accuracy?: 'absolute' | 'relative' | 'unknown';
  quality?: 'high' | 'low' | 'unknown';
  isFiltered?: boolean;
  validPixelRatio?: number;
  centerWindowMinMeters?: number;
  centerWindowMedianMeters?: number;
  centerWindowMaxMeters?: number;
  estimatedMmPerPixelAtRgb?: number;
  calibration?: CalibrationSummary;
}

export interface CameraExposureMetadata {
  iso: number;
  exposureDurationMs: number;
  exposureTargetBias: number;
  whiteBalanceRedGain: number;
  whiteBalanceGreenGain: number;
  whiteBalanceBlueGain: number;
  lensPosition?: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FacialRegionMap {
  forehead?: NormalizedRect;
  anatomicalLeftCheek?: NormalizedRect;
  anatomicalRightCheek?: NormalizedRect;
  chin?: NormalizedRect;
}

export interface FacialAlignmentMetadata {
  detected: boolean;
  faceCount: number;
  coordinateOrigin?: 'top_left_normalized';
  faceBoundingBox?: NormalizedRect;
  anatomicalLeftEye?: NormalizedPoint;
  anatomicalRightEye?: NormalizedPoint;
  eyeCenterMidpoint?: NormalizedPoint;
  interEyeDistance?: number;
  eyeLineAngleDegrees?: number;
  noseTip?: NormalizedPoint;
  mouthCenter?: NormalizedPoint;
  poseDegrees?: {
    yawDegrees?: number;
    rollDegrees?: number;
    pitchDegrees?: number;
  };
  regions?: FacialRegionMap;
  error?: string;
}

/**
 * Pilot-default live guidance snapshot emitted by AVCaptureDataOutputSynchronizer
 * + Vision face landmarks. Thresholds are provisional until calibrated on hardware.
 */
export interface LiveGuidanceSnapshot {
  timestampIso: string;
  view: CaptureView;
  variant: ExperimentVariant;
  thresholdsProvisional: boolean;
  faceCount: number;
  faceCentered: boolean | null;
  faceCoverageRatio: number | null;
  yawDegrees: number | null;
  rollDegrees: number | null;
  pitchDegrees: number | null;
  meanLuma?: number | null;
  clippedHighlightRatio?: number | null;
  clippedShadowRatio?: number | null;
  sharpnessScore?: number | null;
  isSharp?: boolean | null;
  neutralExpression?: boolean | null;
  mouthOpenRatio?: number | null;
  mouthWidthRatio?: number | null;
  depthAvailable: boolean;
  faceDistanceMeters: number | null;
  depthValidRatio: number | null;
  distanceState: GuidanceDistanceState;
  sessionInterrupted: boolean;
  readyToCapture: boolean;
  guidanceMessages: string[];
}

export interface CapturePairedPhotoOptions {
  view: CaptureView;
  variant: ExperimentVariant;
  requestDepth: boolean;
}

export interface OpenGuidedCaptureOptions {
  view: CaptureView;
  variant: ExperimentVariant;
  requestDepth: boolean;
  /** Provisional target distance range in meters (defaults: 0.20m–0.30m). */
  targetMinDistanceMeters?: number;
  targetMaxDistanceMeters?: number;
  /** Optional local file URI of a previous photo for the same view to show as a translucent alignment overlay. */
  ghostImageUri?: string;
  /** Opacity for the ghost alignment overlay (0.05–0.6, default 0.28). */
  ghostOpacity?: number;
}

export interface OpenGuidedCaptureResult {
  cancelled: boolean;
  record?: NativeCaptureRecord;
}

export interface NativeCaptureRecord {
  sessionId: string;
  capturedAtIso: string;
  timezone: string;
  platform: 'ios' | 'web';
  isSimulatedOrWebFallback: boolean;
  deviceModel: string;
  systemVersion: string;
  cameraDeviceType: string;
  view: CaptureView;
  requestedVariant: ExperimentVariant;
  effectiveCaptureMode: EffectiveCaptureMode;
  storedImageMirrored: boolean;
  rgbDimensions: Dimensions;
  rgbFileUri?: string;
  depthFileUri?: string;
  selectedVideoFormat?: {
    width: number;
    height: number;
    pixelFormat: string;
  };
  selectedDepthFormat?: {
    width: number;
    height: number;
    pixelFormat: string;
  };
  cameraMetadata?: CameraExposureMetadata;
  facialAlignment?: FacialAlignmentMetadata;
  depth: DepthStats;
  liveGuidanceAtShutter?: LiveGuidanceSnapshot;
  captureDurationMs: number;
  warnings: string[];
}

export interface TrueDepthCameraPlugin {
  checkPermissions(): Promise<{ camera: CameraPermissionState }>;
  requestPermissions(): Promise<{ camera: CameraPermissionState }>;
  probeCapabilities(): Promise<DeviceCapabilityReport>;
  capturePairedPhoto(
    options: CapturePairedPhotoOptions
  ): Promise<NativeCaptureRecord>;
  openGuidedCapture(
    options: OpenGuidedCaptureOptions
  ): Promise<OpenGuidedCaptureResult>;
  listLocalSessions(): Promise<{ sessions: NativeCaptureRecord[] }>;
  deleteLocalSession(options: {
    sessionId: string;
  }): Promise<{ deleted: boolean }>;
  addListener(
    eventName: 'guidanceUpdate',
    listenerFunc: (snapshot: LiveGuidanceSnapshot) => void
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
