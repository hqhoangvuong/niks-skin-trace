# Milestone M2: Blemish Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver inspectable per-region blemish analysis for Skin Trace — including honest manual ground-truth annotation, a licensed-model-gated on-device Core ML ROI-crop Swift runner, decoupled `analysis.json` local persistence, and version-checked longitudinal blemish comparisons in the Before/After viewer.

**Architecture:** Strictly separate capture (`session.json`), alignment (`facialAlignment`), skin inference (`analysis.json`), and longitudinal comparison (`src/services/blemishMetrics.ts` + `src/services/comparison.ts`). Because no commercially cleared acne model weights are bundled yet (ACNE04 is academic/non-commercial only; Ultralytics YOLO is AGPL-3.0), M2 ships a complete, honest end-to-end pipeline where **Manual Annotation** works immediately on real captures and the **Core ML Swift runner** (`TrueDepthBlemishAnalyzer.swift`) activates cleanly once a manifest-declared `.mlpackage` is bundled, reporting explicit `unavailable` otherwise.

**Tech Stack:** TypeScript, React 19, Vite 6, Vitest (unit tests), Capacitor 7, Swift 5.9, Apple Vision + Core ML (`VNCoreMLRequest`, `MLModelConfiguration`), local `FileProtectionType.complete` JSON storage.

**Spec:** [docs/skincare-iphone16pro-handoff.md](../../docs/skincare-iphone16pro-handoff.md) (§4.4, §5, §6, §8 M2 gate) · [specs/truedepth-skin-analysis-research.md](../truedepth-skin-analysis-research.md) (§2–4) · [AGENTS.md](../../AGENTS.md)

## Global Constraints

- **Color photo is primary; TrueDepth is supporting.** Run blemish inference on high-detail RGB ROI crops (forehead, left cheek, right cheek, chin), never on RGB-D tensors or full-face thumbnails.
- **Never fabricate detections, accuracy numbers, or improvement scores.** If `BlemishDetector.mlmodelc` is absent, return `state: 'unavailable'` with an explicit reason — never mock boxes.
- **Keep active blemishes distinct from residual marks.** `comedone`, `papule_pustule`, `nodule_cyst`, `active_blemish_unspecified` count toward `activeBlemishCount`; `residual_red_mark_pie` and `residual_dark_spot_pih` count toward `residualMarkCount` only.
- **Separate missing/unanalyzed/incompatible states from measured zero (`0`).** A session without `analysis.json` is `state: 'not_analyzed'` (counts are `null`), never `0`.
- **Enforce version compatibility on comparisons.** Never compare blemish counts across mismatched `source`, `modelVersion`, `preprocessingVersion`, `metricDefinitionVersion`, or when `comparabilityState !== 'comparable'`.
- **No composite skin health score or embedding "% improved".** Report per-region counts, affected area (`%` / `mm²`), and spatially associated lesion states (`persisting`, `candidate_new`, `no_longer_detected`) with an explicit caveat that a missed detection is not proof of healing.
- **Local-first facial privacy.** Store `analysis.json` in `Documents/SkinTraceSessions/<sessionId>/` with `FileProtectionType.complete`; never overwrite `original.heic` and never upload images.
- **iOS 14.0+ podspec/SPM compatibility.** Keep Swift plugin compatible with Capacitor 7's `14.0` deployment target while running modern iOS 16/17/18 APIs on iPhone 16 Pro.
- **Do not promise Neural Engine execution.** Configure `MLModelConfiguration().computeUnits = .all` and report actual `computationTimeMs`.

## Review Focus

