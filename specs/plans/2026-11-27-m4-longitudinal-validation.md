# M4 Longitudinal Validation & RGB-vs-Depth Repeatability Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the M4 Variant A/B/C repeatability evaluation engine, clean Variant A unguided-capture isolation, an in-app Validation Lab UI with batch analysis and Markdown/JSON report export, and a physical-device validation protocol to objectively decide whether TrueDepth justifies its complexity over guided RGB alone.

**Architecture:** Strictly separate pure statistical evaluation (`src/services/validationMetrics.ts`, zero React/DOM dependencies) from native capture isolation (`TrueDepthLiveCameraViewController.swift`) and presentation (`src/components/ValidationLab.tsx`). Reuse the exact existing M1 comparability gate (`evaluateComparability`), M2 blemish comparison (`compareBlemishAnalyses`), and M3 colorimetry comparison (`compareColorimetryAnalyses`) so M4 validates the real production pipeline rather than a separate shadow calculation.

**Tech Stack:** TypeScript 5.8, React 19, Vite 6, Capacitor 7, Swift 5.9 / AVFoundation (`plugins/truedepth-camera`), Node 26 built-in `node:test` + `esbuild` (`npm test`).

**Spec:** [docs/skincare-iphone16pro-handoff.md](file:///home/hikari/source/skin-trace/docs/skincare-iphone16pro-handoff.md) (§7.1–7.4, §8, §9) and [AGENTS.md](file:///home/hikari/source/skin-trace/AGENTS.md).

## Global Constraints

- Color photo is primary; TrueDepth is supporting — never fabricate pimple height/volume or build an RGB-D neural network.
- Never fabricate detections, accuracy numbers, composite "skin health" / "beauty" scores, or embedding "% improved".
- Always separate `not_analyzed`, `unavailable`, and `not_comparable` from a measured zero (`0`).
- Use the same analysis model and algorithm versions across Variants A, B, and C; refuse cross-variant comparison on version, device, or view mismatch.
- Keep all facial photos and validation reports strictly local on-device (export only via explicit user copy action).
- Mark numerical release thresholds as `provisional_pilot_thresholds` until calibrated on a held-out set (§7.3).
- Report verification honestly — explicitly distinguish iPhone 12 (`iPhone13,2`) pilot runs from pending iPhone 16 Pro hardware verification.
- On WSL2 Linux, run `npm test`, `npm run typecheck`, and `npx vite build --configLoader runner`; never add npm dependencies (use built-in Node/TS).

## Review Focus

1. **Cross-device or cross-view contamination:** Pooling captures from two different iPhone models (e.g., iPhone 12 + iPhone 16 Pro) or different views (`front` + `left_cheek`) into one repeatability cohort must be blocked (`cohortValid: false`, explicit blocker reason) — pinned in Task 2.
2. **Model or algorithm version drift across variants:** Comparing Variant A analyzed with `cielab-roi-srgb-v1` (or an older Core ML model) against Variant C analyzed with `v2` must mark cross-variant blemish/colorimetry evaluation `not_comparable` instead of crediting/blaming TrueDepth — pinned in Task 2.
3. **Zero-mean, tiny-sample, and missing-metadata math traps:** `n < 2` captures, all-zero lesion areas (`mean === 0`), or missing `depth`/`cameraMetadata` must produce `null` (unavailable) and `'insufficient_data'` — never `NaN`, `Infinity`, or fake `0%` variance — pinned in Task 2.
4. **Conflating refused pairs (`not_comparable`) with `no_clear_change`:** False-change rates must divide strictly by comparable measured region pairs; if 0 pairs are comparable, false-change rate must be `null` and thresholds must fail rather than reporting `0%` false-change — pinned in Task 2.
5. **Guidance leakage into Variant A (`rgb_unguided`):** Opening the live camera in `rgb_unguided` must hide the guide oval, ghost overlay, live readiness colors, and live coaching/metric prompts while still silently recording `liveGuidanceAtShutter` in the background for objective quality-pass scoring — pinned in Task 1.

---

## File Structure

- **Modify:** `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthLiveCameraViewController.swift` — True Variant A (`rgb_unguided`) HUD isolation while preserving silent background `liveGuidanceAtShutter` telemetry.
- **Create:** `src/services/validationMetrics.ts` — Pure M4 Variant A/B/C repeatability statistics, threshold gate evaluator, TrueDepth value verdict, longitudinal multi-day trend builder, and Markdown/JSON report formatter.
- **Create:** `src/services/validationMetrics.test.ts` — Comprehensive unit tests covering all statistical formulas, TrueDepth verdict branches, longitudinal grouping, and all Review Focus edge cases.
- **Create:** `src/components/ValidationLab.tsx` — Dedicated M4 Validation Lab view: cohort filtering & manual shot inclusion, batch Core ML + CIELAB analyzer, A vs B vs C repeatability matrix, threshold checklist, TrueDepth verdict card, refusal audit, longitudinal multi-day trend table, and Markdown/JSON report copy.
- **Modify:** `src/App.tsx` — Add `validation` tab (`Capture Lab` | `Timeline & Compare` | `Validation Lab`) and pass sessions + analysis save callbacks to `ValidationLab`.
- **Modify:** `src/index.css` — Responsive styles for Validation Lab cohort chips, verdict banners, and progress bar (reusing `.table-scroll` for mobile portrait safety).
- **Create:** `specs/m4-validation-protocol.md` — Concrete physical-device test script (5×A / 5×B / 5×C repeatability pilot, controlled perturbation refusal test, 7–14 day longitudinal check-in, and iPhone 16 Pro sign-off).
- **Modify:** `README.md` — Document M4 Validation Lab workflow and updated milestone status.

---

### Task 1: Isolate Variant A (`rgb_unguided`) HUD in Native Live Camera

**Files:**
- Modify: `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthLiveCameraViewController.swift:116-160, 491-529`

**Interfaces:**
- Consumes: `LiveGuidanceConfig.variant` (`"rgb_unguided" | "rgb_guided" | "rgb_depth_guided"`), `LiveGuidanceConfig.requestDepth`
- Produces: Clean unguided viewfinder for `rgb_unguided` (no oval, no ghost, no live metrics, no coaching prompts, no green/yellow ready tint) while continuing to populate `latestGuidanceDict` (`liveGuidanceAtShutter`) silently at shutter.

- [ ] **Step 1: Update `buildUI()` in `TrueDepthLiveCameraViewController.swift`**

When `let isUnguided = (config.variant == "rgb_unguided")`:
- Keep `guideOvalLayer.isHidden = isUnguided` and `ghostToggleButton.isHidden = true`.
- Set `headerLabel.text` for `isUnguided` to `"View: \(config.view) · Variant A (Unguided RGB Baseline)"` (do not display target cm range for `rgb_unguided` or `rgb_guided` when `!config.requestDepth`).
- Hide `metricsLabel.isHidden = isUnguided`.
- Set `messageLabel.text` for `isUnguided` to `"Baseline selfie mode — frame naturally and tap shutter."` with neutral `.white` text color (no yellow/green readiness cue).

- [ ] **Step 2: Update `processLiveFrame(...)` in `TrueDepthLiveCameraViewController.swift`**

Keep `TrueDepthGuidanceEvaluator.evaluate(...)`, `latestGuidanceDict = dict`, and `onGuidanceUpdate(dict)` running silently for all variants (so `liveGuidanceAtShutter` is still logged on Variant A captures for objective quality-acceptance measurement).
Inside `DispatchQueue.main.async`:
- If `self.config.variant == "rgb_unguided"`, return early without updating `metricsLabel`, `messageLabel`, or `guideOvalLayer` color (unless `self.isSessionInterrupted` is true, in which case `handleSessionInterrupted` already shows the interruption warning).
- For `rgb_guided` (`!self.config.requestDepth`), keep existing 2D RGB guidance HUD without any distance/depth wording.
- For `rgb_depth_guided` (`self.config.requestDepth`), keep existing synchronized depth + 2D guidance HUD.

- [ ] **Step 3: Inspect diff and verify Swift syntax manually (Linux cannot run `swiftc`)**

Run: `git diff plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthLiveCameraViewController.swift`
Expected: Clean minimal diff; `latestGuidanceDict` still assigned before `DispatchQueue.main.async`; `isUnguided` guard prevents any coaching text or green/yellow readiness cue from appearing on screen.

- [ ] **Step 4: Commit**

```bash
git add plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthLiveCameraViewController.swift
git commit -m "fix(m4): isolate Variant A unguided camera HUD while preserving silent shutter telemetry"
```

---

### Task 2: Pure M4 Repeatability, TrueDepth Verdict, Longitudinal Trend & Report Engine

**Files:**
- Create: `src/services/validationMetrics.ts`
- Create: `src/services/validationMetrics.test.ts`

**Interfaces:**
- Consumes:
  - `NativeCaptureRecord`, `CaptureView`, `ExperimentVariant`, `FacialRegionId` from `@skin-trace/truedepth-camera`
  - `evaluateComparability` from `./comparison`
  - `computePairAlignmentTransform` from `./alignment`
  - `compareBlemishAnalyses`, `STANDARD_FACIAL_REGIONS` from `./blemishMetrics`
  - `compareColorimetryAnalyses` from `./colorimetryMetrics`
  - `MetricAvailabilityState` from `../types/domain`
- Produces (exported from `src/services/validationMetrics.ts`):
  - `VALIDATION_PROTOCOL_VERSION = 'm4-repeatability-v1'`
  - `ValidationThresholdConfig` and `DEFAULT_M4_THRESHOLDS`:
    - `thresholdsStatus: 'provisional_pilot_thresholds'`
    - `minSamplesPerVariant: 5` (preliminary stats computed when `>= 3`, verdict requires `>= 5`)
    - `minGeometricComparableRate: 0.8`
    - `minColorComparableRate: 0.8`
    - `maxInterEyeDistanceCvPct: 5.0`
    - `maxYawSdDeg: 4.0`
    - `maxRednessFalseChangeRate: 0.1`
    - `maxDarkSpotFalseChangeRate: 0.1`
    - `minDepthBenefitRelativeReduction: 0.15`
  - `VariantRepeatabilitySummary`
  - `ThresholdGateCheck` (`id`, `label`, `variant`, `actualValue`, `thresholdText`, `passed: boolean | null`, `note`)
  - `TrueDepthDecisionVerdict = 'insufficient_data' | 'truedepth_demonstrated_benefit' | 'guidance_sufficient_depth_optional' | 'thresholds_not_met'`
  - `ValidationCohortEvaluation`
  - `LongitudinalDayPoint` & `LongitudinalTrendSummary`
  - `computeVariantRepeatability(sessions: NativeCaptureRecord[], variant: ExperimentVariant): VariantRepeatabilitySummary`
  - `evaluateValidationCohort(sessions: NativeCaptureRecord[], options?: { thresholds?: Partial<ValidationThresholdConfig> }): ValidationCohortEvaluation`
  - `buildLongitudinalTrendSummary(sessions: NativeCaptureRecord[], options?: { view?: CaptureView; deviceModel?: string }): LongitudinalTrendSummary`
  - `buildM4ValidationReportMarkdown(evaluation: ValidationCohortEvaluation, trend: LongitudinalTrendSummary, context?: { generatedAtIso?: string; targetHardwareModel?: string }): string`

- [ ] **Step 1: Write failing unit tests in `src/services/validationMetrics.test.ts`**

Write tests covering:
1. `computes apples-to-apples geometric, comparability, blemish, and colorimetry repeatability per variant`:
   - 5 synthetic Variant C captures with tight inter-eye distance (`0.28 ± 0.004`), tight depth (`0.27 ± 0.005 m`), consistent EV/WB, 1 lesion with stable `mm²` area, and `no_clear_change` CIELAB across all 10 unordered pairs → asserts `sampleCount === 5`, `totalPairs === 10`, `geometricComparableRate === 1`, `colorComparableRate === 1`, `interEyeDistanceCvPct < 3`, `depthDistanceSdCm < 1`, `rednessFalseChangeRegionRate === 0`, `darkSpotFalseChangeRegionRate === 0`.
2. `blocks cross-device and cross-view contamination in evaluateValidationCohort` (Review Focus #1):
   - Cohort mixing `iPhone13,2` and `iPhone17,1` OR mixing `front` and `left_cheek` → asserts `evaluation.cohortValid === false`, `evaluation.verdict === 'insufficient_data'`, and `evaluation.blockers` mentions device/view mismatch.
3. `marks cross-variant blemish and colorimetry comparability invalid on version drift` (Review Focus #2):
   - Variant B analyzed with `cielab-roi-srgb-v1` vs Variant C with `cielab-roi-srgb-v2` (or different `modelVersion`) → asserts `evaluation.versionConsistency.colorimetryConsistent === false` and `evaluation.verdict === 'insufficient_data'` with explicit version-drift blocker.
4. `returns null instead of NaN or fake zero for tiny samples, zero-mean areas, and missing depth` (Review Focus #3):
   - 1 capture in Variant A, and 5 captures in Variant B with `depth.available = false` and `0` blemishes (`affectedAreaNormalized = 0`) → asserts `interEyeDistanceCvPct === null` for `n=1`, `depthDistanceSdCm === null`, `mmPerPixelCvPct === null`, `normalizedAreaCvPct === null` (not `NaN`), `calibratedAreaMm2CvPct === null`, and `verdict === 'insufficient_data'`.
5. `separates not_comparable refusals from false-change rate denominator` (Review Focus #4):
   - 5 captures with large EV shifts (`> 1.5 EV`) so 0 pairs pass color comparability → asserts `colorComparableRate === 0`, `rednessFalseChangeRegionRate === null` (NOT `0`!), `refusalReasonCounts` records the EV refusal count, and color comparability threshold gate fails (`passed === false`).
6. `selects truedepth_demonstrated_benefit when Variant C beats Variant B by >= 15% relative reduction and passes all gates`:
   - 5 tight Variant C captures (e.g., inter-eye CV ~1.2%, `mm²` area CV ~1.5%) vs 5 wider-scale Variant B captures (inter-eye CV ~4.2%) both passing comparability → asserts `verdict === 'truedepth_demonstrated_benefit'` and `depthVsGuidedComparison` reports relative reduction `>= 0.15`.
7. `selects guidance_sufficient_depth_optional when Variant B already passes all gates and Variant C offers < 15% improvement`:
   - 5 equally tight Variant B and Variant C captures both passing all gates → asserts `verdict === 'guidance_sufficient_depth_optional'`.
8. `selects thresholds_not_met when sample counts are sufficient but false-change rate exceeds 10%`:
   - 5 Variant B and 5 Variant C captures where unchanged-skin redness jumps beyond noise floor on >20% of regions → asserts `verdict === 'thresholds_not_met'` with failing `redness_false_change` gate.
9. `builds multi-day longitudinal trend summary separating comparable days from non-comparable and unanalyzed days`:
   - 3 calendar days (Day 1 baseline, Day 2 comparable, Day 3 large lighting shift `not_comparable`, plus a Day 4 unanalyzed shot) → asserts exact day ordering, per-region metrics preserved without composite score, Day 3 flagged `not_comparable`, Day 4 flagged `not_analyzed`.
10. `generates honest Markdown validation report distinguishing verified device from pending iPhone 16 Pro`:
    - Runs `buildM4ValidationReportMarkdown` on an `iPhone13,2` cohort with `targetHardwareModel: 'iPhone 16 Pro'` → asserts output includes device model, `provisional_pilot_thresholds`, Variant A/B/C summary table, TrueDepth verdict, and explicit note that `iPhone 16 Pro` verification remains pending.

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `npm test`
Expected: FAIL because `src/services/validationMetrics.ts` does not exist yet.

- [ ] **Step 3: Implement `src/services/validationMetrics.ts`**

Key implementation details pinned by spec:
- Sample SD uses Bessel correction (`n - 1`) for `n >= 2`; returns `null` for `n < 2`.
- CV% = `(sd / mean) * 100` ONLY when `n >= 2` and `Math.abs(mean) > 1e-9`; otherwise `null`.
- Unordered pairs loop: `for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++)` where `sorted` is ordered chronologically ascending (`capturedAtIso`).
- For each unordered pair `(base, curr)`:
  - Run `computePairAlignmentTransform(base, curr)` → record `|scaleFactor - 1| * 100` and `Math.hypot(translateXPct, translateYPct)` whenever `mode !== 'unaligned'`.
  - Run `evaluateComparability(base, curr)` → increment `geometricComparablePairs` if `comparabilityState === 'comparable'`; otherwise bucket each blocker string into normalized refusal categories (`view_mismatch`, `mode_mismatch`, `device_mismatch`, `distance_shift`, `yaw_shift`, `exposure_ev_shift`, `white_balance_shift`, `other`).
  - Run `compareColorimetryAnalyses(base, curr, comp)`:
    - If `state === 'measured'`, increment `colorComparablePairs`; across each `regionDeltas` with `state === 'measured'`, increment `measuredRednessRegionPairs` / `measuredDarkSpotRegionPairs` and count directional calls (`rednessStatus === 'increased_appearance' || rednessStatus === 'decreased_appearance'`, same for `darkSpotStatus`), plus track `|deltaAStar|`, `|deltaRednessAreaPctPts|`, `|deltaDarkSpotAreaPctPts|`.
    - If `state === 'not_comparable'`, bucket colorimetry refusal reasons into `refusalReasonCounts`.
  - Run `compareBlemishAnalyses(base, curr, comp)`:
    - If `state === 'measured'`, increment `blemishComparablePairs` and count pair as `blemishFalseChangePair` if any standard region has `activeDelta !== 0`.
- For per-session blemish area CV%:
  - Compute per-session total `affectedAreaNormalized` and total `affectedAreaMm2` (only when all standard regions have finite non-null `affectedAreaMm2`) across analyzed sessions sharing the dominant version.
- `evaluateTrueDepthDecision`:
  - Requires `cohortValid === true`, `versionConsistency.blemishConsistent && versionConsistency.colorimetryConsistent`, and `variantB.sampleCount >= thresholds.minSamplesPerVariant && variantC.sampleCount >= thresholds.minSamplesPerVariant` — otherwise `'insufficient_data'`.
  - Evaluate all applicable threshold gates on Variant B and Variant C independently (`geometricComparableRate`, `colorComparableRate`, `interEyeDistanceCvPct`, `yawSdDeg`, `rednessFalseChangeRegionRate`, `darkSpotFalseChangeRegionRate`). A gate with `actualValue === null` when required (e.g., `colorComparableRate === 0` causing `rednessFalseChangeRegionRate === null`) evaluates to `passed: false` (never silently skipped!). Exception: if NO sessions in either B or C have colorimetry analyzed (`analyzedColorimetryCount === 0`), mark colorimetry gates `passed: null` and return `'insufficient_data'` with note `"Run CIELAB colorimetry analysis on cohort sessions first"`.
  - Compare C vs B relative reduction on:
    1. `interEyeDistanceCvPct`: `(B - C) / B` when `B > 0`
    2. `yawSdDeg`: `(B - C) / B` when `B > 0`
    3. `colorComparableRate` absolute gain `C - B >= 0.10`
    4. Within Variant C, metric-scaled `calibratedAreaMm2CvPct` vs raw `normalizedAreaCvPct`: `(normCv - mm2Cv) / normCv >= minDepthBenefitRelativeReduction`
  - If Variant C passes all gates and meets any depth-benefit criterion → `'truedepth_demonstrated_benefit'`.
  - Else if Variant B passes all gates (even if C also passes without ≥15% gain) → `'guidance_sufficient_depth_optional'`.
  - Else → `'thresholds_not_met'`.

- [ ] **Step 4: Run tests to verify all pass (GREEN)**

Run: `npm test && npm run typecheck`
Expected: PASS (all existing 26 tests + all 10 new `validationMetrics` tests = 36/36 pass; 0 TS errors).

- [ ] **Step 5: Commit**

```bash
git add src/services/validationMetrics.ts src/services/validationMetrics.test.ts
git commit -m "feat(m4): add Variant A/B/C repeatability, TrueDepth verdict, and longitudinal validation engine"
```

---

### Task 3: Validation Lab UI (`ValidationLab.tsx`) & App Integration

**Files:**
- Create: `src/components/ValidationLab.tsx`
- Modify: `src/App.tsx:55, 357-390`
- Modify: `src/index.css` (append Validation Lab styles at end of file)

**Interfaces:**
- Consumes:
  - `SessionEnvelope` from `../types/domain`
  - `BlemishAnalysisRecord`, `CaptureView`, `ColorimetryAnalysisRecord` from `@skin-trace/truedepth-camera`
  - `cameraBridge` from `../services/cameraBridge`
  - `evaluateValidationCohort`, `buildLongitudinalTrendSummary`, `buildM4ValidationReportMarkdown`, `DEFAULT_M4_THRESHOLDS` from `../services/validationMetrics`
  - `COLORIMETRY_ALGORITHM_VERSION` from `../services/colorimetryMetrics`
- Produces:
  - `ValidationLab` component:
    ```ts
    interface ValidationLabProps {
      sessions: SessionEnvelope[];
      onAnalysisSaved: (sessionId: string, record: BlemishAnalysisRecord) => void;
      onColorimetrySaved: (sessionId: string, record: ColorimetryAnalysisRecord) => void;
    }
    ```

- [ ] **Step 1: Create `src/components/ValidationLab.tsx`**

UI sections (all data tables wrapped in `<div className="table-scroll">` for iPhone portrait screens):
1. **Cohort Filter & Session Picker**:
   - View selector (`front`, `left_cheek`, `right_cheek`)
   - Device selector (auto-populated from distinct `session.capture.deviceModel` values so different phones are never silently mixed)
   - Date scope (`Today (same-day pilot)` | `All dates` | `Custom selection`) + per-session checkboxes grouped by Variant A / B / C showing capture time, quality acceptance badge, blemish/colorimetry version badges so the user can exclude intentional perturbation shots from the unchanged-skin repeatability calculation (or include only perturbation shots to audit refusals!).
   - **Batch Analyze Cohort** button: sequentially runs `cameraBridge.runCoreMLBlemishAnalysis({ sessionId })` (when unanalyzed) and `cameraBridge.runColorimetryAnalysis({ sessionId })` (when unanalyzed or `algorithmVersion !== COLORIMETRY_ALGORITHM_VERSION`), updating parent state via `onAnalysisSaved` / `onColorimetrySaved`, showing live progress (`Analyzing 3 / 15…`), and reporting any per-session errors without aborting remaining shots.
2. **TrueDepth Value Decision & Release Gate Checklist (§7.4)**:
   - Verdict banner (`insufficient_data` / `truedepth_demonstrated_benefit` / `guidance_sufficient_depth_optional` / `thresholds_not_met`) with honest explanation and explicit `Provisional Pilot Thresholds` badge.
   - Gate-by-gate checklist table showing Variant B vs Variant C actuals vs thresholds.
3. **Variant A vs B vs C Repeatability Matrix (§7.2)**:
   - Scrollable comparison table across `Variant A (Unguided)`, `Variant B (RGB Guided)`, `Variant C (RGB + TrueDepth)`:
     - Samples (`n`), Quality Acceptance Rate, Inter-Eye Scale CV%, Yaw/Roll SD, Pairwise Alignment Shift, TrueDepth Distance SD & `mm/px` CV% (`—` on A/B), Geometric & Color Comparability Rates, Active Blemish Count SD, Normalized Area CV% vs Calibrated `mm²` Area CV%, Redness False-Change Rate, Dark-Spot False-Change Rate, Median Capture/Blemish/Colorimetry Latency.
   - Refusal Reason Audit chip list (verifying appropriate refusals on perturbation captures).
4. **Longitudinal Multi-Day Trend Table (§7.3)**:
   - Displays `buildLongitudinalTrendSummary` across calendar days (same device + view) with per-day status (`baseline` / `comparable` / `not_comparable` / `not_analyzed`) and separate columns for active blemishes, physical area (`mm²`), mean `a*`, elevated redness %, and dark-spot area % — strictly NO composite "skin health" score.
5. **Export M4 Validation Report**:
   - **Copy Report (Markdown)** and **Copy Report (JSON)** buttons using `navigator.clipboard.writeText`, plus collapsible raw Markdown preview.

- [ ] **Step 2: Wire `ValidationLab` into `src/App.tsx` and append styles in `src/index.css`**

- Update `ActiveTab = 'capture' | 'compare' | 'validation'` in `src/App.tsx`.
- Add third button in `<nav className="tab-bar">`: `Validation Lab`.
- Render `<ValidationLab sessions={sessions} onAnalysisSaved={handleAnalysisSaved} onColorimetrySaved={handleColorimetrySaved} />` when `activeTab === 'validation'`.
- Add minimal, clean styles in `src/index.css` for `.cohort-grid`, `.cohort-check-item`, `.verdict-banner`, `.progress-note` matching existing CSS variables.

- [ ] **Step 3: Verify tests, typecheck, and production build**

Run: `npm test && npm run typecheck && npx vite build --configLoader runner`
Expected: All 36 tests pass, `tsc --noEmit` exits 0, Vite production build completes cleanly.

- [ ] **Step 4: Commit**

```bash
git add src/components/ValidationLab.tsx src/App.tsx src/index.css
git commit -m "feat(m4): add Validation Lab UI with cohort batch analysis, A/B/C matrix, and report export"
```

---

### Task 4: M4 Physical-Device Validation Protocol & README Update

**Files:**
- Create: `specs/m4-validation-protocol.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `VALIDATION_PROTOCOL_VERSION`, `DEFAULT_M4_THRESHOLDS`, and Validation Lab tab workflow from Tasks 1–3.
- Produces: Repeatable physical-device pilot & longitudinal evaluation checklist ready to run on iPhone 12 now and iPhone 16 Pro once Developer Mode is enabled.

- [ ] **Step 1: Write `specs/m4-validation-protocol.md`**

Include:
1. **Pre-flight checklist**: iOS 18 target synced (`npx cap sync ios`), Core ML `BlemishDetector.mlpackage` bundled, `cielab-roi-srgb-v2` active, fixed lighting location, neutral face without makeup/filters.
2. **Experiment 1 — Same-Session Repeatability Pilot (Unchanged Skin, 15 shots)**:
   - 5× Variant A (`rgb_unguided`), 5× Variant B (`rgb_guided`), 5× Variant C (`rgb_depth_guided`) on `front` view; lower arm & reset stance between every shot so captures test real re-positioning repeatability.
   - Open **Validation Lab** → select Today's cohort → tap **Batch Analyze Cohort** → inspect A/B/C matrix, threshold gates, and TrueDepth verdict → **Copy Report (Markdown)**.
3. **Experiment 2 — Controlled Perturbation & Appropriate Refusal Audit (3–4 shots)**:
   - Capture intentional distance shift (`> 6 cm` farther), intentional head yaw (`> 15°`), and intentional lighting shift (`> 0.75 EV` / warm lamp) → verify M1/M3 gates return `not_comparable` in Timeline & Compare and refusal counters increment in Validation Lab.
4. **Experiment 3 — Personal Multi-Day Longitudinal Log (7–14 days)**:
   - 1 Variant C capture/day in the same spot/lighting; review multi-day trajectory table in Validation Lab without extrapolating day-to-day noise into false improvement claims.
5. **iPhone 16 Pro Final Sign-Off Gate**:
   - Re-run M0 hardware capability probe + Experiment 1 on physical **iPhone 16 Pro** once Developer Mode is active, and record exact `deviceModel` (`iPhone17,1`) and `systemVersion` in the exported report.

- [ ] **Step 2: Update `README.md` with M4 status and Validation Lab instructions**

- Update milestone table / section so M0–M3 status and M4 Validation Lab workflow are accurately reflected, keeping honest physical-device verification notes (iPhone 12 verified; iPhone 16 Pro pending).

- [ ] **Step 3: Run full local verification suite**

Run: `npm test && npm run typecheck && npx vite build --configLoader runner`
Expected: All 36 tests pass, `tsc --noEmit` exits 0, clean Vite bundle.

- [ ] **Step 4: Commit**

```bash
git add specs/m4-validation-protocol.md README.md
git commit -m "docs(m4): add Variant A/B/C repeatability protocol and update README"
```
