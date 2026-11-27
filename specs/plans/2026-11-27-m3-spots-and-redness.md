# Milestone M3: Dark Spots & Redness Appearance Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two hardware quirks observed on real iPhone 12 M2 captures (1-class Core ML confidence and upper-cheekbone ROI bounds) and implement deterministic per-region CIELAB redness and dark-spot appearance metrics with strict color-consistency comparability gating and Before/After longitudinal deltas.

**Architecture:** Compute CIELAB (`L*`, `a*`, `b*`), Erythema Index proxy, localized redness area fraction, and localized dark-spot contrast proxy directly on upright full-resolution sRGB ROI crops in Swift (`TrueDepthColorimetryAnalyzer.swift`) using skin-tone-adaptive within-ROI baselines (excluding specular glare and deep shadows). Store results separately in `colorimetry.json` (`FileProtectionType.complete`), and gate longitudinal deltas in `src/services/colorimetryMetrics.ts` with stricter lighting (`≤ 0.75 EV`), white-balance (`≤ 0.20`), and stand-off distance (`≤ 4.0 cm`) checks than geometric blemish counting.

**Tech Stack:** TypeScript, React 19, Vite 6, Node `node:test` + `esbuild` (`npm test`), Capacitor 7, Swift 5.9, CoreImage / CoreGraphics (sRGB pixel sampling), local `FileProtectionType.complete` JSON storage.

**Spec:** [docs/skincare-iphone16pro-handoff.md](../../docs/skincare-iphone16pro-handoff.md) (§4.3, §5, §6, §8 M3 gate) · [specs/truedepth-skin-analysis-research.md](../truedepth-skin-analysis-research.md) (§2–4) · [AGENTS.md](../../AGENTS.md)

## Global Constraints

- **Report appearance proxies, never physiological clinical measurements.** Label redness as relative optical redness (`a*` / Erythema Index proxy) and dark spots as relative optical darkness/contrast — never claim melanin concentration or clinical dermatological severity.
- **Avoid aggressive color normalization.** Render unmodified original capture bytes into standard sRGB without auto-contrast or histogram stretching that could erase real redness or pigmentation changes.
- **Skin-tone-inclusive relative thresholds.** Compute localized redness (`a* - median_a* >= 3.0`) and dark-spot contrast (`p75_L* - L* >= 6.0`) relative to each ROI's own valid-skin distribution so metrics work across Fitzpatrick phototypes I–VI.
- **Do not treat smartphone `b*` / ITA° as a primary improvement metric.** Log `meanBStar` for diagnostics only (low blue-channel SNR / poor ICC `0.425` under indoor lighting).
- **Use a consistent valid-skin denominator.** Mask out specular glare (`L* > 92` or `R,G,B >= 248`) and deep shadow/hair (`L* < 15` or `R,G,B <= 15`); mark any ROI with `validSkinPixelRatio < 0.35` as `state: 'unavailable'` rather than reporting `0`.
- **Enforce stricter color-consistency comparability.** Refuse colorimetry deltas (`state: 'not_comparable'`) when `|ΔEV| > 0.75`, `|ΔWB_Red| > 0.20`, `|ΔWB_Blue| > 0.20`, `|ΔDistance| > 4.0 cm`, capture mode/device differs, or `metricDefinitionVersion` / `algorithmVersion` mismatches.
- **Distinguish small capture noise from clear change.** Flag small deltas (`|Δa*| < 0.8`, `|ΔRednessArea| < 1.5%`, `|ΔDarkSpotArea| < 1.5%`) as `"no_clear_change"` rather than claiming improvement/worsening.
- **Separate concerns and keep data local.** Persist colorimetry in `Documents/SkinTraceSessions/<sessionId>/colorimetry.json` with `FileProtectionType.complete`; never overwrite `original.heic` or `analysis.json`.
- **iOS 14.0+ podspec/SPM compatibility.** Use only iOS 14+-safe CoreGraphics/CoreImage/Foundation APIs in Swift.

## Review Focus