1. **Unanalyzed vs. Measured Zero:** Loading a session with no `analysis.json` must yield `state: 'not_analyzed'` with `null` counts; loading an analyzed session with 0 active lesions must yield `state: 'measured'` with `activeBlemishCount: 0` (tested in Task 1).
2. **Residual Mark Isolation:** Adding or detecting `residual_red_mark_pie` or `residual_dark_spot_pih` must increment `residualMarkCount` and never increment `activeBlemishCount` (tested in Task 1).
3. **Version & Comparability Gate:** Comparing `manual_annotation` vs `research_coreml_model`, or `modelVersion: 'v1'` vs `'v2'`, or two sessions where `comparabilityState === 'not_comparable'`, must return `state: 'not_comparable'` with explicit reasons and no numeric deltas (tested in Task 1).
4. **User-Rejected & Uncertain Detections:** Detections with `uncertaintyState === 'user_rejected'` must be excluded from counts and area totals; `uncertaintyState === 'uncertain'` must increment `uncertainCount` separately from confirmed `activeBlemishCount` (tested in Task 1).
5. **Backward Compatibility With M0/M1 Sessions:** Older `session.json` files lacking `analysis.json` or `facialAlignment` must deserialize cleanly on iOS and Web without throwing or crashing React (tested in Tasks 1, 2, and 4).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `package.json` | Add `vitest` devDependency and `"test": "vitest run"` script |
| `plugins/truedepth-camera/src/definitions.ts` | Shared M2 TypeScript contracts (`LesionCategory`, `CandidateLesion`, `RegionBlemishSummary`, `BlemishAnalysisRecord`, plugin methods `saveSessionAnalysis`, `runCoreMLBlemishAnalysis`) |
| `plugins/truedepth-camera/src/web.ts` | Web fallback persistence for `saveSessionAnalysis` (`localStorage`) and honest `unavailable` response for `runCoreMLBlemishAnalysis` |
| `src/types/domain.ts` | Align `AnalysisResult` and `SessionEnvelope` with persisted `BlemishAnalysisRecord`, preserving `not_analyzed` when absent |
| `src/services/blemishMetrics.ts` | Pure functions: region assignment, per-region metric aggregation (counts, normalized area, `mm²`), and version-checked longitudinal blemish comparison + spatial lesion matching |
| `src/services/blemishMetrics.test.ts` | Vitest unit tests pinning all 5 Review Focus failure modes + spatial matching & `mm²` scaling |
| `src/services/cameraBridge.ts` | Expose typed `saveSessionAnalysis` and `runCoreMLBlemishAnalysis` bridge helpers |
| `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthBlemishAnalyzer.swift` | Swift Core ML + Vision ROI-crop inference runner reading optional `BlemishDetector.mlmodelc` + `blemish_model_manifest.json`, with honest `unavailable` fallback when unbundled |
| `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthCaptureManager.swift` | Persist/read `analysis.json` alongside `session.json` with `FileProtectionType.complete` (never modifying `original.heic`) |
| `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthCameraPlugin.swift` | Register and expose `saveSessionAnalysis` and `runCoreMLBlemishAnalysis` methods to Capacitor JS |
| `src/components/BlemishInspector.tsx` | Inspectable detection overlay + tap-to-pin manual annotation editor + Core ML runner trigger + local JSON export |
| `src/components/BeforeAfterViewer.tsx` | Display version-checked per-region blemish count deltas and aligned lesion association markers (`persisting` / `candidate_new` / `no_longer_detected`) |
| `src/App.tsx` & `src/index.css` | Wire **Inspect / Annotate** entry point from session cards into `BlemishInspector` and pass updated sessions into `BeforeAfterViewer` |
| `specs/m2-model-evaluation-protocol.md` | Documented license audit (ACNE04, Fitzpatrick17k, AGPL vs MIT/Apache-2.0 architectures), offline evaluation split rules, and Core ML promotion checklist |

---

### Task 1: M2 Schema Contracts, Vitest Harness & Pure Blemish Metrics Service

**Files:**
- Modify: `package.json`
- Modify: `plugins/truedepth-camera/src/definitions.ts`
- Modify: `src/types/domain.ts`
- Create: `src/services/blemishMetrics.ts`
- Test: `src/services/blemishMetrics.test.ts`

