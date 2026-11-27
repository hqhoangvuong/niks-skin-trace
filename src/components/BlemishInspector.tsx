import { useMemo, useState, type MouseEvent } from 'react';
import type {
  BlemishAnalysisRecord,
  CandidateLesion,
  ColorimetryAnalysisRecord,
  FacialRegionId,
  LesionCategory,
} from '@skin-trace/truedepth-camera';
import {
  assignLesionToRegion,
  buildManualAnalysisRecord,
  isActiveBlemishCategory,
  summarizeRegionMetrics,
} from '../services/blemishMetrics';
import { cameraBridge, resolvePreviewSrc } from '../services/cameraBridge';
import type { SessionEnvelope } from '../types/domain';

interface BlemishInspectorProps {
  session: SessionEnvelope;
  onAnalysisSaved: (sessionId: string, analysis: BlemishAnalysisRecord) => void;
  onColorimetrySaved: (
    sessionId: string,
    colorimetry: ColorimetryAnalysisRecord
  ) => void;
  onClose: () => void;
}

const CATEGORY_OPTIONS: Array<{ value: LesionCategory; label: string }> = [
  { value: 'papule_pustule', label: 'Active: Papule / Pustule' },
  { value: 'comedone', label: 'Active: Comedone (Whitehead/Blackhead)' },
  { value: 'nodule_cyst', label: 'Active: Nodule / Cyst' },
  { value: 'active_blemish_unspecified', label: 'Active: Blemish (General)' },
  { value: 'residual_red_mark_pie', label: 'Residual: Red Mark (PIE)' },
  { value: 'residual_dark_spot_pih', label: 'Residual: Dark Spot (PIH)' },
];

const REGION_LABELS: Record<FacialRegionId, string> = {
  forehead: 'Forehead',
  anatomicalLeftCheek: 'Left Cheek (Anatomical)',
  anatomicalRightCheek: 'Right Cheek (Anatomical)',
  chin: 'Chin',
  other: 'Other / Outside ROI',
};

