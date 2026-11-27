import { Component, type ReactNode, useEffect, useMemo, useState } from 'react';
import type {
  BlemishAnalysisRecord,
  CameraPermissionState,
  CaptureView,
  ColorimetryAnalysisRecord,
  DeviceCapabilityReport,
  ExperimentVariant,
  LiveGuidanceSnapshot,
} from '@skin-trace/truedepth-camera';
import { cameraBridge, resolvePreviewSrc } from './services/cameraBridge';
import { BeforeAfterViewer } from './components/BeforeAfterViewer';
import { BlemishInspector } from './components/BlemishInspector';
import { ValidationLab } from './components/ValidationLab';
import {
  buildM0SessionEnvelope,
  type SessionEnvelope,
} from './types/domain';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app-shell">
          <div className="error-box" role="alert">
            <strong>Runtime render error:</strong> {this.state.error.message}
          </div>
          <button
            type="button"
            className="primary"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}

type DistancePreset = 'calibrated_22_34' | 'tight_20_30' | 'wide_28_42';
type ActiveTab = 'capture' | 'compare' | 'validation';

const DISTANCE_PRESETS: Record<
  DistancePreset,
  { label: string; minMeters: number; maxMeters: number }
> = {
  calibrated_22_34: {
    label: '22–34 cm (Calibrated handheld sweet spot)',
    minMeters: 0.22,
    maxMeters: 0.34,
  },
  tight_20_30: {
    label: '20–30 cm (Close TrueDepth range)',
    minMeters: 0.2,
    maxMeters: 0.3,
  },
  wide_28_42: {
    label: '28–42 cm (Wider framing)',
    minMeters: 0.28,
    maxMeters: 0.42,
  },
};

export function App() {
  return (
    <AppErrorBoundary>
      <CaptureLab />
    </AppErrorBoundary>
  );
}