**Interfaces:**
- Consumes: `NativeCaptureRecord`, `FacialRegionMap`, `NormalizedPoint`, `NormalizedRect` from `@skin-trace/truedepth-camera`; `ComparisonRecord` from `src/types/domain.ts`; `computePairAlignmentTransform` from `src/services/alignment.ts`.
- Produces:
  - Types in `plugins/truedepth-camera/src/definitions.ts`:
    - `LesionCategory = 'comedone' | 'papule_pustule' | 'nodule_cyst' | 'active_blemish_unspecified' | 'residual_red_mark_pie' | 'residual_dark_spot_pih'`
    - `FacialRegionId = 'forehead' | 'anatomicalLeftCheek' | 'anatomicalRightCheek' | 'chin' | 'other'`
    - `DetectionUncertaintyState = 'confident' | 'uncertain' | 'user_verified' | 'user_rejected'`
    - `AnalysisSource = 'manual_annotation' | 'research_coreml_model' | 'validated_coreml_model'`
    - `ModelLicenseScope = 'user_authored' | 'non_commercial_research_only' | 'commercial_cleared'`
    - `CandidateLesion`, `RegionBlemishSummary`, `BlemishAnalysisRecord`
    - `SaveSessionAnalysisOptions`, `RunCoreMLBlemishAnalysisOptions`
  - Functions in `src/services/blemishMetrics.ts`:
    - `isActiveBlemishCategory(category: LesionCategory): boolean`
    - `assignLesionToRegion(center: NormalizedPoint, regions?: FacialRegionMap): FacialRegionId`
    - `summarizeRegionMetrics(lesions: CandidateLesion[], capture: NativeCaptureRecord): RegionBlemishSummary[]`
    - `buildManualAnalysisRecord(sessionId: string, lesions: CandidateLesion[], capture: NativeCaptureRecord): BlemishAnalysisRecord`
    - `compareBlemishAnalyses(baseline: NativeCaptureRecord, current: NativeCaptureRecord, comparability: ComparisonRecord): BlemishComparisonResult`

- [ ] **Step 1: Add `vitest` to `package.json` and define M2 types in `definitions.ts` and `domain.ts`**

Add `"test": "vitest run"` to `package.json` scripts and `"vitest": "^3.0.0"` to `devDependencies` (install with `npm install` when online).
Add `LesionCategory`, `FacialRegionId`, `DetectionUncertaintyState`, `AnalysisSource`, `ModelLicenseScope`, `CandidateLesion`, `RegionBlemishSummary`, `BlemishAnalysisRecord`, and optional `blemishAnalysis?: BlemishAnalysisRecord` on `NativeCaptureRecord` in `plugins/truedepth-camera/src/definitions.ts`.
Update `buildM0SessionEnvelope` (renamed/aliased as `buildSessionEnvelope`) in `src/types/domain.ts` so:
- When `capture.blemishAnalysis` is absent, `analysis.state === 'not_analyzed'` (counts remain `null`).
- When `capture.blemishAnalysis` is present, `analysis.state` reflects `capture.blemishAnalysis.state` (`'measured'` or `'unavailable'`).

