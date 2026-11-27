import { useEffect, useMemo, useState } from 'react';
import type {
  BlemishAnalysisRecord,
  CaptureView,
  ColorimetryAnalysisRecord,
  ExperimentVariant,
} from '@skin-trace/truedepth-camera';
import { cameraBridge } from '../services/cameraBridge';
import { COLORIMETRY_ALGORITHM_VERSION } from '../services/colorimetryMetrics';
import {
  buildLongitudinalTrendSummary,
  buildM4ValidationReportMarkdown,
  evaluateValidationCohort,
  type RefusalReasonBucket,
  type TrueDepthDecisionVerdict,
} from '../services/validationMetrics';
import type { SessionEnvelope } from '../types/domain';

interface ValidationLabProps {
  sessions: SessionEnvelope[];
  onAnalysisSaved: (sessionId: string, record: BlemishAnalysisRecord) => void;
  onColorimetrySaved: (
    sessionId: string,
    record: ColorimetryAnalysisRecord
  ) => void;
}

type DateScope = 'today' | 'all' | 'custom';

const VARIANT_LABELS: Record<ExperimentVariant, string> = {
  rgb_unguided: 'Variant A: RGB Unguided',
  rgb_guided: 'Variant B: RGB Guided',
  rgb_depth_guided: 'Variant C: RGB + TrueDepth',
};

const VERDICT_META: Record<
  TrueDepthDecisionVerdict,
  { label: string; tone: 'ok' | 'warn' | 'danger' | '' }
> = {
  insufficient_data: {
    label: 'Insufficient Data (Pilot Incomplete)',
    tone: 'warn',
  },
  truedepth_demonstrated_benefit: {
    label: 'TrueDepth Demonstrated Measurable Benefit',
    tone: 'ok',
  },
  guidance_sufficient_depth_optional: {
    label: '2D Guidance Sufficient — Keep TrueDepth Optional',
    tone: 'ok',
  },
  thresholds_not_met: {
    label: 'Provisional Pilot Thresholds Not Yet Met',
    tone: 'danger',
  },
};

const REFUSAL_LABELS: Record<RefusalReasonBucket, string> = {
  view_mismatch: 'View mismatch',
  mode_mismatch: 'Mode mismatch',
  device_mismatch: 'Device mismatch',
  distance_shift: 'Distance shift',
  yaw_shift: 'Head yaw shift',
  exposure_ev_shift: 'Exposure EV shift',
  white_balance_shift: 'White-balance shift',
  missing_metadata: 'Missing metadata',
  version_mismatch: 'Version drift',
  other: 'Other',
};