1. **Glare & Shadow Contamination:** An ROI dominated by specular glare or dark hair (`validSkinPixelRatio < 0.35`) must report region `state: 'unavailable'` with `null` metrics, never `0` redness or `100%` dark spots (tested in Task 2).
2. **Stricter Lighting / WB / Distance Color Gate:** Two sessions that pass M1's `1.5 EV` / `6.0 cm` geometric comparability gate (`comparable`) but differ by `0.90 EV`, `0.25 WB`, or `5.0 cm` distance must STILL be refused (`state: 'not_comparable'`) by `compareColorimetryAnalyses` (tested in Task 2).
3. **Cross-Skin-Tone Invariance:** Uniform dark skin (`L* = 35`) and uniform light skin (`L* = 75`) with no spots must both report `0%` `darkSpotContrastAreaFraction` and `0%` `elevatedRednessAreaFraction` (no skin-tone bias) (tested in Task 2).
4. **Noise-Floor vs. Directional Change Labeling:** Tiny repeat-capture drift (`Δa* = +0.3`, `ΔDarkSpotArea = -0.5%`) must classify as `'no_clear_change'`, never claiming improvement or worsening (tested in Task 2).
5. **Backward Compatibility With M0/M1/M2 Sessions:** Older `session.json` files lacking `colorimetry.json`, `cameraMetadata`, or `facialAlignment` must deserialize cleanly, report `state: 'not_analyzed'` when unrun, and return `unavailable` honestly when `facialAlignment.regions` is missing (tested in Tasks 2, 3, and 4).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthBlemishAnalyzer.swift` | Fix 1-class Core ML NMS confidence (`min(obs.confidence, topLabel.confidence)`) |
| `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthLandmarkAligner.swift` | Raise upper-cheek ROI (`cheekTop = eyeY + fh * 0.06`, `width = fw * 0.29`) so upper-cheekbone lesions stay inside cheek ROIs |
| `plugins/truedepth-camera/src/definitions.ts` | Add M3 contracts (`RegionColorimetryMetrics`, `ColorimetryAnalysisRecord`, `RunColorimetryAnalysisOptions`, `colorimetryAnalysis?` on `NativeCaptureRecord`, `runColorimetryAnalysis` on `TrueDepthCameraPlugin`) |
| `src/types/domain.ts` | Populate `dark_spots` and `redness` concern states in `buildM0SessionEnvelope` from persisted `colorimetryAnalysis` |
| `src/services/colorimetryMetrics.ts` | Pure CIELAB sRGB conversion (`srgbToLab`, `computeRegionColorimetryFromRgba`), strict color-consistency comparability gate, and longitudinal redness/dark-spot delta & noise-floor classifier (`compareColorimetryAnalyses`) |
| `src/services/colorimetryMetrics.test.ts` | Unit tests pinning CIELAB math accuracy, skin-tone invariance, glare/shadow exclusion, strict EV/WB/distance refusal, noise-floor classification, and legacy session compatibility |
| `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthColorimetryAnalyzer.swift` | Native Swift sRGB CIELAB per-ROI redness & dark-spot analyzer running on full-res upright original capture, persisting `colorimetry.json` (`FileProtectionType.complete`) |
| `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthCaptureManager.swift` | Add `saveSessionColorimetry` and auto-load optional `colorimetry.json` in `listLocalSessions()` |
| `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthCameraPlugin.swift` | Register and expose `runColorimetryAnalysis` to Capacitor JS |
| `plugins/truedepth-camera/src/web.ts` & `src/services/cameraBridge.ts` | Expose `runColorimetryAnalysis` with honest web fallback (`state: 'unavailable'` when image pixels unavailable or canvas CIELAB fallback) |
| `src/components/BlemishInspector.tsx` | Add **Run Redness & Spots Analysis** trigger + Per-Region Redness & Dark-Spot Appearance table (keeping `dark_spots`, `redness`, and `acne_blemishes` strictly separate) |
| `src/components/BeforeAfterViewer.tsx` & `src/App.tsx` | Display color-consistency-gated longitudinal Redness & Dark-Spot region deltas (`no_clear_change` / `decreased_appearance` / `increased_appearance` / `not_comparable` / `not_analyzed`) + update session card badges |

---

### Task 1: Fix Two Real-Hardware M2 Quirks (1-Class Core ML Confidence & Cheek ROI Bounds)

**Files:**
- Modify: `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthBlemishAnalyzer.swift:180-190`
- Modify: `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthLandmarkAligner.swift:128-145`

**Interfaces:**
- Consumes: `VNRecognizedObjectObservation` (`obs.confidence`, `topLabel.confidence`); Vision face landmarks in `TrueDepthLandmarkAligner`.
- Produces: True detection box confidence for 1-class Core ML NMS detectors; upper-cheekbone coverage in `anatomicalLeftCheek` and `anatomicalRightCheek`.

- [ ] **Step 1: Fix 1-class Core ML confidence in `TrueDepthBlemishAnalyzer.swift`**

Replace `let conf = Double(topLabel.confidence)` with `let conf = Double(min(obs.confidence, topLabel.confidence))` so 1-class Core ML NMS models (where `topLabel.confidence == 1.0` conditional probability) use the real detection score `obs.confidence` for both `confidence` output and `confident` vs `uncertain` thresholding.

- [ ] **Step 2: Adjust cheek ROI top margin and width in `TrueDepthLandmarkAligner.swift`**

Update `cheekTop = eyeY + fh * 0.06` (down from `0.10`), `anatomicalRightCheekRect` (`x: fx + fw * 0.08, width: fw * 0.29`), and `anatomicalLeftCheekRect` (`x: fx + fw * 0.63, width: fw * 0.29`) so upper-cheekbone lesions (such as `y = 0.4746` in `docs/inspect-annotate-report-result.json`) fall cleanly inside the cheek ROI without colliding with eye or lip bands.

- [ ] **Step 3: Verify existing test suite & TypeScript check**

Run: `npm test && npm run typecheck`
Expected: 9/9 tests PASS, `tsc --noEmit` exits 0.

- [ ] **Step 4: Commit**

```bash
git add plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthBlemishAnalyzer.swift plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthLandmarkAligner.swift
git commit -m "fix(m2): use obs.confidence for 1-class Core ML NMS and expand upper-cheek ROI"
```

---

### Task 2: M3 Colorimetry Schema & Pure CIELAB + Comparability Service (TDD)

**Files:**
- Modify: `plugins/truedepth-camera/src/definitions.ts`
- Modify: `src/types/domain.ts`
- Create: `src/services/colorimetryMetrics.ts`
- Test: `src/services/colorimetryMetrics.test.ts`

**Interfaces:**
- Consumes: `NativeCaptureRecord`, `FacialRegionId`, `CameraExposureMetadata` from `@skin-trace/truedepth-camera`; `ComparisonRecord`, `MetricAvailabilityState` from `src/types/domain.ts`.
- Produces:
  - Types in `definitions.ts`:
    - `RegionColorimetryMetrics` (`region`, `state: 'measured' | 'unavailable'`, `unavailableReason?`, `sampledPixelCount`, `validSkinPixelRatio`, `meanLStar`, `meanAStar`, `meanBStar`, `erythemaIndex`, `melaninIndexProxy`, `elevatedRednessAreaFraction`, `darkSpotContrastAreaFraction`, `darkSpotContrastDeltaL`)
    - `ColorimetryAnalysisRecord` (`sessionId`, `analyzedAtIso`, `state: 'measured' | 'unavailable'`, `unavailableReason?`, `algorithmVersion`, `metricDefinitionVersion`, `colorSpace: 'sRGB_D65'`, `computationTimeMs`, `regions`, `warnings`)
    - `RunColorimetryAnalysisOptions`
  - Functions in `src/services/colorimetryMetrics.ts`:
    - `srgbToLab(r255: number, g255: number, b255: number): { l: number; a: number; b: number; rLin: number; gLin: number }`
    - `computeRegionColorimetryFromRgba(rgba: Uint8ClampedArray, region: FacialRegionId): RegionColorimetryMetrics`
    - `compareColorimetryAnalyses(baseline: NativeCaptureRecord, current: NativeCaptureRecord, comparability: ComparisonRecord): ColorimetryComparisonResult`

- [ ] **Step 1: Add M3 types to `definitions.ts` and update `domain.ts`**

Add `RegionColorimetryMetrics`, `ColorimetryAnalysisRecord`, `RunColorimetryAnalysisOptions`, and optional `colorimetryAnalysis?: ColorimetryAnalysisRecord` on `NativeCaptureRecord`.
Update `buildM0SessionEnvelope` in `src/types/domain.ts` so `dark_spots` and `redness` concern states reflect `capture.colorimetryAnalysis?.state ?? 'not_analyzed'` independently from `acne_blemishes`.

- [ ] **Step 2: Write failing unit tests in `src/services/colorimetryMetrics.test.ts`**

Pin:
1. `srgbToLab` reference white `(255,255,255) -> L≈100, a≈0, b≈0`, black `(0,0,0) -> L≈0`, mid-gray `(128,128,128) -> L≈53.6, a≈0, b≈0`, and redder patch increases `a*` and `erythemaIndex`.
2. **Review Focus #1 (Glare & Shadow exclusion)**: Patch with 80% clipped white `(252,252,252)` -> `validSkinPixelRatio < 0.35`, `state: 'unavailable'`, metrics `null`.
3. **Review Focus #3 (Cross-skin-tone invariance)**: Uniform dark skin `(110,75,60)` and uniform light skin `(215,175,155)` both yield `elevatedRednessAreaFraction === 0` and `darkSpotContrastAreaFraction === 0`; injecting a 10% darker spot patch or 10% redder patch detects `~0.10` area fraction on BOTH skin tones.
4. **Review Focus #2 (Stricter EV/WB/distance gate)**: Sessions passing M1 geometric comparability (`comparable`) but having `|ΔEV| = 0.90`, or `|ΔWB_Red| = 0.25`, or `|ΔDistance| = 5.0 cm` return `state: 'not_comparable'` with explicit reasons and empty deltas.
5. **Review Focus #4 (Noise floor vs directional shift)**: Small drift (`Δa* = +0.3`, `ΔRednessArea = +0.4%`) classifies as `'no_clear_change'`; larger shift (`Δa* = -2.0` or `ΔDarkSpotArea = -4.0%`) classifies as `'decreased_appearance'`.
6. **Review Focus #5 (Unanalyzed / legacy sessions)**: Missing `colorimetryAnalysis` returns `state: 'not_analyzed'` cleanly without throwing; mismatched `algorithmVersion` returns `state: 'not_comparable'`.

- [ ] **Step 3: Run test to verify it fails (RED)**

Run: `npm test`
Expected: FAIL (`Could not resolve "./colorimetryMetrics"`)

- [ ] **Step 4: Implement `src/services/colorimetryMetrics.ts` (GREEN)**

Implement exact sRGB→linear→XYZ(D65)→CIELAB conversion, valid-skin masking (`L* ∈ [15, 92]` and channels not clipped `<= 15` or `>= 248`), median `a*` + `p75 L*` within-ROI baselines (`elevatedRedness` threshold `+3.0 a*`, `darkSpot` threshold `-6.0 L*`), and strict color comparability gate (`|ΔEV| ≤ 0.75`, `|ΔWB| ≤ 0.20`, `|ΔDist| ≤ 4.0 cm`, matching versions).

- [ ] **Step 5: Run tests & typecheck to verify pass**

Run: `npm test && npm run typecheck`
Expected: All `blemishMetrics.test.ts` + `colorimetryMetrics.test.ts` tests PASS, `tsc --noEmit` exits 0.

- [ ] **Step 6: Commit**

```bash
git add plugins/truedepth-camera/src/definitions.ts src/types/domain.ts src/services/colorimetryMetrics.ts src/services/colorimetryMetrics.test.ts
git commit -m "feat(m3): add CIELAB redness and dark-spot schema, math, and strict color comparability gate"
```

---

### Task 3: Native Swift CIELAB Analyzer, `colorimetry.json` Persistence & Plugin Bridge

**Files:**
- Create: `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthColorimetryAnalyzer.swift`
- Modify: `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthCaptureManager.swift`
- Modify: `plugins/truedepth-camera/ios/Sources/TrueDepthCameraPlugin/TrueDepthCameraPlugin.swift`
- Modify: `plugins/truedepth-camera/src/definitions.ts` (`runColorimetryAnalysis` method)
- Modify: `plugins/truedepth-camera/src/web.ts`
- Modify: `src/services/cameraBridge.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `Documents/SkinTraceSessions/<sessionId>/original.{heic,jpg}` and `session.json` (`facialAlignment.regions`).
- Produces:
  - `cameraBridge.runColorimetryAnalysis(sessionId: string): Promise<ColorimetryAnalysisRecord>`
  - Native persistence at `Documents/SkinTraceSessions/<sessionId>/colorimetry.json` (`FileProtectionType.complete`), auto-loaded by `listLocalSessions()` as `colorimetryAnalysis`.