- [ ] **Step 2: Write failing unit tests in `src/services/blemishMetrics.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  assignLesionToRegion,
  buildManualAnalysisRecord,
  compareBlemishAnalyses,
  summarizeRegionMetrics,
} from './blemishMetrics';

describe('blemishMetrics', () => {
  it('distinguishes not_analyzed from measured zero', () => {
    // Capture with no blemishAnalysis -> compare returns state: 'not_analyzed'
    // Capture with empty measured lesions -> summary activeBlemishCount === 0 across all 4 regions
  });

  it('keeps residual PIE/PIH marks strictly separate from active blemishes', () => {
    // 1 papule_pustule + 2 residual_dark_spot_pih in anatomicalLeftCheek
    // expects activeBlemishCount === 1 and residualMarkCount === 2
  });

  it('excludes user_rejected lesions and separates uncertain detections', () => {
    // 1 confident + 1 uncertain + 1 user_rejected in forehead
    // expects activeBlemishCount === 1, uncertainCount === 1, total counted excludes rejected
  });

  it('computes affectedAreaMm2 from estimatedMmPerPixelAtRgb when calibrated', () => {
    // 4032x3024 RGB, 0.1 mm/px, bbox 0.01 x 0.01 -> ~40.32px x 30.24px -> ~12.19 mm^2
    // without calibration -> affectedAreaMm2 === null
  });

  it('refuses longitudinal comparison on version drift or non-comparable captures', () => {
    // manual_annotation vs research_coreml_model -> state: 'not_comparable'
    // model v1 vs v2 -> state: 'not_comparable'
    // comparabilityState === 'not_comparable' -> state: 'not_comparable'
  });

  it('associates persisting, candidate_new, and no_longer_detected lesions using alignment transform', () => {
    // Baseline lesion at (0.30, 0.50) and shifted Current lesion within 0.025 normalized radius after alignment
    // expects status: 'persisting'; unmatched current -> 'candidate_new'; unmatched baseline -> 'no_longer_detected'
  });

  it('handles older sessions missing facialAlignment without throwing', () => {
    expect(assignLesionToRegion({ x: 0.5, y: 0.5 }, undefined)).toBe('other');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL (`Cannot find module './blemishMetrics'`)

- [ ] **Step 4: Implement `src/services/blemishMetrics.ts`**

Implement:
- `isActiveBlemishCategory`: returns `true` for `'comedone' | 'papule_pustule' | 'nodule_cyst' | 'active_blemish_unspecified'`, `false` for `'residual_red_mark_pie' | 'residual_dark_spot_pih'`.
- `assignLesionToRegion`: checks containment in `regions.forehead`, `anatomicalLeftCheek`, `anatomicalRightCheek`, `chin`; falls back to `'other'`.
- `summarizeRegionMetrics`: emits summaries for all 4 standard regions plus `'other'` (only when non-empty). Excludes `'user_rejected'`. Counts `'uncertain'` into `uncertainCount` only (not `activeBlemishCount`). Computes `affectedAreaMm2` using `rgbDimensions.width * rgbDimensions.height * normArea * (estimatedMmPerPixelAtRgb ** 2)` when finite, else `null`.
- `buildManualAnalysisRecord`: builds a `BlemishAnalysisRecord` with `source: 'manual_annotation'`, `licenseScope: 'user_authored'`, `modelVersion: 'manual-v1'`, `preprocessingVersion: 'original-rgb-v1'`, `metricDefinitionVersion: 'blemish-metrics-v1'`, `state: 'measured'`.
- `compareBlemishAnalyses`:
  - Returns `state: 'not_analyzed'` if either session has no `blemishAnalysis` or either analysis `state !== 'measured'`.
  - Returns `state: 'not_comparable'` if `comparability.comparabilityState !== 'comparable'` OR any of `source`, `modelVersion`, `preprocessingVersion`, `metricDefinitionVersion` differ.
  - Otherwise computes per-region active/residual deltas (`current - baseline`) and greedy nearest-neighbor spatial matching (threshold `0.03` normalized distance after applying `computePairAlignmentTransform` to current lesion centers when `alignment.mode !== 'unaligned'`; skips spatial matching cleanly with `spatialMatchingAvailable: false` when `alignment.mode === 'unaligned'`).

- [ ] **Step 5: Run tests & typecheck to verify pass**

Run: `npm test && npm run typecheck`
Expected: All `blemishMetrics.test.ts` assertions PASS, `tsc --noEmit` exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json plugins/truedepth-camera/src/definitions.ts src/types/domain.ts src/services/blemishMetrics.ts src/services/blemishMetrics.test.ts
git commit -m "feat(m2): add blemish analysis schema, Vitest harness, and pure region/delta metrics"
```

---

### Task 2: Local `analysis.json` Persistence & Plugin Bridge (Swift + Web Fallback)

**Files:**
- Modify: `plugins/truedepth-camera/src/definitions.ts` (method signatures on `TrueDepthCameraPlugin`)
- Modify: `plugins/truedepth-camera/src/web.ts`
- Modify: `src/services/cameraBridge.ts`
- Modify: `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthCaptureManager.swift`
- Modify: `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthCameraPlugin.swift`

**Interfaces:**
- Consumes: `BlemishAnalysisRecord`, `SaveSessionAnalysisOptions`, `RunCoreMLBlemishAnalysisOptions` from `definitions.ts`.
- Produces:
  - `cameraBridge.saveSessionAnalysis(sessionId: string, analysis: BlemishAnalysisRecord): Promise<{ saved: boolean }>`
  - `cameraBridge.runCoreMLBlemishAnalysis(options: RunCoreMLBlemishAnalysisOptions): Promise<BlemishAnalysisRecord>`
  - Native persistence at `Documents/SkinTraceSessions/<sessionId>/analysis.json` (`FileProtectionType.complete`), auto-attached as `blemishAnalysis` by `listLocalSessions()`.

