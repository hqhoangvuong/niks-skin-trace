# M4 Physical-Device Validation Protocol (`m4-repeatability-v1`)

**Purpose:** Measure real-world repeatability and false-change rates across **Variant A (RGB unguided)**, **Variant B (2D RGB guided)**, and **Variant C (2D RGB guided + TrueDepth)** on unchanged skin, verify appropriate refusal on non-comparable perturbations, and establish an honest longitudinal baseline.

> **Evidence boundary:** Provisional release thresholds (`provisional_pilot_thresholds`) are documented in `src/services/validationMetrics.ts` (`DEFAULT_M4_THRESHOLDS`). Until locked on a separate calibration set and re-verified on a physical **iPhone 16 Pro**, results collected on iPhone 12 (`iPhone13,2`) validate pipeline engineering only and must be labeled accordingly.

---

## 1. Pre-Flight Checklist

- [ ] Latest `main` pulled on macOS, built (`npm run build`), and synced (`npx cap sync ios`) with automatic **iOS 18.0** target enforcement.
- [ ] Core ML blemish model (`BlemishDetector.mlpackage` + `blemish_model_manifest.json`) bundled in the Xcode `App` target (see `scripts/export-coreml-blemish-model.py`).
- [ ] Colorimetry analyzer running `cielab-roi-srgb-v2` (2D illumination-plane detrending + `3.0pp` noise floor).
- [ ] Consistent indoor lighting spot (avoid direct harsh window glare or shifting overhead color temperature).
- [ ] Clean face (no makeup, beauty filters, or glasses), neutral relaxed expression.

---

## 2. Experiment 1 — Same-Session Repeatability Pilot (Unchanged Skin, 15 Captures)

Keep the exact same lighting location and `Capture View = Front`. **Lower your arm and reset your stance between every single shot** so the test measures genuine re-positioning repeatability rather than burst photos.

1. **Variant A — `rgb_unguided` (5 shots)**
   - Select `Variant A: RGB Unguided Baseline` in **Capture Lab**.
   - Open Live Guided Camera. Confirm the viewfinder shows **no guide oval, no ghost overlay, no live metrics, and no green/yellow coaching prompts** (`liveGuidanceAtShutter` is still recorded silently).
   - Take **5** natural front-facing selfies, resetting your hand between each shot.
2. **Variant B — `rgb_guided` (5 shots)**
   - Select `Variant B: RGB Guided (No Depth)`.
   - Open Live Guided Camera. Follow the 2D oval, yaw/roll/sharpness/expression guidance, and translucent ghost overlay (**no TrueDepth distance prompts**).
   - Take **5** shots when the guide turns green, resetting your hand between each shot.
3. **Variant C — `rgb_depth_guided` (5 shots)**
   - Select `Variant C: RGB + TrueDepth Guided` with the `22–34 cm` calibrated preset.
   - Open Live Guided Camera. Follow both the 2D framing/pose cues and the live TrueDepth distance range (`22–34 cm`).
   - Take **5** shots when all checks turn green, resetting your hand between each shot.
4. **Analyze & Score in Validation Lab (M4)**
   - Switch to the **Validation Lab (M4)** tab.
   - Confirm **Capture View = Front**, **Physical Device** matches your iPhone, and **Cohort Scope = Today only** (or **Custom shot checkboxes** if other captures exist from today).
   - Tap **Batch Analyze Cohort** so all 15 shots run through the exact same Core ML blemish model and `cielab-roi-srgb-v2` colorimetry analyzer.
   - Inspect:
     - **TrueDepth Value Verdict (§7.4)** and **Provisional Release Gates**
     - **Variant A vs B vs C Repeatability Matrix** (Inter-Eye CV%, Yaw SD, Geometric/Color Comparability Rates, Active Blemish Count SD, Raw vs `mm²` Lesion Area CV%, Redness & Dark-Spot False-Change Rates)
   - Tap **Copy M4 Report (Markdown)** (and optionally **Copy M4 Report (JSON)**) to save your pilot results locally.