function createPinId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pin-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function BlemishInspector({
  session,
  onAnalysisSaved,
  onColorimetrySaved,
  onClose,
}: BlemishInspectorProps) {
  const { capture } = session;
  const existing = capture.blemishAnalysis;

  const [analysis, setAnalysis] = useState<BlemishAnalysisRecord | undefined>(
    existing
  );
  const [colorimetry, setColorimetry] = useState<
    ColorimetryAnalysisRecord | undefined
  >(capture.colorimetryAnalysis);
  const [lesions, setLesions] = useState<CandidateLesion[]>(
    existing?.lesions ?? []
  );
  const [mode, setMode] = useState<'pin' | 'inspect'>('pin');
  const [selectedCategory, setSelectedCategory] =
    useState<LesionCategory>('papule_pustule');
  const [selectedLesionId, setSelectedLesionId] = useState<string | null>(null);
  const [showRois, setShowRois] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const previewSrc = resolvePreviewSrc(capture.rgbFileUri);
  const regions = capture.facialAlignment?.regions;

  const regionSummaries = useMemo(
    () => summarizeRegionMetrics(lesions, capture),
    [lesions, capture]
  );

  const selectedLesion = useMemo(
    () => lesions.find((l) => l.id === selectedLesionId) ?? null,
    [lesions, selectedLesionId]
  );

  async function persistLesions(
    nextLesions: CandidateLesion[],
    preserveExistingModelMeta = false
  ): Promise<boolean> {
    setBusy('save');
    setStatusMsg(null);
    try {
      const keepModelMeta =
        preserveExistingModelMeta &&
        analysis &&
        analysis.state === 'measured' &&
        analysis.source !== 'manual_annotation';

      const nextRecord: BlemishAnalysisRecord = keepModelMeta
        ? {
            ...analysis,
            analyzedAtIso: new Date().toISOString(),
            lesions: nextLesions,
            regions: summarizeRegionMetrics(nextLesions, capture),
            warnings: analysis.warnings.includes(
              'Includes manual pin verification/edits on top of model detections.'
            )
              ? analysis.warnings
              : [
                  ...analysis.warnings,
                  'Includes manual pin verification/edits on top of model detections.',
                ],
          }
        : buildManualAnalysisRecord(capture.sessionId, nextLesions, capture);

      const saved = await cameraBridge.saveSessionAnalysis(
        capture.sessionId,
        nextRecord
      );
      if (!saved) {
        setStatusMsg(
          'Failed to persist analysis locally (session storage unavailable).'
        );
        return false;
      }
      setLesions(nextLesions);
      setAnalysis(nextRecord);
      onAnalysisSaved(capture.sessionId, nextRecord);
      return true;
    } catch (err) {
      setStatusMsg(
        err instanceof Error ? err.message : 'Failed to persist local analysis.'
      );
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function handleImageClick(e: MouseEvent<HTMLDivElement>) {
    if (mode !== 'pin' || busy !== null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));

    const boxW = 0.018;
    const boxH = 0.014;
    const region = assignLesionToRegion({ x, y }, regions);

    const newLesion: CandidateLesion = {
      id: createPinId(),
      region,
      category: selectedCategory,
      centerNormalized: { x, y },
      bboxNormalized: {
        x: Math.min(1 - boxW, Math.max(0, x - boxW / 2)),
        y: Math.min(1 - boxH, Math.max(0, y - boxH / 2)),
        width: boxW,
        height: boxH,
      },
      confidence: null,
      uncertaintyState: 'user_verified',
      source: 'manual_annotation',
    };

    const nextLesions = [...lesions, newLesion];
    // Preserve model provenance if annotating atop model detections so comparability gate cannot be bypassed.
    const preserveModel = analysis?.source !== 'manual_annotation';
    const saved = await persistLesions(nextLesions, preserveModel);
    if (saved) {
      setSelectedLesionId(newLesion.id);
    }
  }

  async function handleUpdateUncertainty(
    id: string,
    uncertaintyState: CandidateLesion['uncertaintyState']
  ) {
    const nextLesions = lesions.map((l) =>
      l.id === id ? { ...l, uncertaintyState } : l
    );
    await persistLesions(nextLesions, analysis?.source !== 'manual_annotation');
  }

  async function handleDeleteLesion(id: string) {
    const nextLesions = lesions.filter((l) => l.id !== id);
    const saved = await persistLesions(
      nextLesions,
      analysis?.source !== 'manual_annotation'
    );
    if (saved && selectedLesionId === id) {
      setSelectedLesionId(null);
    }
  }

  async function handleMarkClearZero() {
    const saved = await persistLesions([], false);
    if (saved) {
      setSelectedLesionId(null);
      setStatusMsg(
        'Saved measured manual annotation with 0 blemishes (distinct from not_analyzed).'
      );
    }
  }

  async function handleRunCoreML() {
    setBusy('coreml');
    setStatusMsg(null);
    try {
      const result = await cameraBridge.runCoreMLBlemishAnalysis({
        sessionId: capture.sessionId,
      });
      if (result.state === 'unavailable') {
        setStatusMsg(
          result.unavailableReason ??
            'Core ML model is unavailable on this device.'
        );
        return;
      }
      setAnalysis(result);
      setLesions(result.lesions);
      onAnalysisSaved(capture.sessionId, result);
      setStatusMsg(
        `Core ML completed in ${result.computationTimeMs} ms (${result.lesions.length} candidate detections).`
      );
    } catch (err) {
      setStatusMsg(
        err instanceof Error ? err.message : 'Core ML analysis failed.'
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleRunColorimetry() {
    setBusy('colorimetry');
    setStatusMsg(null);
    try {
      const result = await cameraBridge.runColorimetryAnalysis(
        capture.sessionId
      );
      if (result.state === 'unavailable') {
        setStatusMsg(
          result.unavailableReason ??
            'Redness & Spots (CIELAB) analysis is unavailable for this session.'
        );
        return;
      }
      setColorimetry(result);
      onColorimetrySaved(capture.sessionId, result);
      setStatusMsg(
        `Redness & Spots (CIELAB) completed in ${result.computationTimeMs} ms.`
      );
    } catch (err) {
      setStatusMsg(
        err instanceof Error ? err.message : 'Colorimetry analysis failed.'
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleCopyAnalysisJson() {
    const payload =
      analysis ?? {
        sessionId: capture.sessionId,
        state: 'not_analyzed',
        note: 'No blemish annotation or model inference has been recorded for this session.',
      };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
    } catch {
      setStatusMsg('Clipboard copy unavailable in this environment.');
    }
  }

  return (
    <section className="card">
      <div className="header-row">
        <div>
          <h2>Blemish Inspector &amp; Annotation</h2>
          <p className="subtitle">
            Session {capture.sessionId.slice(0, 8)} · {capture.view} ·{' '}
            {capture.capturedAtIso}
          </p>
        </div>
        <button type="button" onClick={onClose}>
          Back to Sessions
        </button>
      </div>

      <div className="badge-row" style={{ marginTop: 10 }}>
        <span
          className={`badge ${analysis?.state === 'measured' ? 'ok' : 'warn'}`}
        >
          State: {analysis?.state ?? 'not_analyzed'}
        </span>
        {analysis && (
          <>
            <span className="badge">Source: {analysis.source}</span>
            <span className="badge">License: {analysis.licenseScope}</span>
            {analysis.modelVersion && (
              <span className="badge">Version: {analysis.modelVersion}</span>
            )}
          </>
        )}
      </div>

      {analysis && analysis.licenseScope === 'non_commercial_research_only' && (
        <div className="research-banner" role="note">
          RESEARCH MODEL — NOT CLINICALLY VALIDATED OR COMMERCIALLY CLEARED.
          Inspect every detection manually.
        </div>
      )}

      {statusMsg && (
        <div className="gate-box warn" role="status">
          {statusMsg}
        </div>
      )}

      <div className="controls">
        <button
          type="button"
          className={mode === 'pin' ? 'primary' : ''}
          onClick={() => setMode('pin')}
        >
          Tap-to-Pin Mode
        </button>
        <button
          type="button"
          className={mode === 'inspect' ? 'primary' : ''}
          onClick={() => setMode('inspect')}
        >
          Inspect Pins ({lesions.length})
        </button>
        <button type="button" onClick={() => setShowRois((v) => !v)}>
          ROIs: {showRois ? 'On' : 'Off'}
        </button>
        <button
          type="button"
          onClick={handleRunCoreML}
          disabled={busy !== null}
        >
          {busy === 'coreml' ? 'Running Core ML…' : 'Run On-Device Core ML'}
        </button>
        <button
          type="button"
          onClick={handleRunColorimetry}
          disabled={busy !== null}
        >
          {busy === 'colorimetry'
            ? 'Analyzing Color…'
            : 'Run Redness & Spots (CIELAB)'}
        </button>
        <button
          type="button"
          onClick={handleMarkClearZero}
          disabled={busy !== null}
        >
          Record Verified 0
        </button>
        <button type="button" onClick={handleCopyAnalysisJson}>
          {copied ? 'Copied JSON' : 'Copy Analysis JSON'}
        </button>
      </div>

      {mode === 'pin' && (
        <div className="field-grid" style={{ marginTop: 12 }}>
          <label>
            Category to Pin (active blemishes kept separate from residual marks)
            <select
              value={selectedCategory}
              onChange={(e) =>
                setSelectedCategory(e.target.value as LesionCategory)
              }
            >
              {CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {previewSrc ? (
        <div className="inspector-canvas-wrap">
          <div
            className={`inspector-canvas ${mode === 'pin' ? 'pin-cursor' : ''}`}
            onClick={handleImageClick}
          >
            <img
              className="inspector-img"
              src={previewSrc}
              alt={`Inspectable ${capture.view} photo`}
            />

            {showRois && regions && (
              <div className="roi-overlay">
                {(
                  [
                    ['forehead', 'Forehead'],
                    ['anatomicalLeftCheek', 'L Cheek'],
                    ['anatomicalRightCheek', 'R Cheek'],
                    ['chin', 'Chin'],
                  ] as const
                ).map(([key, label]) => {
                  const r = regions[key];
                  if (!r) return null;
                  return (
                    <div
                      key={key}
                      className="roi-box"
                      style={{
                        left: `${r.x * 100}%`,
                        top: `${r.y * 100}%`,
                        width: `${r.width * 100}%`,
                        height: `${r.height * 100}%`,
                      }}
                    >
                      <span className="roi-label">{label}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {lesions.map((l) => {
              const active = isActiveBlemishCategory(l.category);
              const classes = [
                'lesion-pin',
                active ? 'active' : 'residual',
                l.uncertaintyState === 'uncertain' ? 'uncertain' : '',
                l.uncertaintyState === 'user_rejected' ? 'rejected' : '',
                selectedLesionId === l.id ? 'selected' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={l.id}
                  type="button"
                  className={classes}
                  title={`${l.category} (${l.region})`}
                  style={{
                    left: `${l.centerNormalized.x * 100}%`,
                    top: `${l.centerNormalized.y * 100}%`,
                  }}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setSelectedLesionId(l.id);
                    setMode('inspect');
                  }}
                />
              );
            })}
          </div>
          <p className="subtitle" style={{ marginTop: 6 }}>
            {mode === 'pin'
              ? 'Tap directly on the photo to place a pin. Active blemishes = red, residual PIE/PIH marks = amber, uncertain = dashed.'
              : 'Tap any marker to verify, dismiss, or delete it.'}
          </p>
        </div>
      ) : (
        <p className="subtitle" style={{ marginTop: 12 }}>
          Original image preview unavailable for this session.
        </p>
      )}

      {selectedLesion && (
        <div className="gate-box" style={{ marginTop: 12 }}>
          <div className="badge-row">
            <span className="badge">{selectedLesion.category}</span>
            <span className="badge">{REGION_LABELS[selectedLesion.region]}</span>
            <span className="badge">{selectedLesion.uncertaintyState}</span>
            {selectedLesion.confidence !== null && (
              <span className="badge">
                Conf: {(selectedLesion.confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <div className="controls">
            <button
              type="button"
              className="primary"
              disabled={busy !== null}
              onClick={() =>
                handleUpdateUncertainty(selectedLesion.id, 'user_verified')
              }
            >
              Verify
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                handleUpdateUncertainty(selectedLesion.id, 'user_rejected')
              }
            >
              Dismiss (Exclude)
            </button>
            <button
              type="button"
              className="danger-btn"
              disabled={busy !== null}
              onClick={() => handleDeleteLesion(selectedLesion.id)}
            >
              Delete Pin
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <h2>Per-Region Blemish Summary</h2>
        {analysis?.state !== 'measured' ? (
          <p className="subtitle">
            Not analyzed yet — place pins, tap <strong>Record Verified 0</strong>,
            or run a bundled Core ML model to produce measured region counts.
          </p>
        ) : (
          <table className="region-table">
            <thead>
              <tr>
                <th>Region</th>
                <th>Active</th>
                <th>Residual</th>
                <th>Uncertain</th>
                <th>Area</th>
              </tr>
            </thead>
            <tbody>
              {regionSummaries.map((row) => (
                <tr key={row.region}>
                  <td>{REGION_LABELS[row.region]}</td>
                  <td>{row.activeBlemishCount}</td>
                  <td>{row.residualMarkCount}</td>
                  <td>{row.uncertainCount}</td>
                  <td>
                    {row.affectedAreaMm2 !== null
                      ? `${row.affectedAreaMm2.toFixed(1)} mm²`
                      : `${(row.affectedAreaNormalized * 100).toFixed(2)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        <h2>Redness &amp; Dark-Spot Appearance (CIELAB)</h2>
        {colorimetry?.state !== 'measured' ? (
          <p className="subtitle">
            Not analyzed yet — tap{' '}
            <strong>Run Redness &amp; Spots (CIELAB)</strong> to compute
            deterministic sRGB optical proxies per facial ROI.
          </p>
        ) : (
          <>
            <table className="region-table">
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Valid Skin</th>
                  <th>Redness (a* / EI)</th>
                  <th>Patchy Red</th>
                  <th>Dark Spots (ΔL*)</th>
                </tr>
              </thead>
              <tbody>
                {(colorimetry.regions ?? []).map((row) => (
                  <tr key={row.region}>
                    <td>{REGION_LABELS[row.region]}</td>
                    <td>{(row.validSkinPixelRatio * 100).toFixed(0)}%</td>
                    {row.state === 'measured' ? (
                      <>
                        <td>
                          {row.meanAStar !== null
                            ? row.meanAStar.toFixed(1)
                            : '—'}{' '}
                          /{' '}
                          {row.erythemaIndex !== null
                            ? row.erythemaIndex.toFixed(1)
                            : '—'}
                        </td>
                        <td>
                          {row.elevatedRednessAreaFraction !== null
                            ? `${(row.elevatedRednessAreaFraction * 100).toFixed(1)}%`
                            : '—'}
                        </td>
                        <td>
                          {row.darkSpotContrastAreaFraction !== null
                            ? `${(row.darkSpotContrastAreaFraction * 100).toFixed(1)}%`
                            : '—'}
                          {row.darkSpotContrastDeltaL !== null &&
                          row.darkSpotContrastDeltaL > 0
                            ? ` (${row.darkSpotContrastDeltaL.toFixed(1)} L*)`
                            : ''}
                        </td>
                      </>
                    ) : (
                      <td colSpan={3}>
                        Unavailable ({row.unavailableReason ?? 'low valid skin'})
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="subtitle" style={{ marginTop: 6 }}>
              Optical appearance proxies computed on sRGB skin pixels (glare &amp;
              deep shadow excluded) — not physiological melanin concentration or
              clinical severity.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