- [ ] **Step 1: Add `saveSessionAnalysis` & `runCoreMLBlemishAnalysis` to `TrueDepthCameraPlugin` interface and `cameraBridge.ts`**

Add both methods to `TrueDepthCameraPlugin` in `definitions.ts` and forward them in `src/services/cameraBridge.ts`.

- [ ] **Step 2: Implement Web fallback in `plugins/truedepth-camera/src/web.ts`**

- `saveSessionAnalysis`: merges `blemishAnalysis` onto the matching session in `WEB_STORAGE_KEY` in `localStorage` and returns `{ saved: true }`.
- `runCoreMLBlemishAnalysis`: returns an honest `BlemishAnalysisRecord` with `state: 'unavailable'`, `source: 'research_coreml_model'`, `unavailableReason: 'Core ML inference requires native iOS execution on a physical iPhone.'`, empty `lesions: []` and `regions: []`.

- [ ] **Step 3: Implement native `analysis.json` persistence in `TrueDepthCaptureManager.swift`**

- Add `saveSessionAnalysis(sessionId: String, analysis: [String: Any]) throws -> Bool`:
  - Validates `UUID(uuidString: sessionId) != nil` and that `Documents/SkinTraceSessions/<sessionId>/` exists.
  - Serializes `analysis` as pretty-printed JSON and writes atomically to `analysis.json` with `[.atomic, .completeFileProtection]`.
- Update `listLocalSessions()` to check for `analysis.json` inside each session directory; if present and valid JSON, attach it as `json["blemishAnalysis"]`. Missing `analysis.json` is left omitted (never crashes on M0/M1 sessions).

- [ ] **Step 4: Register `saveSessionAnalysis` in `TrueDepthCameraPlugin.swift`**

Add `CAPPluginMethod(name: "saveSessionAnalysis", returnType: CAPPluginReturnPromise)` and `CAPPluginMethod(name: "runCoreMLBlemishAnalysis", returnType: CAPPluginReturnPromise)` to `pluginMethods` and implement `saveSessionAnalysis(_ call: CAPPluginCall)` (with `runCoreMLBlemishAnalysis` delegating to `TrueDepthBlemishAnalyzer` in Task 3).

- [ ] **Step 5: Verify TypeScript & Vite build**

Run: `npm run typecheck && npm test && npx vite build --configLoader runner`
Expected: PASS, 0 errors.

- [ ] **Step 6: Commit**

```bash
git add plugins/truedepth-camera/ src/services/cameraBridge.ts
git commit -m "feat(m2): add local analysis.json persistence and bridge methods"
```

---

### Task 3: Swift Core ML ROI-Crop Inference Runner (`TrueDepthBlemishAnalyzer.swift`)

**Files:**
- Create: `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthBlemishAnalyzer.swift`
- Modify: `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthCameraPlugin.swift`
- Modify: `README.md` (add file to Swift plugin tree)

**Interfaces:**
- Consumes: `Documents/SkinTraceSessions/<sessionId>/original.{heic,jpg}`, `session.json` (`facialAlignment.regions`, `rgbDimensions`, `depth.estimatedMmPerPixelAtRgb`), optional app-bundle resources `BlemishDetector.mlmodelc` and `blemish_model_manifest.json`.
- Produces: `TrueDepthBlemishAnalyzer.analyze(sessionId:confidenceThreshold:uncertainThreshold:)` returning a `BlemishAnalysisRecord` dictionary and persisting it to `analysis.json` when `state == "measured"`.

- [ ] **Step 1: Define `blemish_model_manifest.json` contract in `TrueDepthBlemishAnalyzer.swift`**

Manifest struct (loaded from `Bundle.main.url(forResource: "blemish_model_manifest", withExtension: "json")`):
- `modelVersion: String`
- `preprocessingVersion: String`
- `licenseScope: String` (`"non_commercial_research_only"` | `"commercial_cleared"`)
- `modelSource: String` (`"research_coreml_model"` | `"validated_coreml_model"`)
- `classMap: [String: String]` (maps raw model label to Skin Trace `LesionCategory`)
- `defaultConfidenceThreshold: Double` (default `0.45`)
- `defaultUncertainThreshold: Double` (default `0.25`)