- [ ] **Step 1: Implement `TrueDepthColorimetryAnalyzer.swift`**

1. Load upright full-res original capture via `CIImage(contentsOf: imageURL, options: [.applyOrientationProperty: true])` rendered into an explicit **`CGColorSpace(name: CGColorSpace.sRGB)`** `CGContext` per ROI (downsampling only if an ROI exceeds `320×320` pixels so sampling runs in ~15–30 ms while preserving fine spot contrast!).
2. Apply identical math to `src/services/colorimetryMetrics.ts`:
   - sRGB linearization -> XYZ D65 -> CIELAB (`L*`, `a*`, `b*`).
   - Mask out glare (`L* > 92` or `R/G/B >= 248`) and shadow/hair (`L* < 15` or `R/G/B <= 15`).
   - Require `validSkinPixelRatio >= 0.35`, else mark region `state: "unavailable"`.
   - Compute `meanLStar`, `meanAStar`, `meanBStar`, `erythemaIndex`, `melaninIndexProxy`, `elevatedRednessAreaFraction` (`a* - median_a* >= 3.0`), `darkSpotContrastAreaFraction` (`p75_L* - L* >= 6.0`), and `darkSpotContrastDeltaL`.
3. Persist `colorimetry.json` via `TrueDepthCaptureManager.saveSessionColorimetry(...)` (using `JSONSerialization.isValidJSONObject` + `.completeFileProtection`); if saving fails or `facialAlignment.regions` is missing, return `state: "unavailable"` honestly.