### Provisional Pilot Thresholds (`DEFAULT_M4_THRESHOLDS`)

| Gate | Provisional Threshold |
| --- | --- |
| Minimum captures per evaluated variant (B & C) | `n ≥ 5` |
| Geometric comparability pair rate | `≥ 80%` |
| Color-consistency comparability pair rate | `≥ 80%` |
| Framing scale stability (Inter-Eye CV%) | `≤ 5.0%` |
| Head yaw stability (SD) | `≤ 4.0°` |
| Redness false-change region rate (unchanged skin) | `≤ 10%` |
| Dark-spot false-change region rate (unchanged skin) | `≤ 10%` |
| TrueDepth benefit margin vs Variant B | `≥ 15%` relative reduction in scale CV%, yaw SD, or within-C `mm²` vs raw area CV%, or `+10pp` color comparability gain |

---

## 3. Experiment 2 — Controlled Perturbation & Appropriate Refusal Audit (3–4 Captures)

Goal: Verify the app **refuses to compare** (`not_comparable`) instead of fabricating a skin change when capture conditions break (§7.2).

Take 3–4 Variant C captures right after Experiment 1, changing **one factor per shot**:
1. **Distance perturbation:** Hold the phone ~10 cm farther away (`> 6 cm` shift vs Experiment 1).
2. **Pose perturbation:** Turn your head ~20–25° sideways (`> 15°` yaw shift).
3. **Exposure perturbation:** Turn off your main light or face away from the lamp (`> 0.75 EV` color shift / `> 1.5 EV` geometric shift).
4. **White-balance perturbation (optional):** Switch to a noticeably warmer or cooler bulb (`|ΔWB| > 0.20`).

Verify in **Timeline & Compare** (comparing each perturbed shot against a clean Experiment 1 Variant C baseline):
- Distance (`> 6 cm`) and yaw (`> 15°`) trigger M1 `not_comparable`.
- Moderate distance (`4–6 cm`), EV (`0.75–1.5 EV`), or WB (`0.20–0.35`) trigger M3 colorimetry `not_comparable` while explaining the exact physical delta.
- In **Validation Lab (M4)** (with Custom checkboxes including the perturbation shots), confirm the **Refusal Reason Audit** chips accurately categorize each refusal. Exclude the perturbation shots again before exporting the unchanged-skin repeatability report.

---

## 4. Experiment 3 — Personal Multi-Day Longitudinal Log (7–14 Days)

1. Capture **1 Variant C** (`front`, plus optional `left_cheek` / `right_cheek`) photo per day at roughly the same time and lighting spot.
2. Run Core ML + CIELAB analysis (via Inspect/Annotate or **Batch Analyze Cohort**).
3. Review **Section 4 — Longitudinal Multi-Day Trajectory** in **Validation Lab (M4)**:
   - Confirm non-comparable lighting/distance days are flagged `not_comparable` rather than silently blended into a trend.
   - Track active blemishes, physical lesion area (`mm²`), mean `a*`, elevated redness %, and dark-spot contrast % separately — do not reduce them into a composite "skin health" score.

---

## 5. Final iPhone 16 Pro Hardware Sign-Off

Once Developer Mode is enabled on your physical **iPhone 16 Pro** (`iPhone17,1`):
- [ ] Run **Probe Hardware Capabilities** in **Capture Lab** and record actual supported RGB + TrueDepth formats, depth accuracy/quality, and calibration tables in `specs/m0-device-capability-report.template.md`.
- [ ] Repeat **Experiment 1** (15 shots: 5×A, 5×B, 5×C) and **Experiment 2** (perturbation refusals) on iPhone 16 Pro.
- [ ] Export the M4 Markdown report and verify the header reports `Verified on target hardware` for **iPhone 16 Pro**.