- [ ] **Step 2: Implement honest unbundled fallback & manifest gate**

If `Bundle.main.url(forResource: "BlemishDetector", withExtension: "mlmodelc")` OR `blemish_model_manifest.json` is missing:
- Return immediately (without writing fake `analysis.json`) with:
  - `state: "unavailable"`
  - `unavailableReason: "No licensed Core ML model bundled (expected BlemishDetector.mlmodelc and blemish_model_manifest.json). Use Manual Annotation or add a manifest-verified model."`
  - `lesions: []`, `regions: []`, `computationTimeMs: 0`.

- [ ] **Step 3: Implement full-res ROI cropping, `VNCoreMLRequest`, coordinate re-mapping, and cross-ROI NMS**

When model + manifest are present:
1. Load `original.heic` (or `original.jpg`) via `CGImageSourceCreateWithURL` / `UIImage` preserving full resolution (never thumbnail).
2. Read `session.json` `facialAlignment.regions` (`forehead`, `anatomicalLeftCheek`, `anatomicalRightCheek`, `chin`); if unavailable, fall back to `faceBoundingBox` crop with a warning.
3. For each ROI rect (padded by 8% within `[0, 1]` bounds to avoid clipping edge lesions):
   - Crop `CGImage` at native pixel coordinates.
   - Run `VNCoreMLRequest` with `MLModelConfiguration().computeUnits = .all` and `imageCropAndScaleOption = .scaleFit`.
   - Convert each `VNRecognizedObjectObservation` (Vision bottom-left crop coords) back to full-image normalized top-left `[0, 1]` coordinates.
   - Keep observations with `confidence >= uncertainThreshold`; tag `confidence >= confidenceThreshold` as `"confident"`, else `"uncertain"`.
4. Run simple IoU (`>= 0.45`) Non-Maximum Suppression across overlapping ROI crops.
5. Compute per-region summaries (same active vs residual vs uncertain rules + `mm²` scale), record `computationTimeMs`, persist `analysis.json` with `.completeFileProtection`, and return the full record.

- [ ] **Step 4: Wire `runCoreMLBlemishAnalysis` in `TrueDepthCameraPlugin.swift`**

Dispatch analysis on `DispatchQueue.global(qos: .userInitiated)` so the main UI thread never stalls, then resolve/reject the Capacitor call.

- [ ] **Step 5: Verify TypeScript/Vite build & review Swift for iOS 14.0+ availability**

Run: `npm run typecheck && npm test`
Manually verify zero unguarded iOS 15+/16+/17+ APIs in `TrueDepthBlemishAnalyzer.swift` (`VNCoreMLRequest`, `VNRecognizedObjectObservation`, `MLModelConfiguration().computeUnits` are all iOS 12+).

- [ ] **Step 6: Commit**

```bash
git add plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthBlemishAnalyzer.swift plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthCameraPlugin.swift README.md
git commit -m "feat(m2): add Core ML ROI-crop blemish analyzer with honest unbundled fallback"
```

---

### Task 4: Inspectable Blemish & Manual Annotation UI (`BlemishInspector.tsx`)