- [ ] **Step 2: Wire `saveSessionColorimetry`, `listLocalSessions()` loading, and `runColorimetryAnalysis` in Swift, Web fallback, and `cameraBridge.ts`**

- `TrueDepthCaptureManager.swift`: add `saveSessionColorimetry(sessionId:colorimetry:)` and attach optional `colorimetry.json` as `json["colorimetryAnalysis"]` inside `listLocalSessions()`.
- `TrueDepthCameraPlugin.swift`: register `CAPPluginMethod(name: "runColorimetryAnalysis", returnType: CAPPluginReturnPromise)` and dispatch on `DispatchQueue.global(qos: .userInitiated)`.
- `web.ts`: return honest `state: 'unavailable'` when image/regions are absent (or run `computeRegionColorimetryFromRgba` if a data URL + regions exist; simplest honest web fallback is `state: 'unavailable'` noting native iOS full-res sRGB analysis).
- `cameraBridge.ts`: expose `runColorimetryAnalysis(sessionId: string)`.

- [ ] **Step 3: Verify tests, TypeScript check, and Vite build**

Run: `npm test && npm run typecheck && npx vite build --configLoader runner`
Expected: PASS, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add plugins/truedepth-camera/ src/services/cameraBridge.ts README.md
git commit -m "feat(m3): add Swift CIELAB colorimetry analyzer and colorimetry.json local persistence"
```

---

### Task 4: UI Integration in `BlemishInspector`, `BeforeAfterViewer`, and `App.tsx`

**Files:**
- Modify: `src/components/BlemishInspector.tsx`
- Modify: `src/components/BeforeAfterViewer.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `cameraBridge.runColorimetryAnalysis`, `compareColorimetryAnalyses`, `ColorimetryAnalysisRecord`.
- Produces:
  - Per-session **Run Redness & Spots Analysis** button + **Redness & Dark-Spot Appearance Summary** table inside `BlemishInspector.tsx` (kept visually separate from active blemish counts, with explicit non-clinical appearance proxy wording).
  - Color-consistency-gated **Redness & Dark-Spot Longitudinal Comparison** panel inside `BeforeAfterViewer.tsx` showing `Δa*`, `ΔRedness Area`, `ΔDark-Spot Area`, `ΔContrast (L*)`, and directional state (`no_clear_change` / `decreased_appearance` / `increased_appearance` / `not_comparable` / `not_analyzed`).
  - Updated session card status badges in `App.tsx` reflecting both blemish analysis and colorimetry analysis states cleanly.