function CaptureLab() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('capture');
  const [permission, setPermission] = useState<CameraPermissionState>('prompt');
  const [report, setReport] = useState<DeviceCapabilityReport | null>(null);
  const [sessions, setSessions] = useState<SessionEnvelope[]>([]);
  const [latestGuidance, setLatestGuidance] =
    useState<LiveGuidanceSnapshot | null>(null);
  const [view, setView] = useState<CaptureView>('front');
  const [variant, setVariant] = useState<ExperimentVariant>('rgb_depth_guided');
  const [distancePreset, setDistancePreset] =
    useState<DistancePreset>('calibrated_22_34');
  const [useGhostOverlay, setUseGhostOverlay] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedReport, setCopiedReport] = useState(false);
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const [inspectedSessionId, setInspectedSessionId] = useState<string | null>(
    null
  );

  const inspectedSession = useMemo(
    () =>
      sessions.find((s) => s.capture.sessionId === inspectedSessionId) ?? null,
    [sessions, inspectedSessionId]
  );

  function handleAnalysisSaved(
    sessionId: string,
    analysisRecord: BlemishAnalysisRecord
  ) {
    setSessions((prev) =>
      prev.map((item) =>
        item.capture.sessionId === sessionId
          ? buildM0SessionEnvelope({
              ...item.capture,
              blemishAnalysis: analysisRecord,
            })
          : item
      )
    );
  }

  function handleColorimetrySaved(
    sessionId: string,
    colorimetryRecord: ColorimetryAnalysisRecord
  ) {
    setSessions((prev) =>
      prev.map((item) =>
        item.capture.sessionId === sessionId
          ? buildM0SessionEnvelope({
              ...item.capture,
              colorimetryAnalysis: colorimetryRecord,
            })
          : item
      )
    );
  }

  const platform = cameraBridge.getPlatform();
  const isNative = cameraBridge.isNativePlatform();

  const latestMatchingGhostUri = useMemo(() => {
    const match = sessions.find(
      (s) => s.capture.view === view && Boolean(s.capture.rgbFileUri)
    );
    return match?.capture.rgbFileUri;
  }, [sessions, view]);

  useEffect(() => {
    void refreshInitialState();
    let active = true;
    let removeListener: (() => Promise<void>) | undefined;

    void cameraBridge
      .onGuidanceUpdate((snapshot) => {
        if (active) {
          setLatestGuidance(snapshot);
        }
      })
      .then((handle) => {
        removeListener = () => handle.remove();
      })
      .catch(() => {
        // Ignore if listener registration fails in restricted context
      });

    return () => {
      active = false;
      if (removeListener) {
        void removeListener();
      }
    };
  }, []);

  async function refreshInitialState() {
    try {
      const [perm, localSessions] = await Promise.all([
        cameraBridge.checkPermissions(),
        cameraBridge.listLocalSessions(),
      ]);
      setPermission(perm);
      setSessions(localSessions.map(buildM0SessionEnvelope));
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to initialize camera bridge.'
      );
    }
  }

  async function handleRequestPermission() {
    setBusyAction('permission');
    setErrorMsg(null);
    try {
      const state = await cameraBridge.requestPermissions();
      setPermission(state);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Permission request failed.'
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleProbeCapabilities() {
    setBusyAction('probe');
    setErrorMsg(null);
    setCopiedReport(false);
    try {
      const result = await cameraBridge.probeCapabilities();
      setReport(result);
      setPermission(result.cameraPermission);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Capability probe failed.'
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleOpenLiveGuidedCapture() {
    setBusyAction('guided');
    setErrorMsg(null);
    try {
      const requestDepth = variant === 'rgb_depth_guided';
      const preset = DISTANCE_PRESETS[distancePreset];
      const res = await cameraBridge.openGuidedCapture({
        view,
        variant,
        requestDepth,
        targetMinDistanceMeters: preset.minMeters,
        targetMaxDistanceMeters: preset.maxMeters,
        ghostImageUri:
          useGhostOverlay && variant !== 'rgb_unguided'
            ? latestMatchingGhostUri
            : undefined,
        ghostOpacity: 0.28,
      });
      if (!res.cancelled && res.record) {
        setSessions((prev) => [buildM0SessionEnvelope(res.record!), ...prev]);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Live guided capture failed.'
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleQuickCapture() {
    setBusyAction('capture');
    setErrorMsg(null);
    try {
      const requestDepth = variant === 'rgb_depth_guided';
      const capture = await cameraBridge.capturePairedPhoto({
        view,
        variant,
        requestDepth,
      });
      setSessions((prev) => [buildM0SessionEnvelope(capture), ...prev]);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Paired photo capture failed.'
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDeleteSession(sessionId: string) {
    setErrorMsg(null);
    try {
      const deleted = await cameraBridge.deleteLocalSession(sessionId);
      if (deleted) {
        setSessions((prev) =>
          prev.filter((item) => item.capture.sessionId !== sessionId)
        );
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to delete local session.'
      );
    }
  }

  async function handleCopyReportJson() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopiedReport(true);
    } catch {
      setErrorMsg('Clipboard copy unavailable in this environment.');
    }
  }

  async function handleCopySessionJson(session: SessionEnvelope) {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(session.capture, null, 2)
      );
      setCopiedSessionId(session.capture.sessionId);
    } catch {
      setErrorMsg('Clipboard copy unavailable in this environment.');
    }
  }

  return (
    <main className="app-shell">
      <header className="header">
        <div className="header-row">
          <h1>Skin Trace — Capture &amp; Blemish Lab</h1>
          <div className="badge-row">
            <span className={`badge ${isNative ? 'ok' : 'warn'}`}>
              Runtime: {platform}
            </span>
            <span
              className={`badge ${
                permission === 'granted'
                  ? 'ok'
                  : permission === 'denied' || permission === 'restricted'
                    ? 'danger'
                    : 'warn'
              }`}
            >
              Camera: {permission}
            </span>
            {(() => {
              const measuredCount = sessions.filter(
                (s) => s.analysis.state === 'measured'
              ).length;
              return (
                <span
                  className={`badge ${measuredCount > 0 ? 'ok' : ''}`}
                >
                  {measuredCount > 0
                    ? `Analyzed: ${measuredCount}/${sessions.length}`
                    : 'Analysis: not_analyzed'}
                </span>
              );
            })()}
          </div>
        </div>
        <p className="subtitle">
          AVFoundation paired 12 MP RGB + TrueDepth capture with live quality
          gating (distance, blur, exposure, neutral expression) and ghost
          alignment overlay. Original captures remain local on-device.
        </p>
      </header>

      <nav className="tab-bar" aria-label="App sections">
        <button
          type="button"
          className={activeTab === 'capture' ? 'primary' : ''}
          onClick={() => setActiveTab('capture')}
        >
          Capture Lab
        </button>
        <button
          type="button"
          className={activeTab === 'compare' ? 'primary' : ''}
          onClick={() => setActiveTab('compare')}
        >
          Timeline &amp; Compare ({sessions.length})
        </button>
        <button
          type="button"
          className={activeTab === 'validation' ? 'primary' : ''}
          onClick={() => setActiveTab('validation')}
        >
          Validation Lab (M4)
        </button>
      </nav>

      {errorMsg && (
        <div className="error-box" role="alert">
          {errorMsg}
        </div>
      )}

      {activeTab === 'compare' ? (
        <BeforeAfterViewer sessions={sessions} />
      ) : activeTab === 'validation' ? (
        <ValidationLab
          sessions={sessions}
          onAnalysisSaved={handleAnalysisSaved}
          onColorimetrySaved={handleColorimetrySaved}
        />
      ) : inspectedSession ? (
        <BlemishInspector
          session={inspectedSession}
          onAnalysisSaved={handleAnalysisSaved}
          onColorimetrySaved={handleColorimetrySaved}
          onClose={() => setInspectedSessionId(null)}
        />
      ) : (
        <>
          <section className="card">
        <h2>1. Hardware &amp; TrueDepth Capability Probe</h2>
        <div className="controls">
          <button
            type="button"
            onClick={handleRequestPermission}
            disabled={busyAction !== null}
          >
            {busyAction === 'permission'
              ? 'Requesting…'
              : 'Request Camera Permission'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={handleProbeCapabilities}
            disabled={busyAction !== null}
          >
            {busyAction === 'probe'
              ? 'Probing…'
              : 'Probe Hardware Capabilities'}
          </button>
          {report && (
            <button type="button" onClick={handleCopyReportJson}>
              {copiedReport ? 'Copied JSON' : 'Copy JSON for M0 Report'}
            </button>
          )}
        </div>

        {report && (
          <>
            <div className="kv-grid">
              <div className="kv-item">
                <div className="kv-label">Device</div>
                <div className="kv-value">
                  {report.deviceModel}
                  {report.isSimulator ? ' (Simulator)' : ''}
                </div>
              </div>
              <div className="kv-item">
                <div className="kv-label">OS / Runtime</div>
                <div className="kv-value">
                  {report.platform} {report.systemVersion}
                </div>
              </div>
              <div className="kv-item">
                <div className="kv-label">TrueDepth Hardware</div>
                <div className="kv-value">
                  {report.trueDepthSupported ? 'Supported' : 'Unavailable'}
                </div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Photo Depth Delivery</div>
                <div className="kv-value">
                  {report.photoOutputDepthDeliverySupported === null
                    ? 'Unknown (authorize camera)'
                    : report.photoOutputDepthDeliverySupported
                      ? 'Supported'
                      : 'Not supported'}
                </div>
              </div>
              <div className="kv-item">
                <div className="kv-label">Depth-Capable Formats</div>
                <div className="kv-value">
                  {report.depthCapableFormats.length} /{' '}
                  {report.totalFrontFormatCount} front formats
                </div>
              </div>
            </div>

            {report.notes.length > 0 && (
              <ul className="note-list">
                {report.notes.map((note, idx) => (
                  <li key={idx}>{note}</li>
                ))}
              </ul>
            )}

            <details>
              <summary style={{ marginTop: 12, cursor: 'pointer' }}>
                Raw Capability Probe JSON
              </summary>
              <pre className="json-box">{JSON.stringify(report, null, 2)}</pre>
            </details>
          </>
        )}
      </section>

      <section className="card">
        <h2>2. Live Guided &amp; Paired Capture Experiment</h2>
        <div className="field-grid">
          <label>
            Capture View
            <select
              value={view}
              onChange={(e) => setView(e.target.value as CaptureView)}
            >
              <option value="front">Front</option>
              <option value="left_cheek">Left Cheek</option>
              <option value="right_cheek">Right Cheek</option>
            </select>
          </label>
          <label>
            Experiment Variant (§7.2)
            <select
              value={variant}
              onChange={(e) => setVariant(e.target.value as ExperimentVariant)}
            >
              <option value="rgb_depth_guided">
                Variant C: RGB + TrueDepth Guided
              </option>
              <option value="rgb_guided">Variant B: RGB Guided (No Depth)</option>
              <option value="rgb_unguided">
                Variant A: RGB Unguided Baseline
              </option>
            </select>
          </label>
          <label>
            Target Stand-Off Range
            <select
              value={distancePreset}
              onChange={(e) =>
                setDistancePreset(e.target.value as DistancePreset)
              }
            >
              {Object.entries(DISTANCE_PRESETS).map(([key, item]) => (
                <option key={key} value={key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={useGhostOverlay}
            disabled={!latestMatchingGhostUri || variant === 'rgb_unguided'}
            onChange={(e) => setUseGhostOverlay(e.target.checked)}
          />
          <span>
            Show previous <strong>{view}</strong> photo as translucent alignment
            ghost
            {!latestMatchingGhostUri ? ' (capture one first)' : ''}
          </span>
        </label>

        <div className="controls">
          <button
            type="button"
            className="primary"
            onClick={handleOpenLiveGuidedCapture}
            disabled={busyAction !== null}
          >
            {busyAction === 'guided'
              ? 'Camera Active…'
              : 'Open Live Guided Camera'}
          </button>
          <button
            type="button"
            onClick={handleQuickCapture}
            disabled={busyAction !== null}
          >
            {busyAction === 'capture'
              ? 'Capturing…'
              : 'Quick Headless Capture'}
          </button>
        </div>

        {latestGuidance &&
          variant !== 'rgb_unguided' &&
          latestGuidance.variant !== 'rgb_unguided' && (
          <div className="kv-grid">
            <div className="kv-item">
              <div className="kv-label">Last Live Distance</div>
              <div className="kv-value">
                {isFiniteNumber(latestGuidance.faceDistanceMeters)
                  ? `${(latestGuidance.faceDistanceMeters * 100).toFixed(1)} cm (${latestGuidance.distanceState})`
                  : latestGuidance.distanceState}
              </div>
            </div>
            <div className="kv-item">
              <div className="kv-label">Sharpness / Expression</div>
              <div className="kv-value">
                {isFiniteNumber(latestGuidance.sharpnessScore)
                  ? `${latestGuidance.sharpnessScore.toFixed(0)} (${latestGuidance.isSharp ? 'sharp' : 'soft'})`
                  : '—'}{' '}
                ·{' '}
                {typeof latestGuidance.neutralExpression !== 'boolean'
                  ? 'Expr: —'
                  : latestGuidance.neutralExpression
                    ? 'Neutral'
                    : 'Non-neutral'}
              </div>
            </div>
            <div className="kv-item">
              <div className="kv-label">Last Face / Pose</div>
              <div className="kv-value">
                Faces: {latestGuidance.faceCount} · Yaw:{' '}
                {isFiniteNumber(latestGuidance.yawDegrees)
                  ? `${latestGuidance.yawDegrees.toFixed(0)}°`
                  : '—'}
              </div>
            </div>
            <div className="kv-item">
              <div className="kv-label">Last Live Prompt</div>
              <div className="kv-value">
                {latestGuidance.guidanceMessages?.[0] ?? '—'}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>3. Local Capture Sessions ({sessions.length})</h2>
        {sessions.length === 0 ? (
          <p className="subtitle">
            No local captures recorded yet. Captures stay strictly on-device.
          </p>
        ) : (
          <div className="session-list">
            {sessions.map(({ capture, quality, analysis }) => {
              const previewSrc = resolvePreviewSrc(capture.rgbFileUri);
              const shutter = capture.liveGuidanceAtShutter;
              const cam = capture.cameraMetadata;
              return (
                <article key={capture.sessionId} className="session-item">
                  <div className="session-top">
                    <div>
                      <div className="badge-row">
                        <span
                          className={`badge ${
                            capture.effectiveCaptureMode === 'rgb_plus_truedepth'
                              ? 'ok'
                              : 'warn'
                          }`}
                        >
                          {capture.effectiveCaptureMode}
                        </span>
                        <span className="badge">{capture.view}</span>
                        <span className="badge">{capture.requestedVariant}</span>
                        <span
                          className={`badge ${
                            quality.acceptanceState === 'accepted'
                              ? 'ok'
                              : quality.acceptanceState === 'rejected'
                                ? 'warn'
                                : ''
                          }`}
                        >
                          Quality: {quality.acceptanceState}
                        </span>
                        <span
                          className={`badge ${
                            capture.blemishAnalysis?.state === 'measured'
                              ? 'ok'
                              : ''
                          }`}
                        >
                          Blemishes:{' '}
                          {capture.blemishAnalysis?.state ?? 'not_analyzed'}
                          {capture.blemishAnalysis?.state === 'measured'
                            ? ` (${(capture.blemishAnalysis.regions ?? []).reduce((sum, r) => sum + r.activeBlemishCount, 0)} active / ${(capture.blemishAnalysis.regions ?? []).reduce((sum, r) => sum + r.residualMarkCount, 0)} residual)`
                            : ''}
                        </span>
                        <span
                          className={`badge ${
                            capture.colorimetryAnalysis?.state === 'measured'
                              ? 'ok'
                              : ''
                          }`}
                        >
                          Colorimetry:{' '}
                          {capture.colorimetryAnalysis?.state ?? 'not_analyzed'}
                        </span>
                      </div>
                      <p className="subtitle" style={{ marginTop: 6 }}>
                        {capture.capturedAtIso} ({capture.timezone}) ·{' '}
                        {capture.captureDurationMs} ms · Stored mirrored:{' '}
                        {capture.storedImageMirrored ? 'yes' : 'no'}
                      </p>
                    </div>
                    <div className="controls" style={{ marginTop: 0 }}>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => setInspectedSessionId(capture.sessionId)}
                      >
                        Inspect / Annotate
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleCopySessionJson({ capture, quality, analysis })
                        }
                      >
                        {copiedSessionId === capture.sessionId
                          ? 'Copied JSON'
                          : 'Copy JSON'}
                      </button>
                      <button
                        type="button"
                        className="danger-btn"
                        onClick={() => handleDeleteSession(capture.sessionId)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  <div className="kv-grid">
                    <div className="kv-item">
                      <div className="kv-label">RGB Resolution</div>
                      <div className="kv-value">
                        {capture.rgbDimensions.width} ×{' '}
                        {capture.rgbDimensions.height}
                        {capture.selectedVideoFormat
                          ? ` (stream ${capture.selectedVideoFormat.width}×${capture.selectedVideoFormat.height} ${capture.selectedVideoFormat.pixelFormat})`
                          : ''}
                      </div>
                    </div>
                    <div className="kv-item">
                      <div className="kv-label">Depth Map</div>
                      <div className="kv-value">
                        {capture.depth.available
                          ? `${capture.depth.width} × ${capture.depth.height} (${capture.depth.originalPixelFormat})`
                          : 'Unavailable'}
                      </div>
                    </div>
                    <div className="kv-item">
                      <div className="kv-label">Depth Quality / Accuracy</div>
                      <div className="kv-value">
                        {capture.depth.available
                          ? `${capture.depth.quality} / ${capture.depth.accuracy}`
                          : '—'}
                      </div>
                    </div>
                    <div className="kv-item">
                      <div className="kv-label">Center Distance / Scale</div>
                      <div className="kv-value">
                        {isFiniteNumber(capture.depth?.centerWindowMedianMeters)
                          ? `${(capture.depth.centerWindowMedianMeters * 100).toFixed(1)} cm`
                          : '—'}
                        {isFiniteNumber(capture.depth?.estimatedMmPerPixelAtRgb)
                          ? ` · ${capture.depth.estimatedMmPerPixelAtRgb.toFixed(3)} mm/px`
                          : ''}
                      </div>
                    </div>
                    <div className="kv-item">
                      <div className="kv-label">Valid Depth / Calibration</div>
                      <div className="kv-value">
                        {isFiniteNumber(capture.depth?.validPixelRatio)
                          ? `${(capture.depth.validPixelRatio * 100).toFixed(1)}%`
                          : '—'}{' '}
                        ·{' '}
                        {capture.depth?.calibration?.present
                          ? 'Calibrated'
                          : 'No cal'}
                      </div>
                    </div>
                    {cam && (
                      <div className="kv-item">
                        <div className="kv-label">Exposure / White Balance</div>
                        <div className="kv-value">
                          ISO {isFiniteNumber(cam.iso) ? Math.round(cam.iso) : '—'} ·{' '}
                          {isFiniteNumber(cam.exposureDurationMs)
                            ? `${cam.exposureDurationMs.toFixed(1)} ms`
                            : '—'}{' '}
                          · WB{' '}
                          {isFiniteNumber(cam.whiteBalanceRedGain)
                            ? cam.whiteBalanceRedGain.toFixed(2)
                            : '—'}
                          /
                          {isFiniteNumber(cam.whiteBalanceGreenGain)
                            ? cam.whiteBalanceGreenGain.toFixed(2)
                            : '—'}
                          /
                          {isFiniteNumber(cam.whiteBalanceBlueGain)
                            ? cam.whiteBalanceBlueGain.toFixed(2)
                            : '—'}
                        </div>
                      </div>
                    )}
                    {shutter && (
                      <div className="kv-item">
                        <div className="kv-label">Shutter Quality Signals</div>
                        <div className="kv-value">
                          Sharp:{' '}
                          {isFiniteNumber(shutter.sharpnessScore)
                            ? shutter.sharpnessScore.toFixed(0)
                            : '—'}{' '}
                          · Expr:{' '}
                          {typeof shutter.neutralExpression !== 'boolean'
                            ? '—'
                            : shutter.neutralExpression
                              ? 'Neutral'
                              : 'Non-neutral'}{' '}
                          · Glare:{' '}
                          {isFiniteNumber(shutter.clippedHighlightRatio)
                            ? `${(shutter.clippedHighlightRatio * 100).toFixed(1)}%`
                            : '—'}
                        </div>
                      </div>
                    )}
                  </div>

                  {previewSrc && (
                    <img
                      className="preview-img"
                      src={previewSrc}
                      alt={`Captured ${capture.view} preview`}
                    />
                  )}

                  {capture.warnings.length > 0 && (
                    <ul className="note-list">
                      {capture.warnings.map((w, idx) => (
                        <li key={idx}>{w}</li>
                      ))}
                    </ul>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
        </>
      )}
    </main>
  );
}
