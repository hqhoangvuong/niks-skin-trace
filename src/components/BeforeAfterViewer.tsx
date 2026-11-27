import { useEffect, useMemo, useState } from 'react';
import type {
  CaptureView,
  FacialRegionMap,
  NativeCaptureRecord,
} from '@skin-trace/truedepth-camera';
import { resolvePreviewSrc } from '../services/cameraBridge';
import { computePairAlignmentTransform } from '../services/alignment';
import { evaluateComparability } from '../services/comparison';
import type { SessionEnvelope } from '../types/domain';

interface BeforeAfterViewerProps {
  sessions: SessionEnvelope[];
}

function formatShortTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatDayKey(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function renderRegionBoxes(regions?: FacialRegionMap) {
  if (!regions) return null;
  const entries: Array<{ key: string; label: string; rect: { x: number; y: number; width: number; height: number } }> = [];
  if (regions.forehead) entries.push({ key: 'fh', label: 'Forehead', rect: regions.forehead });
  if (regions.anatomicalLeftCheek) entries.push({ key: 'lc', label: 'L Cheek', rect: regions.anatomicalLeftCheek });
  if (regions.anatomicalRightCheek) entries.push({ key: 'rc', label: 'R Cheek', rect: regions.anatomicalRightCheek });
  if (regions.chin) entries.push({ key: 'ch', label: 'Chin', rect: regions.chin });

  return entries.map(({ key, label, rect }) => (
    <div
      key={key}
      className="roi-box"
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`,
      }}
    >
      <span className="roi-label">{label}</span>
    </div>
  ));
}

export function BeforeAfterViewer({ sessions }: BeforeAfterViewerProps) {
  const [selectedView, setSelectedView] = useState<CaptureView>('front');
  const [viewerMode, setViewerMode] = useState<'slider' | 'side_by_side'>(
    'slider'
  );
  const [splitPct, setSplitPct] = useState(50);
  const [autoAlign, setAutoAlign] = useState(true);
  const [showRois, setShowRois] = useState(true);
  const [zoom, setZoom] = useState(1);

  const viewSessions = useMemo(
    () => sessions.filter((s) => s.capture.view === selectedView),
    [sessions, selectedView]
  );

  // Sessions are newest-first: default baseline = older capture, current = newest capture.
  const [baselineId, setBaselineId] = useState<string>('');
  const [currentId, setCurrentId] = useState<string>('');

  useEffect(() => {
    if (viewSessions.length >= 2) {
      const hasCurrent = viewSessions.some(
        (s) => s.capture.sessionId === currentId
      );
      const hasBase = viewSessions.some(
        (s) => s.capture.sessionId === baselineId
      );
      if (!hasCurrent) {
        setCurrentId(viewSessions[0].capture.sessionId);
      }
      if (!hasBase) {
        setBaselineId(viewSessions[1].capture.sessionId);
      }
    } else if (viewSessions.length === 1) {
      setCurrentId(viewSessions[0].capture.sessionId);
      setBaselineId(viewSessions[0].capture.sessionId);
    } else {
      setCurrentId('');
      setBaselineId('');
    }
  }, [viewSessions, baselineId, currentId]);

  const baseline: NativeCaptureRecord | undefined = useMemo(
    () => viewSessions.find((s) => s.capture.sessionId === baselineId)?.capture,
    [viewSessions, baselineId]
  );
  const current: NativeCaptureRecord | undefined = useMemo(
    () => viewSessions.find((s) => s.capture.sessionId === currentId)?.capture,
    [viewSessions, currentId]
  );

  const alignment = useMemo(() => {
    if (!baseline || !current) return null;
    return computePairAlignmentTransform(baseline, current);
  }, [baseline, current]);

  const comparison = useMemo(() => {
    if (!baseline || !current) return null;
    return evaluateComparability(baseline, current);
  }, [baseline, current]);

  const timelineGroups = useMemo(() => {
    const map = new Map<string, SessionEnvelope[]>();
    for (const item of sessions) {
      const day = formatDayKey(item.capture.capturedAtIso);
      const list = map.get(day) ?? [];
      list.push(item);
      map.set(day, list);
    }
    return Array.from(map.entries());
  }, [sessions]);

  const baseSrc = resolvePreviewSrc(baseline?.rgbFileUri);
  const currSrc = resolvePreviewSrc(current?.rgbFileUri);

  const currentTransform =
    autoAlign && alignment && alignment.mode !== 'unaligned'
      ? alignment.currentCssTransform
      : 'none';
  const currentOrigin =
    autoAlign && alignment ? alignment.transformOrigin : '50% 50%';

  return (
    <div className="compare-stack">
      <section className="card">
        <h2>Aligned Before / After Comparison</h2>
        <div className="pill-row">
          {(['front', 'left_cheek', 'right_cheek'] as CaptureView[]).map(
            (v) => {
              const count = sessions.filter((s) => s.capture.view === v).length;
              return (
                <button
                  key={v}
                  type="button"
                  className={selectedView === v ? 'primary' : ''}
                  onClick={() => setSelectedView(v)}
                >
                  {v.replace('_', ' ')} ({count})
                </button>
              );
            }
          )}
        </div>

        {viewSessions.length < 2 ? (
          <p className="subtitle" style={{ marginTop: 12 }}>
            Capture at least 2 <strong>{selectedView.replace('_', ' ')}</strong>{' '}
            sessions to compare side-by-side or with the split slider.
          </p>
        ) : (
          <>
            <div className="field-grid" style={{ marginTop: 12 }}>
              <label>
                Baseline (Before)
                <select
                  value={baselineId}
                  onChange={(e) => setBaselineId(e.target.value)}
                >
                  {viewSessions.map(({ capture }) => (
                    <option key={capture.sessionId} value={capture.sessionId}>
                      {formatShortTime(capture.capturedAtIso)} ·{' '}
                      {capture.sessionId.slice(0, 6)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Current (After)
                <select
                  value={currentId}
                  onChange={(e) => setCurrentId(e.target.value)}
                >
                  {viewSessions.map(({ capture }) => (
                    <option key={capture.sessionId} value={capture.sessionId}>
                      {formatShortTime(capture.capturedAtIso)} ·{' '}
                      {capture.sessionId.slice(0, 6)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {comparison && (
              <div
                className={`gate-box ${
                  comparison.comparabilityState === 'comparable'
                    ? 'ok'
                    : comparison.comparabilityState === 'not_comparable'
                      ? 'danger'
                      : 'warn'
                }`}
              >
                <div className="badge-row">
                  <span
                    className={`badge ${
                      comparison.comparabilityState === 'comparable'
                        ? 'ok'
                        : comparison.comparabilityState === 'not_comparable'
                          ? 'danger'
                          : 'warn'
                    }`}
                  >
                    Comparability: {comparison.comparabilityState}
                  </span>
                  <span className="badge">
                    Alignment: {comparison.alignmentMode}
                  </span>
                  <span className="badge">
                    Change Verdict: {comparison.analysisStatus} (M2)
                  </span>
                </div>

                <ul className="note-list">
                  {comparison.reasons.map((r, i) => (
                    <li key={`r-${i}`}>{r}</li>
                  ))}
                  {comparison.cautions.map((c, i) => (
                    <li key={`c-${i}`}>Caution: {c}</li>
                  ))}
                </ul>

                <div className="kv-grid">
                  <div className="kv-item">
                    <div className="kv-label">Δ Distance</div>
                    <div className="kv-value">
                      {comparison.deltas.distanceDeltaCm !== undefined
                        ? `${comparison.deltas.distanceDeltaCm >= 0 ? '+' : ''}${comparison.deltas.distanceDeltaCm.toFixed(2)} cm`
                        : '—'}
                    </div>
                  </div>
                  <div className="kv-item">
                    <div className="kv-label">Δ Exposure (EV)</div>
                    <div className="kv-value">
                      {comparison.deltas.exposureEvDelta !== undefined
                        ? `${comparison.deltas.exposureEvDelta >= 0 ? '+' : ''}${comparison.deltas.exposureEvDelta.toFixed(2)} stops`
                        : '—'}
                    </div>
                  </div>
                  <div className="kv-item">
                    <div className="kv-label">Δ Scale</div>
                    <div className="kv-value">
                      {comparison.deltas.scaleDeltaPct !== undefined
                        ? `${comparison.deltas.scaleDeltaPct >= 0 ? '+' : ''}${comparison.deltas.scaleDeltaPct.toFixed(1)}%`
                        : '—'}
                    </div>
                  </div>
                  <div className="kv-item">
                    <div className="kv-label">Δ Yaw / Roll</div>
                    <div className="kv-value">
                      {comparison.deltas.yawDeltaDeg !== undefined
                        ? `${comparison.deltas.yawDeltaDeg.toFixed(0)}°`
                        : '—'}{' '}
                      /{' '}
                      {comparison.deltas.rollDeltaDeg !== undefined
                        ? `${comparison.deltas.rollDeltaDeg.toFixed(0)}°`
                        : '—'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="controls">
              <button
                type="button"
                className={viewerMode === 'slider' ? 'primary' : ''}
                onClick={() => setViewerMode('slider')}
              >
                Split Slider
              </button>
              <button
                type="button"
                className={viewerMode === 'side_by_side' ? 'primary' : ''}
                onClick={() => setViewerMode('side_by_side')}
              >
                Side-by-Side
              </button>
              <button
                type="button"
                onClick={() => setAutoAlign((v) => !v)}
                disabled={!alignment || alignment.mode === 'unaligned'}
              >
                Auto-Align: {autoAlign && alignment?.mode !== 'unaligned' ? 'On' : 'Off'}
              </button>
              <button type="button" onClick={() => setShowRois((v) => !v)}>
                ROIs: {showRois ? 'On' : 'Off'}
              </button>
              <select
                aria-label="Zoom level"
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
              >
                <option value={1}>Zoom 1×</option>
                <option value={1.5}>Zoom 1.5×</option>
                <option value={2}>Zoom 2×</option>
                <option value={3}>Zoom 3×</option>
              </select>
            </div>

            {alignment && (
              <p className="subtitle" style={{ marginTop: 8 }}>
                {alignment.summary}
              </p>
            )}

            {baseSrc && currSrc ? (
              viewerMode === 'slider' ? (
                <div className="compare-stage-wrap">
                  <div className="compare-stage">
                    <div
                      className="compare-zoom-layer"
                      style={{ transform: `scale(${zoom})` }}
                    >
                      <img
                        className="compare-img"
                        src={currSrc}
                        alt="Current after capture"
                        style={{
                          transform: currentTransform,
                          transformOrigin: currentOrigin,
                        }}
                      />
                      <div
                        className="compare-clip-left"
                        style={{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }}
                      >
                        <img
                          className="compare-img"
                          src={baseSrc}
                          alt="Baseline before capture"
                        />
                      </div>
                      {showRois && (
                        <div className="roi-overlay">
                          {renderRegionBoxes(baseline?.facialAlignment?.regions)}
                        </div>
                      )}
                    </div>
                    <div
                      className="split-divider"
                      style={{ left: `${splitPct}%` }}
                    />
                    <span className="stage-tag left">Before</span>
                    <span className="stage-tag right">After</span>
                  </div>
                  <input
                    className="split-slider"
                    type="range"
                    min={0}
                    max={100}
                    value={splitPct}
                    aria-label="Before and after split position"
                    onChange={(e) => setSplitPct(Number(e.target.value))}
                  />
                </div>
              ) : (
                <div className="side-by-side-grid">
                  <div className="compare-stage">
                    <div
                      className="compare-zoom-layer"
                      style={{ transform: `scale(${zoom})` }}
                    >
                      <img
                        className="compare-img"
                        src={baseSrc}
                        alt="Baseline before capture"
                      />
                      {showRois && (
                        <div className="roi-overlay">
                          {renderRegionBoxes(baseline?.facialAlignment?.regions)}
                        </div>
                      )}
                    </div>
                    <span className="stage-tag left">Before</span>
                  </div>
                  <div className="compare-stage">
                    <div
                      className="compare-zoom-layer"
                      style={{ transform: `scale(${zoom})` }}
                    >
                      <img
                        className="compare-img"
                        src={currSrc}
                        alt="Current after capture"
                        style={{
                          transform: currentTransform,
                          transformOrigin: currentOrigin,
                        }}
                      />
                      {showRois && (
                        <div className="roi-overlay">
                          {renderRegionBoxes(current?.facialAlignment?.regions)}
                        </div>
                      )}
                    </div>
                    <span className="stage-tag right">After</span>
                  </div>
                </div>
              )
            ) : (
              <p className="subtitle" style={{ marginTop: 12 }}>
                Image previews are unavailable for one of the selected sessions
                (web fallback sessions drop image data after reload to avoid
                localStorage quota).
              </p>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2>Progress Timeline ({timelineGroups.length} days)</h2>
        {timelineGroups.length === 0 ? (
          <p className="subtitle">No local check-ins recorded yet.</p>
        ) : (
          <div className="timeline-list">
            {timelineGroups.map(([day, items]) => (
              <div key={day} className="timeline-day">
                <div className="timeline-day-header">
                  <strong>{day}</strong>
                  <span className="subtitle">{items.length} capture(s)</span>
                </div>
                <div className="timeline-thumbs">
                  {items.map(({ capture, quality }) => {
                    const thumb = resolvePreviewSrc(capture.rgbFileUri);
                    return (
                      <div key={capture.sessionId} className="timeline-card">
                        {thumb ? (
                          <img
                            className="timeline-thumb"
                            src={thumb}
                            alt={`${capture.view} capture`}
                          />
                        ) : (
                          <div className="timeline-thumb placeholder">
                            No preview
                          </div>
                        )}
                        <div className="timeline-meta">
                          <span>{capture.view.replace('_', ' ')}</span>
                          <span className="subtitle">
                            {formatShortTime(capture.capturedAtIso)} ·{' '}
                            {quality.acceptanceState}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