- [ ] **Step 1: Add Redness & Spots Analysis controls + table in `BlemishInspector.tsx`**

- Pass `onColorimetrySaved(sessionId, record)` prop from `App.tsx`.
- Add **Run Redness & Spots (CIELAB)** button alongside **Run On-Device Core ML**.
- Display a separate **Redness & Dark-Spot Appearance (CIELAB)** table (`Forehead`, `L Cheek`, `R Cheek`, `Chin`):
  - `Valid Skin %`, `Redness (a* / EI)`, `Patchy Redness %`, `Dark-Spot Area %`, `Spot Contrast (ΔL*)`.
  - Any region with `state === 'unavailable'` shows `Unavailable` (never `0`).
  - Include clear caption: `"Optical appearance proxies computed on sRGB skin pixels — not physiological melanin concentration or clinical severity."`

- [ ] **Step 2: Add Color-Consistency-Gated Comparison Panel in `BeforeAfterViewer.tsx`**

- Compute `colorimetryComparison = compareColorimetryAnalyses(baseline, current, comparison)`.
- Render dedicated **Redness & Dark-Spot Comparison** card:
  - `not_analyzed` -> prompt to run Redness & Spots on both sessions.
  - `not_comparable` -> show exact color-consistency refusal reasons (e.g., `EV shifted by 0.92 stops; color limit ≤ 0.75 EV` or `WB shifted`) with **zero numeric deltas**.
  - `measured` -> render per-region table with `Redness Δa* / Area`, `Dark-Spot Area / Contrast`, and `Status` (`no_clear_change` / `decreased_appearance` / `increased_appearance`), using friendly region labels (`Forehead`, `Left Cheek`, `Right Cheek`, `Chin`).