function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtPct(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function fmtNum(val: number | null, suffix = '', decimals = 2): string {
  return val === null ? '—' : `${val.toFixed(decimals)}${suffix}`;
}

export function ValidationLab({
  sessions,
  onAnalysisSaved,
  onColorimetrySaved,
}: ValidationLabProps) {
  const [selectedView, setSelectedView] = useState<CaptureView>('front');
  const [dateScope, setDateScope] = useState<DateScope>('all');
  const [excludedIds, setExcludedIds] = useState<Record<string, boolean>>({});
  const [batchProgress, setBatchProgress] = useState<string | null>(null);
  const [batchErrors, setBatchErrors] = useState<string[]>([]);
  const [copiedMode, setCopiedMode] = useState<'md' | 'json' | null>(null);

  const availableDevices = useMemo(
    () =>
      Array.from(new Set(sessions.map((s) => s.capture.deviceModel))).sort(),
    [sessions]
  );

  const [selectedDevice, setSelectedDevice] = useState<string>(
    availableDevices[0] ?? ''
  );

  useEffect(() => {
    if (
      availableDevices.length > 0 &&
      !availableDevices.includes(selectedDevice)
    ) {
      setSelectedDevice(availableDevices[0]);
    }
  }, [availableDevices, selectedDevice]);

  const todayKey = localDayKey(new Date().toISOString());

  const candidateSessions = useMemo(() => {
    return sessions
      .filter((s) => s.capture.view === selectedView)
      .filter((s) =>
        selectedDevice ? s.capture.deviceModel === selectedDevice : true
      )
      .filter((s) =>
        dateScope === 'today'
          ? localDayKey(s.capture.capturedAtIso) === todayKey
          : true
      );
  }, [sessions, selectedView, selectedDevice, dateScope, todayKey]);

  const cohortSessions = useMemo(() => {
    const active =
      dateScope === 'custom'
        ? candidateSessions.filter((s) => !excludedIds[s.capture.sessionId])
        : candidateSessions;
    return active.map((s) => s.capture);
  }, [candidateSessions, dateScope, excludedIds]);

  const evaluation = useMemo(
    () => evaluateValidationCohort(cohortSessions),
    [cohortSessions]
  );

  // Longitudinal trend spans all sessions matching selected device & view across calendar days.
  const longitudinalPool = useMemo(
    () =>
      sessions
        .filter((s) => s.capture.view === selectedView)
        .filter((s) =>
          selectedDevice ? s.capture.deviceModel === selectedDevice : true
        )
        .map((s) => s.capture),
    [sessions, selectedView, selectedDevice]
  );

  const trend = useMemo(
    () =>
      buildLongitudinalTrendSummary(longitudinalPool, {
        view: selectedView,
        deviceModel: selectedDevice || undefined,
      }),
    [longitudinalPool, selectedView, selectedDevice]
  );

  const reportMarkdown = useMemo(
    () =>
      buildM4ValidationReportMarkdown(evaluation, trend, {
        targetHardwareModel: 'iPhone 16 Pro',
      }),
    [evaluation, trend]
  );

  const pendingAnalysisCount = useMemo(() => {
    return cohortSessions.filter((c) => {
      const needsBlemish = c.blemishAnalysis?.state !== 'measured';
      const needsColor =
        c.colorimetryAnalysis?.state !== 'measured' ||
        c.colorimetryAnalysis?.algorithmVersion !==
          COLORIMETRY_ALGORITHM_VERSION;
      return needsBlemish || needsColor;
    }).length;
  }, [cohortSessions]);

  async function handleBatchAnalyze() {
    if (batchProgress !== null || cohortSessions.length === 0) return;
    setBatchErrors([]);
    setCopiedMode(null);
    const errors: string[] = [];

    for (let idx = 0; idx < cohortSessions.length; idx++) {
      const cap = cohortSessions[idx];
      const needsBlemish = cap.blemishAnalysis?.state !== 'measured';
      const needsColor =
        cap.colorimetryAnalysis?.state !== 'measured' ||
        cap.colorimetryAnalysis?.algorithmVersion !==
          COLORIMETRY_ALGORITHM_VERSION;

      if (!needsBlemish && !needsColor) continue;

      setBatchProgress(
        `Analyzing ${idx + 1} / ${cohortSessions.length} (${cap.requestedVariant})…`
      );

      if (needsBlemish) {
        try {
          const bRes = await cameraBridge.runCoreMLBlemishAnalysis({
            sessionId: cap.sessionId,
          });
          onAnalysisSaved(cap.sessionId, bRes);
        } catch (err) {
          errors.push(
            `${cap.sessionId.slice(0, 8)} blemish failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }

      if (needsColor) {
        try {
          const cRes = await cameraBridge.runColorimetryAnalysis(cap.sessionId);
          onColorimetrySaved(cap.sessionId, cRes);
        } catch (err) {
          errors.push(
            `${cap.sessionId.slice(0, 8)} colorimetry failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }

    setBatchErrors(errors);
    setBatchProgress(null);
  }

  async function handleCopyReport(mode: 'md' | 'json') {
    try {
      const payload =
        mode === 'md'
          ? reportMarkdown
          : JSON.stringify(
              {
                evaluation,
                longitudinalTrend: trend,
              },
              null,
              2
            );
      await navigator.clipboard.writeText(payload);
      setCopiedMode(mode);
    } catch {
      setBatchErrors((prev) => [
        ...prev,
        'Clipboard copy unavailable in this environment.',
      ]);
    }
  }

  function toggleSessionIncluded(sessionId: string) {
    setExcludedIds((prev) => ({
      ...prev,
      [sessionId]: !prev[sessionId],
    }));
  }

  const verdictInfo = VERDICT_META[evaluation.verdict];
  const vA = evaluation.variants.rgb_unguided;
  const vB = evaluation.variants.rgb_guided;
  const vC = evaluation.variants.rgb_depth_guided;

  const combinedRefusals = useMemo(() => {
    const totals: Partial<Record<RefusalReasonBucket, number>> = {};
    for (const v of [vA, vB, vC]) {
      for (const [k, count] of Object.entries(v.refusalReasonCounts)) {
        const key = k as RefusalReasonBucket;
        totals[key] = (totals[key] ?? 0) + (count ?? 0);
      }
    }
    return Object.entries(totals).filter(([, count]) => (count ?? 0) > 0) as [
      RefusalReasonBucket,
      number,
    ][];
  }, [vA, vB, vC]);

  return (
    <div className="compare-stack">
      <section className="card">
        <div className="header-row">
          <h2>1. M4 Repeatability Cohort &amp; Batch Analysis</h2>
          <span className="badge">
            Protocol: {evaluation.protocolVersion}
          </span>
        </div>
        <p className="subtitle">
          Compare Variant A (unguided RGB), Variant B (2D guided RGB), and
          Variant C (guided RGB + TrueDepth) on unchanged skin from the same
          device and view. Exclude intentional perturbation shots via Custom
          selection when scoring unchanged-skin repeatability.
        </p>

        <div className="field-grid">
          <label>
            Capture View
            <select
              value={selectedView}
              onChange={(e) => setSelectedView(e.target.value as CaptureView)}
            >
              <option value="front">Front</option>
              <option value="left_cheek">Left Cheek</option>
              <option value="right_cheek">Right Cheek</option>
            </select>
          </label>
          <label>
            Physical Device (Never Mixed)
            <select
              value={selectedDevice}
              onChange={(e) => setSelectedDevice(e.target.value)}
              disabled={availableDevices.length === 0}
            >
              {availableDevices.length === 0 ? (
                <option value="">No captures yet</option>
              ) : (
                availableDevices.map((dev) => (
                  <option key={dev} value={dev}>
                    {dev}
                  </option>
                ))
              )}
            </select>
          </label>
          <label>
            Cohort Scope
            <select
              value={dateScope}
              onChange={(e) => setDateScope(e.target.value as DateScope)}
            >
              <option value="all">
                All dates ({candidateSessions.length} matching)
              </option>
              <option value="today">Today only ({todayKey})</option>
              <option value="custom">Custom shot checkboxes</option>
            </select>
          </label>
        </div>

        <div className="controls">
          <button
            type="button"
            className="primary"
            onClick={handleBatchAnalyze}
            disabled={
              batchProgress !== null ||
              cohortSessions.length === 0 ||
              pendingAnalysisCount === 0
            }
          >
            {batchProgress ??
              (pendingAnalysisCount > 0
                ? `Batch Analyze Cohort (${pendingAnalysisCount} pending)`
                : `All ${cohortSessions.length} Cohort Shots Analyzed (v2)`)}
          </button>
          <button
            type="button"
            onClick={() => handleCopyReport('md')}
            disabled={cohortSessions.length === 0}
          >
            {copiedMode === 'md'
              ? 'Copied Markdown Report'
              : 'Copy M4 Report (Markdown)'}
          </button>
          <button
            type="button"
            onClick={() => handleCopyReport('json')}
            disabled={cohortSessions.length === 0}
          >
            {copiedMode === 'json' ? 'Copied JSON' : 'Copy M4 Report (JSON)'}
          </button>
        </div>

        {batchErrors.length > 0 && (
          <div className="error-box" role="alert">
            <strong>Batch analysis warnings:</strong>
            <ul className="note-list">
              {batchErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        {dateScope === 'custom' && candidateSessions.length > 0 && (
          <div className="cohort-grid">
            {(
              [
                'rgb_unguided',
                'rgb_guided',
                'rgb_depth_guided',
              ] as ExperimentVariant[]
            ).map((variantKey) => {
              const items = candidateSessions.filter(
                (s) => s.capture.requestedVariant === variantKey
              );
              return (
                <div key={variantKey} className="cohort-column">
                  <div className="kv-label">
                    {VARIANT_LABELS[variantKey]} ({items.length})
                  </div>
                  {items.length === 0 ? (
                    <p className="subtitle">No captures</p>
                  ) : (
                    items.map(({ capture, quality }) => {
                      const included = !excludedIds[capture.sessionId];
                      return (
                        <label
                          key={capture.sessionId}
                          className="cohort-check-item"
                        >
                          <input
                            type="checkbox"
                            checked={included}
                            onChange={() =>
                              toggleSessionIncluded(capture.sessionId)
                            }
                          />
                          <span>
                            {formatShortTime(capture.capturedAtIso)} ·{' '}
                            {quality.acceptanceState} ·{' '}
                            {capture.colorimetryAnalysis?.algorithmVersion ??
                              'un-analyzed'}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card">
        <div className="header-row">
          <h2>2. TrueDepth Value Verdict &amp; Release Gates (§7.3–7.4)</h2>
          <span className="badge warn">
            {evaluation.thresholds.thresholdsStatus}
          </span>
        </div>

        <div className={`gate-box ${verdictInfo.tone}`}>
          <strong>Verdict: {verdictInfo.label}</strong>
          <p className="subtitle" style={{ marginTop: 6 }}>
            {evaluation.verdictRationale}
          </p>
          {evaluation.depthVsGuidedComparison.benefitReasons.length > 0 && (
            <ul className="note-list">
              {evaluation.depthVsGuidedComparison.benefitReasons.map(
                (r, idx) => (
                  <li key={idx}>{r}</li>
                )
              )}
            </ul>
          )}
          {evaluation.blockers.length > 0 && (
            <ul className="note-list">
              {evaluation.blockers.map((b, idx) => (
                <li key={idx}>{b}</li>
              ))}
            </ul>
          )}
          {evaluation.warnings.length > 0 && (
            <ul className="note-list">
              {evaluation.warnings.map((w, idx) => (
                <li key={idx}>{w}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table className="region-table">
            <thead>
              <tr>
                <th>Variant</th>
                <th>Release Gate</th>
                <th>Actual</th>
                <th>Provisional Threshold</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {evaluation.gates.map((g) => (
                <tr key={`${g.variant}-${g.id}`}>
                  <td>
                    {g.variant === 'rgb_guided' ? 'Variant B' : 'Variant C'}
                  </td>
                  <td>
                    {g.label}
                    {g.note ? ` (${g.note})` : ''}
                  </td>
                  <td>{g.actualDisplay}</td>
                  <td>{g.thresholdText}</td>
                  <td>
                    <span
                      className={`badge ${
                        g.passed === true
                          ? 'ok'
                          : g.passed === false
                            ? 'danger'
                            : ''
                      }`}
                    >
                      {g.passed === true
                        ? 'PASS'
                        : g.passed === false
                          ? 'FAIL'
                          : 'PENDING'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>3. Variant A vs B vs C Repeatability Matrix (§7.2)</h2>
        <div className="table-scroll">
          <table className="region-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Variant A (Unguided)</th>
                <th>Variant B (2D Guided)</th>
                <th>Variant C (Guided + TrueDepth)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Captures (n) / Pairs</td>
                <td>
                  {vA.sampleCount} ({vA.totalPairs} pairs)
                </td>
                <td>
                  {vB.sampleCount} ({vB.totalPairs} pairs)
                </td>
                <td>
                  {vC.sampleCount} ({vC.totalPairs} pairs)
                </td>
              </tr>
              <tr>
                <td>Live Quality Acceptance Rate</td>
                <td>{fmtPct(vA.qualityAcceptanceRate)}</td>
                <td>{fmtPct(vB.qualityAcceptanceRate)}</td>
                <td>{fmtPct(vC.qualityAcceptanceRate)}</td>
              </tr>
              <tr>
                <td>Framing Scale (Inter-Eye CV%)</td>
                <td>{fmtNum(vA.interEyeDistanceCvPct, '%')}</td>
                <td>{fmtNum(vB.interEyeDistanceCvPct, '%')}</td>
                <td>{fmtNum(vC.interEyeDistanceCvPct, '%')}</td>
              </tr>
              <tr>
                <td>Head Yaw SD / Roll SD</td>
                <td>
                  {fmtNum(vA.yawSdDeg, '°')} / {fmtNum(vA.rollSdDeg, '°')}
                </td>
                <td>
                  {fmtNum(vB.yawSdDeg, '°')} / {fmtNum(vB.rollSdDeg, '°')}
                </td>
                <td>
                  {fmtNum(vC.yawSdDeg, '°')} / {fmtNum(vC.rollSdDeg, '°')}
                </td>
              </tr>
              <tr>
                <td>Pairwise Scale / Shift Median</td>
                <td>
                  {fmtNum(vA.pairwiseScaleSpreadMedianPct, '%', 1)} /{' '}
                  {fmtNum(vA.pairwiseTranslationMedianPct, '%', 1)}
                </td>
                <td>
                  {fmtNum(vB.pairwiseScaleSpreadMedianPct, '%', 1)} /{' '}
                  {fmtNum(vB.pairwiseTranslationMedianPct, '%', 1)}
                </td>
                <td>
                  {fmtNum(vC.pairwiseScaleSpreadMedianPct, '%', 1)} /{' '}
                  {fmtNum(vC.pairwiseTranslationMedianPct, '%', 1)}
                </td>
              </tr>
              <tr>
                <td>TrueDepth Distance SD / Range</td>
                <td>
                  {fmtNum(vA.depthDistanceSdCm, ' cm')} /{' '}
                  {fmtNum(vA.depthDistanceRangeCm, ' cm')}
                </td>
                <td>
                  {fmtNum(vB.depthDistanceSdCm, ' cm')} /{' '}
                  {fmtNum(vB.depthDistanceRangeCm, ' cm')}
                </td>
                <td>
                  {fmtNum(vC.depthDistanceSdCm, ' cm')} /{' '}
                  {fmtNum(vC.depthDistanceRangeCm, ' cm')}
                </td>
              </tr>
              <tr>
                <td>TrueDepth mm/px CV%</td>
                <td>{fmtNum(vA.mmPerPixelCvPct, '%')}</td>
                <td>{fmtNum(vB.mmPerPixelCvPct, '%')}</td>
                <td>{fmtNum(vC.mmPerPixelCvPct, '%')}</td>
              </tr>
              <tr>
                <td>Geometric Comparability Rate</td>
                <td>{fmtPct(vA.geometricComparableRate)}</td>
                <td>{fmtPct(vB.geometricComparableRate)}</td>
                <td>{fmtPct(vC.geometricComparableRate)}</td>
              </tr>
              <tr>
                <td>Color Comparability Rate</td>
                <td>{fmtPct(vA.colorComparableRate)}</td>
                <td>{fmtPct(vB.colorComparableRate)}</td>
                <td>{fmtPct(vC.colorComparableRate)}</td>
              </tr>
              <tr>
                <td>Active Blemish Count SD</td>
                <td>{fmtNum(vA.activeBlemishCountSd)}</td>
                <td>{fmtNum(vB.activeBlemishCountSd)}</td>
                <td>{fmtNum(vC.activeBlemishCountSd)}</td>
              </tr>
              <tr>
                <td>Raw Lesion Area CV%</td>
                <td>{fmtNum(vA.normalizedAreaCvPct, '%')}</td>
                <td>{fmtNum(vB.normalizedAreaCvPct, '%')}</td>
                <td>{fmtNum(vC.normalizedAreaCvPct, '%')}</td>
              </tr>
              <tr>
                <td>Calibrated Lesion Area (mm²) CV%</td>
                <td>{fmtNum(vA.calibratedAreaMm2CvPct, '%')}</td>
                <td>{fmtNum(vB.calibratedAreaMm2CvPct, '%')}</td>
                <td>{fmtNum(vC.calibratedAreaMm2CvPct, '%')}</td>
              </tr>
              <tr>
                <td>Redness False-Change Rate</td>
                <td>{fmtPct(vA.rednessFalseChangeRegionRate)}</td>
                <td>{fmtPct(vB.rednessFalseChangeRegionRate)}</td>
                <td>{fmtPct(vC.rednessFalseChangeRegionRate)}</td>
              </tr>
              <tr>
                <td>Dark-Spot False-Change Rate</td>
                <td>{fmtPct(vA.darkSpotFalseChangeRegionRate)}</td>
                <td>{fmtPct(vB.darkSpotFalseChangeRegionRate)}</td>
                <td>{fmtPct(vC.darkSpotFalseChangeRegionRate)}</td>
              </tr>
              <tr>
                <td>Max |Δa*| / |ΔRed| / |ΔSpot|</td>
                <td>
                  {fmtNum(vA.maxAbsDeltaAStar, '', 2)} /{' '}
                  {fmtNum(vA.maxAbsDeltaRednessAreaPctPts, 'pp', 1)} /{' '}
                  {fmtNum(vA.maxAbsDeltaDarkSpotAreaPctPts, 'pp', 1)}
                </td>
                <td>
                  {fmtNum(vB.maxAbsDeltaAStar, '', 2)} /{' '}
                  {fmtNum(vB.maxAbsDeltaRednessAreaPctPts, 'pp', 1)} /{' '}
                  {fmtNum(vB.maxAbsDeltaDarkSpotAreaPctPts, 'pp', 1)}
                </td>
                <td>
                  {fmtNum(vC.maxAbsDeltaAStar, '', 2)} /{' '}
                  {fmtNum(vC.maxAbsDeltaRednessAreaPctPts, 'pp', 1)} /{' '}
                  {fmtNum(vC.maxAbsDeltaDarkSpotAreaPctPts, 'pp', 1)}
                </td>
              </tr>
              <tr>
                <td>Median Capture / CoreML / Lab (ms)</td>
                <td>
                  {fmtNum(vA.medianCaptureDurationMs, '', 0)} /{' '}
                  {fmtNum(vA.medianBlemishComputeMs, '', 0)} /{' '}
                  {fmtNum(vA.medianColorimetryComputeMs, '', 0)}
                </td>
                <td>
                  {fmtNum(vB.medianCaptureDurationMs, '', 0)} /{' '}
                  {fmtNum(vB.medianBlemishComputeMs, '', 0)} /{' '}
                  {fmtNum(vB.medianColorimetryComputeMs, '', 0)}
                </td>
                <td>
                  {fmtNum(vC.medianCaptureDurationMs, '', 0)} /{' '}
                  {fmtNum(vC.medianBlemishComputeMs, '', 0)} /{' '}
                  {fmtNum(vC.medianColorimetryComputeMs, '', 0)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {combinedRefusals.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="kv-label" style={{ marginBottom: 6 }}>
              Refusal Reason Audit (not_comparable pairs)
            </div>
            <div className="badge-row">
              {combinedRefusals.map(([bucket, count]) => (
                <span key={bucket} className="badge warn">
                  {REFUSAL_LABELS[bucket]}: {count}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>4. Longitudinal Multi-Day Trajectory ({trend.totalDays} days)</h2>
        <p className="subtitle">
          One representative capture per calendar day for{' '}
          <strong>{trend.deviceModel ?? '—'}</strong> ({trend.view ?? '—'}).
          Active blemishes, redness, and dark spots stay strictly separate — no
          composite skin score is calculated.
        </p>

        {trend.points.length === 0 ? (
          <p className="subtitle">No sessions available for this device/view.</p>
        ) : (
          <div className="table-scroll">
            <table className="region-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Variant</th>
                  <th>vs Day 1</th>
                  <th>Active Blemishes</th>
                  <th>Area (mm²)</th>
                  <th>Mean a*</th>
                  <th>Redness %</th>
                  <th>Dark Spot %</th>
                </tr>
              </thead>
              <tbody>
                {trend.points.map((pt) => (
                  <tr key={pt.dayKey}>
                    <td>{pt.dayKey}</td>
                    <td>{pt.variant}</td>
                    <td>
                      <span
                        className={`badge ${
                          pt.comparabilityVsBaseline === 'comparable' ||
                          pt.comparabilityVsBaseline === 'baseline'
                            ? 'ok'
                            : 'danger'
                        }`}
                      >
                        {pt.comparabilityVsBaseline}
                      </span>
                    </td>
                    <td>
                      {pt.totalActiveBlemishes !== null
                        ? pt.totalActiveBlemishes
                        : pt.blemishState}
                    </td>
                    <td>{fmtNum(pt.totalAreaMm2, '', 1)}</td>
                    <td>{fmtNum(pt.meanFaceAStar, '', 2)}</td>
                    <td>{fmtNum(pt.meanRednessAreaPct, '%', 1)}</td>
                    <td>{fmtNum(pt.meanDarkSpotAreaPct, '%', 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer' }}>
            Preview Exportable M4 Markdown Report
          </summary>
          <pre className="json-box">{reportMarkdown}</pre>
        </details>
      </section>
    </div>
  );
}
