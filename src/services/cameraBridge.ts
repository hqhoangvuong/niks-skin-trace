import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import {
  TrueDepthCamera,
  type BlemishAnalysisRecord,
  type CameraPermissionState,
  type CapturePairedPhotoOptions,
  type DeviceCapabilityReport,
  type LiveGuidanceSnapshot,
  type NativeCaptureRecord,
  type OpenGuidedCaptureOptions,
  type OpenGuidedCaptureResult,
  type RunCoreMLBlemishAnalysisOptions,
} from '@skin-trace/truedepth-camera';

export function resolvePreviewSrc(uri?: string): string | undefined {
  if (!uri) return undefined;
  if (
    uri.startsWith('data:') ||
    uri.startsWith('http://') ||
    uri.startsWith('https://')
  ) {
    return uri;
  }
  return Capacitor.convertFileSrc(uri);
}

export const cameraBridge = {
  isNativePlatform(): boolean {
    return Capacitor.isNativePlatform();
  },

  getPlatform(): string {
    return Capacitor.getPlatform();
  },

  async checkPermissions(): Promise<CameraPermissionState> {
    const res = await TrueDepthCamera.checkPermissions();
    return res.camera;
  },

  async requestPermissions(): Promise<CameraPermissionState> {
    const res = await TrueDepthCamera.requestPermissions();
    return res.camera;
  },

  async probeCapabilities(): Promise<DeviceCapabilityReport> {
    return TrueDepthCamera.probeCapabilities();
  },

  async capturePairedPhoto(
    options: CapturePairedPhotoOptions
  ): Promise<NativeCaptureRecord> {
    return TrueDepthCamera.capturePairedPhoto(options);
  },

  async openGuidedCapture(
    options: OpenGuidedCaptureOptions
  ): Promise<OpenGuidedCaptureResult> {
    return TrueDepthCamera.openGuidedCapture(options);
  },

  async onGuidanceUpdate(
    listener: (snapshot: LiveGuidanceSnapshot) => void
  ): Promise<PluginListenerHandle> {
    return TrueDepthCamera.addListener('guidanceUpdate', listener);
  },

  async listLocalSessions(): Promise<NativeCaptureRecord[]> {
    const res = await TrueDepthCamera.listLocalSessions();
    return res.sessions;
  },

  async deleteLocalSession(sessionId: string): Promise<boolean> {
    const res = await TrueDepthCamera.deleteLocalSession({ sessionId });
    return res.deleted;
  },

  async saveSessionAnalysis(
    sessionId: string,
    analysis: BlemishAnalysisRecord
  ): Promise<boolean> {
    const res = await TrueDepthCamera.saveSessionAnalysis({
      sessionId,
      analysis,
    });
    return res.saved;
  },

  async runCoreMLBlemishAnalysis(
    options: RunCoreMLBlemishAnalysisOptions
  ): Promise<BlemishAnalysisRecord> {
    return TrueDepthCamera.runCoreMLBlemishAnalysis(options);
  },
};
