import { useEffect, useState } from 'react';
import type {
  CameraPermissionState,
  CaptureView,
  DeviceCapabilityReport,
  ExperimentVariant,
  LiveGuidanceSnapshot,
} from '@skin-trace/truedepth-camera';
import { cameraBridge, resolvePreviewSrc } from './services/cameraBridge';
import {
  buildM0SessionEnvelope,
  type SessionEnvelope,
} from './types/domain';

export function App() {
  const [permission, setPermission] = useState<CameraPermissionState>('prompt');
  const [report, setReport] = useState<DeviceCapabilityReport | null>(null);
  const [sessions, setSessions] = useState<SessionEnvelope[]>([]);
  const [latestGuidance, setLatestGuidance] =
    useState<LiveGuidanceSnapshot | null>(null);
  const [view, setView] = useState<CaptureView>('front');
  const [variant, setVariant] = useState<ExperimentVariant>('rgb_depth_guided');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedReport, setCopiedReport] = useState(false);

  const platform = cameraBridge.getPlatform();
  const isNative = cameraBridge.isNativePlatform();

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
      const res = await cameraBridge.openGuidedCapture({
        view,
        variant,
        requestDepth,
        targetMinDistanceMeters: 0.28,
        targetMaxDistanceMeters: 0.42,
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

  return (
    <main className="app-shell">
      <header className="header">
        <div className="header-row">
          <h1>Skin Trace — M0 Capture Lab</h1>
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
            <span className="badge">AI Analysis: not_analyzed (M0)</span>
          </div>
        </div>
        <p className="subtitle">
          Physical iPhone 16 Pro AVFoundation RGB + TrueDepth feasibility probe
          and live synchronized guidance lab. Original captures remain local
          on-device; no detections or progress scores are fabricated.
        </p>
      </header>

      {errorMsg && (
        <div className="error-box" role="alert">
          {errorMsg}
        </div>
      )}

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
        </div>

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

        {latestGuidance && (
          <div className="kv-grid">
            <div className="kv-item">
              <div className="kv-label">Last Live Distance</div>
              <div className="kv-value">
                {latestGuidance.faceDistanceMeters !== null
                  ? `${(latestGuidance.faceDistanceMeters * 100).toFixed(1)} cm (${latestGuidance.distanceState})`
                  : latestGuidance.distanceState}
              </div>
            </div>
            <div className="kv-item">
              <div className="kv-label">Last Face / Pose</div>
              <div className="kv-value">
                Faces: {latestGuidance.faceCount} · Yaw:{' '}
                {latestGuidance.yawDegrees !== null
                  ? `${latestGuidance.yawDegrees.toFixed(0)}°`
                  : '—'}
              </div>
            </div>
            <div className="kv-item">
              <div className="kv-label">Last Live Prompt</div>
              <div className="kv-value">
                {latestGuidance.guidanceMessages[0] ?? '—'}
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
                        <span className="badge">
                          Analysis: {analysis.state}
                        </span>
                      </div>
                      <p className="subtitle" style={{ marginTop: 6 }}>
                        {capture.capturedAtIso} ({capture.timezone}) ·{' '}
                        {capture.captureDurationMs} ms · Stored mirrored:{' '}
                        {capture.storedImageMirrored ? 'yes' : 'no'}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="danger-btn"
                      onClick={() => handleDeleteSession(capture.sessionId)}
                    >
                      Delete
                    </button>
                  </div>

                  <div className="kv-grid">
                    <div className="kv-item">
                      <div className="kv-label">RGB Resolution</div>
                      <div className="kv-value">
                        {capture.rgbDimensions.width} ×{' '}
                        {capture.rgbDimensions.height}
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
                      <div className="kv-label">Center Distance (Median)</div>
                      <div className="kv-value">
                        {capture.depth.centerWindowMedianMeters !== undefined
                          ? `${capture.depth.centerWindowMedianMeters.toFixed(3)} m`
                          : '—'}
                      </div>
                    </div>
                    <div className="kv-item">
                      <div className="kv-label">Valid Depth Coverage</div>
                      <div className="kv-value">
                        {capture.depth.validPixelRatio !== undefined
                          ? `${(capture.depth.validPixelRatio * 100).toFixed(1)}%`
                          : '—'}
                      </div>
                    </div>
                    <div className="kv-item">
                      <div className="kv-label">Calibration Data</div>
                      <div className="kv-value">
                        {capture.depth.calibration?.present
                          ? 'Present'
                          : 'Not present'}
                      </div>
                    </div>
                    {shutter && (
                      <div className="kv-item">
                        <div className="kv-label">Shutter Guidance</div>
                        <div className="kv-value">
                          Faces: {shutter.faceCount} · Dist:{' '}
                          {shutter.faceDistanceMeters !== null
                            ? `${(shutter.faceDistanceMeters * 100).toFixed(1)} cm`
                            : '—'}{' '}
                          · Yaw:{' '}
                          {shutter.yawDegrees !== null
                            ? `${shutter.yawDegrees.toFixed(0)}°`
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
    </main>
  );
}