**Files:**
- Create: `src/components/BlemishInspector.tsx`
- Modify: `src/App.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `SessionEnvelope` from `src/types/domain.ts`; `cameraBridge.saveSessionAnalysis`, `cameraBridge.runCoreMLBlemishAnalysis`, `resolvePreviewSrc` from `src/services/cameraBridge.ts`; `assignLesionToRegion`, `buildManualAnalysisRecord` from `src/services/blemishMetrics.ts`.
- Produces: `<BlemishInspector session={...} onAnalysisSaved={...} onClose={...} />` mounted from `src/App.tsx` when tapping **Inspect / Annotate** on any local session card.

- [ ] **Step 1: Build interactive canvas/image overlay in `src/components/BlemishInspector.tsx`**

Features:
- Displays the session's original photo with subtle dashed facial ROI boxes (`forehead`, `L cheek`, `R cheek`, `chin`) and color-coded lesion markers:
  - Active blemishes (`comedone`, `papule_pustule`, `nodule_cyst`, `active_blemish_unspecified`) — coral/red pins/boxes
  - Residual marks (`residual_red_mark_pie`, `residual_dark_spot_pih`) — amber/purple pins/boxes
  - Uncertain detections (`uncertaintyState === 'uncertain'`) — dashed outline badge
- **Manual Pin Mode**: select category, tap anywhere on the photo to record normalized `[0, 1]` click coordinates (`(clientX - rect.left) / rect.width`, `(clientY - rect.top) / rect.height`), auto-assign region via `assignLesionToRegion`, save locally via `cameraBridge.saveSessionAnalysis`.
- **Inspect / Verify Mode**: tap any existing marker to view category, region, confidence (if model-generated), and `mm²` estimate, with buttons to **Verify (`user_verified`)**, **Dismiss (`user_rejected`)**, or **Delete** (for manual pins).
- **Run On-Device Core ML Model** button: calls `cameraBridge.runCoreMLBlemishAnalysis`; if `state === 'unavailable'`, displays the honest reason banner without modifying existing manual annotations. If a `non_commercial_research_only` model runs, displays a prominent `RESEARCH MODEL — NOT CLINICALLY VALIDATED` warning badge.
- **Per-Region Summary Table**: displays Forehead / L Cheek / R Cheek / Chin rows showing Active Blemishes, Residual Marks, Uncertain count, and Affected Area (`mm²` or `%`).
- **Copy Annotations JSON** button: copies the `BlemishAnalysisRecord` for offline evaluation without uploading anything.

- [ ] **Step 2: Wire **Inspect / Annotate** button on each session card in `src/App.tsx`**

Add `inspectedSessionId` state in `CaptureLab` (`src/App.tsx`) and an **Inspect / Annotate** button alongside **Copy JSON** and **Delete**. When a session is inspected, render `<BlemishInspector>` and update the in-memory `sessions` list when `onAnalysisSaved` fires so badges update immediately (`Analysis: measured (manual)` vs `Analysis: not_analyzed`).

- [ ] **Step 3: Style overlays and summary tables cleanly in `src/index.css`**

Add mobile-safe styles for `.inspector-stage`, `.lesion-pin` (active / residual / uncertain / rejected variants), `.region-table`, and `.research-banner`.

- [ ] **Step 4: Verify TypeScript, tests, and Vite production build**

Run: `npm test && npm run typecheck && npx vite build --configLoader runner`
Expected: All tests PASS, 0 TS errors, clean Vite bundle.

- [ ] **Step 5: Commit**

```bash
git add src/components/BlemishInspector.tsx src/App.tsx src/index.css
git commit -m "feat(m2): add inspectable blemish viewer and manual ground-truth annotation UI"
```

---

### Task 5: Longitudinal Blemish Deltas in `BeforeAfterViewer.tsx`

**Files:**
- Modify: `src/components/BeforeAfterViewer.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `compareBlemishAnalyses` from `src/services/blemishMetrics.ts`; `baseline` and `current` `NativeCaptureRecord` with optional `blemishAnalysis`.
- Produces: Version-checked **Blemish Region Comparison Card** and optional aligned lesion association overlay (`persisting`, `candidate_new`, `no_longer_detected`) inside the **Timeline & Compare** tab.

- [ ] **Step 1: Wire `compareBlemishAnalyses(baseline, current, comparison)` in `BeforeAfterViewer.tsx`**

- When `blemishComparison.state === 'not_analyzed'`: render honest badge `Blemish Comparison: not_analyzed` with prompt `"Annotate or analyze both sessions in Capture Lab to compare region counts."`
- When `blemishComparison.state === 'not_comparable'`: render warning box with exact refusal reasons (e.g., lighting EV drift, model version mismatch, or `manual_annotation` vs model mismatch) — **zero numeric deltas displayed**.
- When `blemishComparison.state === 'measured'`:
  - Render per-region table (`Forehead`, `L Cheek`, `R Cheek`, `Chin`): `Before Active → After Active (Δ)`, `Before Residual → After Residual (Δ)`, and `Area Δ (mm²)` when calibrated.
  - Render explicit disclaimer: `"Visible count differences reflect detected/annotated regions only and do not establish skincare product causation. A no-longer-detected lesion is not proof of healing."`
  - Add a **Lesion Overlay: On/Off** toggle rendering spatially matched pins (`persisting`, `candidate_new`, `no_longer_detected`) when `spatialMatchingAvailable === true`.