- [ ] **Step 3: Wire `onColorimetrySaved` and defensive badges in `App.tsx`**

- Update `App.tsx` session card badge to show separate badges for Blemishes (`measured` / `not_analyzed`) and Colorimetry (`measured` / `not_analyzed`), guarding `(regions ?? [])` safely.

- [ ] **Step 4: Verify full suite (`npm test && npm run typecheck && npx vite build --configLoader runner`)**

Run: `npm test && npm run typecheck && npx vite build --configLoader runner`
Expected: All tests PASS, 0 TS errors, clean Vite build.

- [ ] **Step 5: Commit**

```bash
git add src/components/BlemishInspector.tsx src/components/BeforeAfterViewer.tsx src/App.tsx
git commit -m "feat(m3): add redness and dark-spot appearance UI and color-gated longitudinal deltas"
```

---

## Self-Review Checklist (Completed)

1. **Spec coverage**: Covers M3 handoff requirements (§4.3, §5, §6, §8 M3 gate), `specs/truedepth-skin-analysis-research.md` color-clinical decoupling rules (`b*` diagnostic-only, strict EV/WB/distance gate, skin-tone-adaptive within-ROI baselines), and both real-hardware M2 fixes from `docs/inspect-annotate-report-result.json`.
2. **Step scan**: Every task names exact files, function signatures, thresholds, test cases, and commands with zero vague placeholders.
3. **Type consistency**: `RegionColorimetryMetrics`, `ColorimetryAnalysisRecord`, `runColorimetryAnalysis`, `compareColorimetryAnalyses`, and `colorimetryAnalysis` match identically across Tasks 2–4.
4. **Review Focus**: All 5 failure modes (glare/shadow exclusion, stricter EV/WB/distance color gate, cross-skin-tone invariance, noise-floor labeling, legacy session backward compatibility) have explicit unit tests in Task 2.
5. **Proportion**: Compact, interface-focused 4-task plan with clear TDD boundaries.
