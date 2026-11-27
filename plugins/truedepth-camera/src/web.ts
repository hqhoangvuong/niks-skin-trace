import { WebPlugin } from '@capacitor/core';
import type {
  CameraPermissionState,
  CapturePairedPhotoOptions,
  DeviceCapabilityReport,
  LiveGuidanceSnapshot,
  NativeCaptureRecord,
  OpenGuidedCaptureOptions,
  OpenGuidedCaptureResult,
  TrueDepthCameraPlugin,
} from './definitions';

const WEB_STORAGE_KEY = 'skin_trace_m0_web_sessions_v1';

/**
 * Honest web fallback for UI development and RGB-only browser baselines.
 * Never fabricates TrueDepth hardware support or depth measurements.
 */
export class TrueDepthCameraWeb
  extends WebPlugin
  implements TrueDepthCameraPlugin
{
  async checkPermissions(): Promise<{ camera: CameraPermissionState }> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      return { camera: 'unsupported' };
    }
    if ('permissions' in navigator && navigator.permissions?.query) {
      try {
        const result = await navigator.permissions.query({
          name: 'camera' as PermissionName,
        });
        if (result.state === 'granted') return { camera: 'granted' };
        if (result.state === 'denied') return { camera: 'denied' };
        return { camera: 'prompt' };
      } catch {
        return { camera: 'prompt' };
      }
    }
    return { camera: 'prompt' };
  }

  async requestPermissions(): Promise<{ camera: CameraPermissionState }> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return { camera: 'unsupported' };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
      stream.getTracks().forEach((track) => track.stop());
      return { camera: 'granted' };
    } catch {
      return { camera: 'denied' };
    }
  }

  async probeCapabilities(): Promise<DeviceCapabilityReport> {
    const perm = await this.checkPermissions();
    return {
      probedAtIso: new Date().toISOString(),
      platform: 'web',
      isSimulator: false,
      deviceModel:
        typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown-web',
      systemVersion: 'browser',
      cameraPermission: perm.camera,
      trueDepthSupported: false,
      activeDeviceType: 'web_media_devices',
      photoOutputDepthDeliverySupported: false,
      totalFrontFormatCount: 0,
      depthCapableFormats: [],
      notes: [
        'Running in web browser fallback. Standard browser APIs do not expose iPhone TrueDepth camera data.',
        'Build and run the Capacitor iOS app on a physical iPhone to execute native TrueDepth captures.',
      ],
    };
  }

  async capturePairedPhoto(
    options: CapturePairedPhotoOptions
  ): Promise<NativeCaptureRecord> {
    const startMs = performance.now();
    const warnings: string[] = [
      'Captured via web fallback; TrueDepth is unavailable in the browser.',
    ];

    let width = 0;
    let height = 0;
    let rgbDataUrl: string | undefined;

    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
      try {
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play();

        width = video.videoWidth || 640;
        height = video.videoHeight || 480;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, width, height);
          rgbDataUrl = canvas.toDataURL('image/jpeg', 0.92);
        }
      } finally {
        stream.getTracks().forEach((track) => track.stop());
      }
    } else {
      warnings.push(
        'navigator.mediaDevices.getUserMedia is unavailable in this browser context.'
      );
    }

    return this.buildAndStoreWebRecord({
      options,
      width,
      height,
      rgbDataUrl,
      startMs,
      warnings,
    });
  }

  async openGuidedCapture(
    options: OpenGuidedCaptureOptions
  ): Promise<OpenGuidedCaptureResult> {
    if (
      typeof document === 'undefined' ||
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      throw new Error(
        'Live browser camera preview requires navigator.mediaDevices.getUserMedia.'
      );
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      audio: false,
    });

    const snapshot: LiveGuidanceSnapshot = {
      timestampIso: new Date().toISOString(),
      view: options.view,
      variant: options.variant,
      thresholdsProvisional: true,
      faceCount: 0,
      faceCentered: null,
      faceCoverageRatio: null,
      yawDegrees: null,
      rollDegrees: null,
      pitchDegrees: null,
      meanLuma: null,
      clippedHighlightRatio: null,
      clippedShadowRatio: null,
      sharpnessScore: null,
      isSharp: null,
      neutralExpression: null,
      mouthOpenRatio: null,
      mouthWidthRatio: null,
      depthAvailable: false,
      faceDistanceMeters: null,
      depthValidRatio: null,
      distanceState: 'unavailable',
      sessionInterrupted: false,
      readyToCapture: true,
      guidanceMessages: [
        'Web fallback preview: TrueDepth distance, sharpness, and native Vision landmarks are unavailable in browser.',
      ],
    };
    this.notifyListeners('guidanceUpdate', snapshot);

    return new Promise<OpenGuidedCaptureResult>((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:99999;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:20px;color:#fff;font-family:-apple-system,system-ui,sans-serif;';

      const banner = document.createElement('div');
      banner.style.cssText =
        'background:rgba(0,0,0,0.72);border:1px solid rgba(255,255,255,0.2);border-radius:12px;padding:12px 16px;max-width:520px;width:100%;font-size:13px;';
      banner.innerHTML = `<strong>WEB FALLBACK (${options.view} · ${options.variant})</strong><br/>Mirrored preview only — saved photo stays unmirrored. TrueDepth is unavailable in browser.`;

      const videoWrap = document.createElement('div');
      videoWrap.style.cssText =
        'position:relative;flex:1;display:flex;align-items:center;justify-content:center;width:100%;max-width:520px;margin:14px 0;overflow:hidden;border-radius:14px;';

      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      video.style.cssText =
        'width:100%;height:100%;object-fit:cover;transform:scaleX(-1);';
      videoWrap.appendChild(video);

      let ghostImg: HTMLImageElement | null = null;
      if (options.ghostImageUri && options.variant !== 'rgb_unguided') {
        ghostImg = document.createElement('img');
        ghostImg.src = options.ghostImageUri;
        ghostImg.alt = 'Previous session alignment overlay';
        const opacity = Math.min(0.6, Math.max(0.05, options.ghostOpacity ?? 0.28));
        ghostImg.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);opacity:${opacity};pointer-events:none;`;
        videoWrap.appendChild(ghostImg);
      }

      if (options.variant !== 'rgb_unguided') {
        const oval = document.createElement('div');
        oval.style.cssText =
          'position:absolute;width:62%;aspect-ratio:3/4;border:2px dashed rgba(255,255,255,0.75);border-radius:50%;pointer-events:none;';
        videoWrap.appendChild(oval);
      }

      const controls = document.createElement('div');
      controls.style.cssText = 'display:flex;gap:12px;align-items:center;';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText =
        'padding:10px 18px;border-radius:999px;border:1px solid #555;background:#222;color:#fff;font-weight:600;cursor:pointer;';

      const captureBtn = document.createElement('button');
      captureBtn.textContent = 'Capture RGB';
      captureBtn.style.cssText =
        'padding:12px 22px;border-radius:999px;border:none;background:#4fa3ff;color:#071422;font-weight:700;cursor:pointer;';

      controls.append(cancelBtn, captureBtn);

      if (ghostImg) {
        const ghostBtn = document.createElement('button');
        let ghostVisible = true;
        ghostBtn.textContent = 'Ghost: On';
        ghostBtn.style.cssText =
          'padding:10px 14px;border-radius:999px;border:1px solid #555;background:#222;color:#fff;font-weight:600;cursor:pointer;';
        ghostBtn.onclick = () => {
          ghostVisible = !ghostVisible;
          if (ghostImg) {
            ghostImg.style.display = ghostVisible ? 'block' : 'none';
          }
          ghostBtn.textContent = ghostVisible ? 'Ghost: On' : 'Ghost: Off';
        };
        controls.append(ghostBtn);
      }

      overlay.append(banner, videoWrap, controls);
      document.body.appendChild(overlay);
      void video.play();

      const cleanup = () => {
        stream.getTracks().forEach((track) => track.stop());
        overlay.remove();
      };

      cancelBtn.onclick = () => {
        cleanup();
        resolve({ cancelled: true });
      };

      captureBtn.onclick = () => {
        const startMs = performance.now();
        const width = video.videoWidth || 640;
        const height = video.videoHeight || 480;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        let rgbDataUrl: string | undefined;
        if (ctx) {
          ctx.drawImage(video, 0, 0, width, height);
          rgbDataUrl = canvas.toDataURL('image/jpeg', 0.92);
        }
        cleanup();

        const record = this.buildAndStoreWebRecord({
          options,
          width,
          height,
          rgbDataUrl,
          startMs,
          warnings: [
            'Captured via live web fallback modal; TrueDepth is unavailable in browser.',
          ],
          liveGuidanceAtShutter: {
            ...snapshot,
            timestampIso: new Date().toISOString(),
          },
        });
        resolve({ cancelled: false, record });
      };
    });
  }

  async listLocalSessions(): Promise<{ sessions: NativeCaptureRecord[] }> {
    return { sessions: this.readStoredSessions() };
  }

  async deleteLocalSession(options: {
    sessionId: string;
  }): Promise<{ deleted: boolean }> {
    const existing = this.readStoredSessions();
    const filtered = existing.filter((s) => s.sessionId !== options.sessionId);
    const deleted = filtered.length !== existing.length;
    this.writeStoredSessions(filtered);
    return { deleted };
  }

  private buildAndStoreWebRecord(params: {
    options: CapturePairedPhotoOptions;
    width: number;
    height: number;
    rgbDataUrl?: string;
    startMs: number;
    warnings: string[];
    liveGuidanceAtShutter?: LiveGuidanceSnapshot;
  }): NativeCaptureRecord {
    const record: NativeCaptureRecord = {
      sessionId: crypto.randomUUID(),
      capturedAtIso: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      platform: 'web',
      isSimulatedOrWebFallback: true,
      deviceModel:
        typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown-web',
      systemVersion: 'browser',
      cameraDeviceType: 'web_media_devices',
      view: params.options.view,
      requestedVariant: params.options.variant,
      effectiveCaptureMode: 'rgb_only_web_fallback',
      storedImageMirrored: false,
      rgbDimensions: { width: params.width, height: params.height },
      rgbFileUri: params.rgbDataUrl,
      depth: {
        available: false,
        unavailableReason: params.options.requestDepth
          ? 'TrueDepth is unavailable in browser fallback mode.'
          : 'Depth was not requested for this capture.',
        calibration: { present: false },
      },
      liveGuidanceAtShutter: params.liveGuidanceAtShutter,
      captureDurationMs: Math.round(performance.now() - params.startMs),
      warnings: params.warnings,
    };

    const existing = this.readStoredSessions();
    const storableRecord: NativeCaptureRecord = {
      ...record,
      rgbFileUri: undefined,
    };
    existing.unshift(storableRecord);
    this.writeStoredSessions(existing.slice(0, 50));

    return record;
  }

  private readStoredSessions(): NativeCaptureRecord[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(WEB_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeStoredSessions(sessions: NativeCaptureRecord[]): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(sessions));
    } catch {
      // Ignore quota errors in web fallback
    }
  }
}