- [ ] **Step 2: Verify TypeScript, tests, and Vite production build**

Run: `npm test && npm run typecheck && npx vite build --configLoader runner`
Expected: All tests PASS, 0 TS errors, clean Vite bundle.

- [ ] **Step 3: Commit**

```bash
git add src/components/BeforeAfterViewer.tsx src/index.css
git commit -m "feat(m2): integrate version-checked blemish deltas and spatial tracking in Before/After viewer"
```

---

### Task 6: Model Licensing Audit & Offline Evaluation Protocol Doc

**Files:**
- Create: `specs/m2-model-evaluation-protocol.md`

**Interfaces:**
- Consumes: Licensing findings from M2 planning and hardware metrics from M0/M1 (`4032×3024` RGB, `~0.108 mm/px` at 29–30 cm).
- Produces: Actionable offline training/evaluation & Core ML promotion checklist for M2 completion gate.

- [ ] **Step 1: Write `specs/m2-model-evaluation-protocol.md`**

Document:
1. **Verified License Status Matrix**:
   - `ACNE04`: Academic / non-commercial research only (community CC BY 4.0 re-uploads do not override original terms).
   - `Fitzpatrick17k`: Research/fairness only; underlying atlas image copyrights restrict commercial deployment.
   - `Ultralytics YOLO (v8/v11)`: AGPL-3.0 unless enterprise-licensed; list permissive Apache-2.0 / MIT detector alternatives (`YOLOX`, `RT-DETR`, `NanoDet-Plus`, `torchvision MobileNetV3-SSD`, Apple Create ML Object Detector).
2. **Data Partitioning & Annotation Standard**:
   - Participant-level disjoint splits (every image of a user in exactly one of train / val / test — zero identity leakage).
   - Required class split: active lesions (`comedone`, `papule_pustule`, `nodule_cyst`) strictly separate from residual marks (`PIE`, `PIH`).
3. **Offline & On-Device Promotion Gate (Before setting `licenseScope: 'commercial_cleared'`)**:
   - Held-out per-class precision, recall, count MAE, and false-change rate on unchanged-skin repeat captures.
   - Stratified reporting across Fitzpatrick skin tones and indoor lighting levels.
   - Physical **iPhone 16 Pro** Core ML benchmark: latency (ms), peak memory (MB), and thermal stability across 10 consecutive captures.
4. **How to Drop a Candidate Model Into Xcode**:
   - Exact filenames (`BlemishDetector.mlmodelc` / `.mlpackage` + `blemish_model_manifest.json`) and Xcode target membership instructions.

- [ ] **Step 2: Commit**

```bash
git add specs/m2-model-evaluation-protocol.md
git commit -m "docs(m2): document model license audit and offline/device evaluation protocol"
```

---

## Self-Review Checklist (Completed)

1. **Spec coverage**: Covers every M2 requirement from `docs/skincare-iphone16pro-handoff.md` §4.4, §5, §6, §8 and `AGENTS.md`: ROI-crop inference preserving detail (Task 3), active vs residual distinction (Task 1 & 4), uncertainty & inspectable detections (Task 1, 3, 4), version-checked comparisons & honest `not_analyzed`/`unavailable`/`not_comparable` states (Task 1, 2, 5), local-only storage (Task 2), and license/held-out validation gate (Task 6).
2. **Step scan**: Every task specifies exact files, function signatures, values, commands, and assertions without writing full transcripts.
3. **Type consistency**: `LesionCategory`, `FacialRegionId`, `DetectionUncertaintyState`, `BlemishAnalysisRecord`, `saveSessionAnalysis`, `runCoreMLBlemishAnalysis`, `compareBlemishAnalyses` are consistent across Tasks 1–5.
4. **Review Focus**: All 5 uncovered failure modes (unanalyzed vs zero, residual mark isolation, version/comparability drift, rejected/uncertain filtering, M0/M1 backward compatibility) have explicit tests in Task 1.
5. **Proportion**: Focused on architectural contracts, boundaries, and verification commands rather than boilerplate code dumps.
