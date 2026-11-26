# Skincare Progress Tracking — Development Handoff

**Prepared:** 26 November 2026  
**Target hardware:** iPhone 16 Pro  
**Status:** Product and technical planning; no application code, trained model, dataset, or device benchmark was supplied or produced in this discussion.  
**Audience:** The developer or AI agent continuing the project.

## 1. Product goal and confirmed requirements

Build a skincare support app that compares a user's face photographs over time and helps them understand visible changes.

| Item | Status | Detail |
| --- | --- | --- |
| Initial hardware target | Confirmed by user | iPhone 16 Pro. |
| Primary concern | Confirmed by user | Acne and blemishes. |
| Additional concerns | Confirmed by user | Dark spots and redness. |
| Time-based comparison | Confirmed by user | Compare day-to-day face images to identify possible improvement. |
| Local AI | Requested direction | The discussion began with running image analysis using the phone's local compute. Keep on-device analysis as the prototype direction. |
| TrueDepth | Requested investigation | Determine whether its data can improve detection/comparison results. No improvement has been demonstrated yet. |
| Website versus installed app | Open architecture decision | The original concept was a website. Direct TrueDepth access requires native iOS camera code; the user has not explicitly selected a native UI framework. |

**Proposed product interpretation:** a personal visual progress tracker with separate measurements for each concern. Allow daily capture while emphasizing comparable baseline and longer-term trends. Do not assume every day must produce an improvement/worsening verdict.

Useful outcomes include “fewer visible blemishes in this region,” “no clear change,” and “these photographs are not comparable.” Photos alone do not establish that a skincare product caused a change.

## 2. Main technical conclusion

Use the **color photograph as the main input for skin analysis** and **TrueDepth as a supporting input for capture guidance and spatial alignment**.

The first prototype should test whether depth reduces false changes caused by inconsistent camera distance or face positioning. A neural network that jointly processes RGB and depth is a later experiment, not a prerequisite.

| Input or capability | Proposed use | Boundary |
| --- | --- | --- |
| Front RGB camera | Detect visible blemishes; measure appearance of spots and redness | Lighting, exposure, focus, and image processing affect the result. |
| TrueDepth depth map | Estimate face-to-camera distance; assist geometric alignment and capture quality checks | It does not directly measure pigmentation or redness. Its usefulness for small lesion geometry is unproven. |
| Facial landmarks | Locate cheeks, forehead, chin, and other repeatable regions | Landmarks are not a blemish detector. |
| ARKit face mesh | Optional coarse face pose/geometry support | Apple describes this as a coarse mesh; it is not a scan of pores or individual pimples. |
| Specialized skin model | Detect or segment defined visible features | Requires suitable model weights, training data, and validation. None have been selected. |
| General image embeddings | Potential auxiliary research tool | A generic similarity score is insufficient to determine skincare improvement. |

The iPhone 16 Pro has a 12MP front color camera with autofocus. This is not a 12MP depth sensor. Query actual supported RGB/depth format combinations on the device; do not assume the maximum still-photo resolution is available in every depth-enabled capture configuration. [S1–S4]

TrueDepth can provide metric depth. The `AVDepthData.Accuracy.absolute` classification describes the meaning of the values; it is not a guarantee of submillimeter precision or reliable pimple-height measurement. [S2]

## 3. Platform decision

| Approach | TrueDepth access | Assessment |
| --- | --- | --- |
| Safari website or installed PWA | No direct standard TrueDepth capture API | Suitable for RGB-only image analysis and an early web prototype. Does not satisfy direct depth capture. |
| Native iOS application | Through AVFoundation; ARKit offers related face-tracking capabilities | Recommended for the iPhone 16 Pro depth experiment. |
| Hybrid app with a web interface | Through a custom native camera component/bridge | Viable if preserving web UI is important. Installing a web wrapper alone does not expose depth. |

Browser support was researched during this discussion. Safari lacks the relevant WebXR depth-sensing support, and the older Media Capture Depth Stream Extensions proposal was discontinued. Recheck current support before implementation rather than treating browser limitations as permanent. [S5–S6]

**Recommended prototype stack, not a confirmed user selection:**

- Swift/SwiftUI for the smallest native hardware prototype.
- AVFoundation for capture and associated depth data.
- Vision or another validated landmark implementation for face regions and positioning.
- Core ML for on-device inference with a compatible specialized model.
- Local storage for captures, metadata, and measurements.
- Optional ASP.NET Core backend later for accounts, routine logs, and explicit synchronization. A backend is not required for the first capture/inference experiment.

Core ML can schedule work on the CPU, GPU, and Neural Engine. Actual placement depends on the model, supported operations, configuration, and runtime; do not promise that all inference runs on the Neural Engine. [S7]

## 4. Proposed capture and processing workflow

### 4.1 Guide a repeatable capture

1. Obtain camera permission and explain what will be captured and retained.
2. Detect a single face and display a positioning guide plus an optional previous-photo overlay.
3. Use depth to guide distance; use landmarks/pose estimates to guide orientation and neutral expression.
4. Check blur, exposure, strong shadows, occlusions, face coverage, and depth availability/validity.
5. Ask for a retake when conditions are unsuitable. Do not generate a progress score from a failed capture.
6. Capture the original color image and associated depth/metadata when supported.
7. Keep preview mirroring separate from stored image coordinates so left/right regions remain consistent.

Proposed views are front, left cheek, and right cheek. These are separate guided views of the same capture session, not a promised complete 3D skin reconstruction. Final angles, target distance, and quality thresholds must come from a device pilot.

Capture guidance should encourage the same device and lens, a consistent light source and position, a neutral expression, and similar conditions without makeup or beauty filters. Stabilize focus/exposure/white balance where supported and appropriate; locking settings is not a substitute for controlling illumination. Do not blindly reuse settings when the lighting changes.

### 4.2 Capture paired data correctly

The AVFoundation implementation should investigate:

- `AVCaptureDevice` with `.builtInTrueDepthCamera` and front position.
- `AVCapturePhotoOutput`, checking `isDepthDataDeliverySupported` before enabling depth delivery.
- Per-photo `AVCapturePhotoSettings.isDepthDataDeliveryEnabled` and the returned `AVCapturePhoto.depthData`.
- For live guidance, `AVCaptureDepthDataOutput` and `AVCaptureVideoDataOutput`, paired with `AVCaptureDataOutputSynchronizer` when consuming both streams.
- `supportedDepthDataFormats` and a compatible `activeDepthDataFormat`; record the actual selected dimensions, pixel format, frame rate, and depth/disparity representation.

Apple provides both still-photo and streaming examples. Begin with its supported capture patterns and verify them on a physical iPhone 16 Pro. A simulator cannot validate TrueDepth behavior. [S2–S3, S8]

Handle missing or invalid depth explicitly. If RGB-only capture is allowed, record that mode and apply its own comparison eligibility rules; do not silently treat it as a depth-assisted capture.

### 4.3 Align comparable regions

- Preserve the original color image; create derived images for inference/display.
- Normalize orientation and coordinate conventions consistently.
- Align the same facial regions across sessions using landmarks, with depth-assisted geometry where it proves useful.
- Account for the different RGB/depth resolutions, calibration, and lens distortion when reconstructing or comparing 3D coordinates. Apple notes that `AVDepthData` may require rectification with `cameraCalibrationData` for computer-vision geometry. [S9]
- Exclude eyes, lips, hair, and occlusions as appropriate for each metric. Use a consistent valid-skin denominator for area measurements.
- Avoid aggressive color normalization that could remove the redness or spot change being measured. Evaluate any correction on known unchanged and changed samples.

ARKit is optional. Do not assume an ARKit session and an independent AVFoundation session can concurrently own the front camera. If ARKit is introduced, explicitly validate session handoff, frame resolution, and image/depth pairing. The initial AVFoundation pipeline can proceed without ARKit.

### 4.4 Analyze and compare

1. Run a specialized model on the accepted color image or suitable facial-region crops.
2. Preserve enough image detail for small blemishes; choose preprocessing resolution through evaluation rather than an arbitrary full-face thumbnail.
3. Produce separate measurements for acne/blemishes, dark spots, and redness.
4. Compare only eligible, sufficiently aligned regions using compatible model and preprocessing versions.
5. Distinguish measured changes from capture or inference uncertainty.
6. Show aligned photographs and highlighted regions so the user can inspect the evidence.

## 5. Measurement definitions and model requirements

| Concern | Initial candidate outputs | Required qualification |
| --- | --- | --- |
| Acne/blemishes | Estimated visible lesion count and affected image area per facial region | Define which lesion classes are included with annotation expertise. Model confidence is not clinical severity. |
| Individual lesion tracking | Candidate new, persisting, or no-longer-detected lesions | Only report when spatial association is reliable. A missed detection is not proof of healing. |
| Dark spots | Tracked region area and color contrast under comparable capture conditions | Report appearance change, not a physiological melanin concentration. |
| Redness | Relative color/affected-area proxy in consistently defined regions | Requires controlled or validated color handling and testing across skin tones. Depth does not solve color calibration. |

Keep active blemishes and residual dark/red marks distinct in the proposed annotation scheme. The same location can change category over time; do not automatically count every persistent mark as active acne.

Avoid a single overall “skin health” or “beauty” score in the MVP. Do not invent a percentage improvement from an embedding distance. In particular, an arbitrary similarity of 0.8 does not mean “80% improved.”

Published work demonstrates that smartphone acne detection/grading is possible, but it does not validate this app, this model, or small longitudinal changes on this device. [S10]

**No production model has been chosen.** The next developer must assess:

- Availability and commercial-use rights for model weights and training data.
- Whether images resemble the intended front-camera capture conditions.
- Annotation quality and coverage of acne, residual marks, skin tones, facial hair, and relevant capture conditions.
- Per-class precision/recall, count error, and performance on new users.
- Compatibility and output stability after conversion/optimization for Core ML.
- Device latency, peak memory, energy use, and behavior during repeated captures.

Training or fine-tuning occurs separately from phone inference. If a suitable model is unavailable, deliver the capture/comparison workflow with manual annotations or explicitly labeled research outputs. Never fabricate detections to make the UI appear complete.

## 6. Proposed stored data

This is a conceptual model, not a committed database schema.

| Entity | Suggested fields |
| --- | --- |
| Capture session | ID; local capture time and timezone; device model; OS version; camera/lens; view; capture mode; original image reference; optional depth reference; image orientation/mirroring; actual image/depth dimensions and formats; calibration metadata; relevant exposure/white-balance metadata where available. |
| Quality assessment | Capture/session ID; quality-algorithm version; blur/exposure/pose/distance checks; depth validity; acceptance state; human-readable rejection reasons. |
| Analysis result | Session ID; model and preprocessing versions; metric-definition version; valid-region masks; candidate lesions/classes/coordinates; confidence; region measurements; computation time. |
| Comparison | Baseline/current session IDs; matching views/regions; alignment quality; comparability state; metric deltas; uncertainty/decision rule; explanation and evidence references. |

Represent “unavailable,” “not comparable,” and “not analyzed” separately from a measured zero. Preserve metric/model versions; reanalyze both sides consistently or declare the comparison incompatible after a model change.

Store originals locally by default for the proposed prototype, with platform data protection appropriate to facial images. Make export, backup, deletion, and any cloud synchronization explicit product decisions. On-device processing does not itself define retention or backup behavior.

## 7. Validation plan: prove repeatability before claiming progress

### 7.1 Physical-device capability experiment

On a real iPhone 16 Pro, report supported and actually working RGB/depth combinations, still-photo pairing, live guidance behavior, calibration availability, failure modes, and performance. Record the exact OS/device/model versions used.

Do not infer detailed skin-measurement accuracy from Face ID functionality, image megapixels, or an absolute depth flag.

### 7.2 Compare three capture variants

| Variant | Purpose |
| --- | --- |
| A: RGB without capture guidance | Establish the variability of a basic selfie flow. |
| B: RGB with 2D positioning and quality guidance | Measure the value of guidance alone. |
| C: RGB with the same guidance plus TrueDepth support | Measure the incremental value of depth. |

Take repeated images of unchanged skin within the same session. Include controlled variations in distance, angle, expression, and lighting. Evaluate repeatability and false improvement/worsening reports, including cases where the system appropriately refuses to compare.

Use the same analysis model and comparable test conditions across variants. A comparison of A versus C alone would conflate depth with the benefit of basic guidance.

### 7.3 Longitudinal evaluation

- Collect appropriately consented repeat captures over time with expert-reviewed labels for the target metrics.
- Keep every image of a participant within one training/validation/test partition to prevent identity leakage.
- Evaluate lesion detection/counting and change detection separately. A good single-image detector may still be an unreliable progress tracker.
- Report performance across skin tones and relevant capture conditions, including failures and rejected captures. Validate the initial device target before claiming support for other phones.
- Measure false-change rate, repeatability, count/area error, alignment error, and agreement with expert-reviewed change labels.
- Set numerical release thresholds before the final evaluation, using a separate pilot/calibration set. No defensible numerical thresholds have yet been established.

Camera angle/distance can change recorded skin color. Dermatology guidance also emphasizes image quality, device differences, and skin-tone performance. These are central validation variables for this product. [S11–S12]

### 7.4 Decision about TrueDepth

Keep depth in the product if it offers a demonstrated improvement in repeatability, comparison eligibility, or user capture success that justifies its complexity. If it does not outperform well-guided RGB capture, retain it as optional or remove it from the required path.

Pimple height/volume, pore depth, and other fine surface measurements remain research questions. They need physical measurement validation before becoming product features.

## 8. Suggested delivery milestones

| Milestone | Deliverable | Completion gate |
| --- | --- | --- |
| M0: Camera feasibility | Minimal native RGB + depth capture experiment and device capability report | Reproducible paired capture on the target phone; actual formats and failure behavior documented. |
| M1: Progress journal | Guided capture, quality feedback, local timeline, aligned before/after viewer | Repeatable capture and correct region/orientation handling without fabricated AI results. |
| M2: Blemish analysis | Licensed candidate model, region metrics, inspectable detections | Held-out evaluation and measured on-device performance; uncertainty states implemented. |
| M3: Spots and redness | Defined appearance metrics and color-consistency checks | Demonstrated repeatability and appropriate refusal on noncomparable images. |
| M4: Longitudinal validation | RGB-versus-depth experiment and longitudinal evaluation report | Explicit release thresholds met for the claims actually shown in the app. |

A routine diary, accounts, and synchronization can be added independently if selected. They should not block the initial capture experiment.

## 9. Acceptance checklist for the prototype

- [ ] Runs the camera experiment on a physical iPhone 16 Pro; simulated data is clearly marked.
- [ ] Requests and handles camera permission correctly, including denial/interruption.
- [ ] Records the actual selected capture formats instead of assuming fixed depth resolution.
- [ ] Pairs RGB/depth correctly and handles missing, invalid, or incompatible depth.
- [ ] Applies calibration and coordinate transforms appropriately for the geometry used.
- [ ] Preserves original images and consistent left/right orientation.
- [ ] Gives actionable retake guidance when capture quality is insufficient.
- [ ] Separates missing data from zero detections and low confidence from no change.
- [ ] Compares compatible views, regions, metric definitions, and model versions.
- [ ] Produces separate outputs for blemishes, spots, and redness where validated.
- [ ] Does not equate a generic similarity score with skincare improvement.
- [ ] Includes an RGB-only comparison baseline and an experiment isolating depth's contribution.
- [ ] Reports measurements, limitations, and device performance without claiming unperformed validation.
- [ ] Keeps images local unless an explicit export/synchronization flow is selected.

## 10. Open decisions and unresolved dependencies

1. **Application packaging:** native SwiftUI app or hybrid app with native capture? TrueDepth changes the original website-only direction.
2. **OS support:** minimum iOS version and the exact test OS are unspecified.
3. **Models/data:** no weights, dataset, annotation partner, or licensing arrangement exists in the supplied context.
4. **Initial breadth:** acne/blemishes are primary; dark spots/redness are requested, but can be staged after reliable capture.
5. **Capture protocol:** required views, lighting setup, target distance, and quality thresholds need a device pilot.
6. **Product claims:** define the exact visible-change wording and supporting evidence before presenting quantitative improvement claims.
7. **Retention and synchronization:** local history duration, export, backup, deletion, and optional server storage are not decided.
8. **Existing project:** no repository, app name, bundle identifier, UI designs, signing setup, or development environment was supplied.

These unknowns do not prevent a capture feasibility experiment. They do prevent claiming that a production-ready skin model or validated improvement score already exists.

## 11. Starting brief for the next developer or AI agent

> Continue this skincare progress-tracking project using this handoff. Confirmed targets are iPhone 16 Pro, acne/blemishes first, plus dark spots and redness, with a preference for local image analysis. The original website direction has an unresolved packaging choice because direct TrueDepth capture requires native iOS code.
>
> First inspect any supplied repository and its instructions. If no project exists, establish the application packaging and build/signing environment before choosing a scaffold. Start with M0: a physical-device AVFoundation experiment that captures paired RGB/depth, logs actual capabilities, and supports distance/position guidance. Do not begin with a large multimodal model or assume ARKit's face mesh contains blemish geometry.
>
> Separate capture quality, region alignment, skin inference, and longitudinal comparison. Keep images local for the prototype. Verify model/data suitability and licenses before integrating a detector. Compare guided RGB against the same workflow with depth to measure incremental benefit. Document what was implemented, what was tested on hardware, and what remains unverified. Do not invent detections, accuracy figures, or improvement scores.

## 12. Sources and evidence boundaries

Sources below were consulted during the planning discussion. They support platform capabilities and methodological concerns; none validates this proposed application. Recheck SDK APIs, browser support, and device behavior when implementation starts.

- **[S1] Apple — iPhone 16 Pro technical specifications.** Front camera, autofocus, and hardware capabilities.  
  <https://support.apple.com/en-us/121031>
- **[S2] Apple — Capturing photos with depth.** Native still-photo depth capture, supported formats, and depth/disparity semantics.  
  <https://developer.apple.com/documentation/avfoundation/capturing-photos-with-depth>
- **[S3] Apple — Enhancing live video by leveraging TrueDepth camera data.** RGB/depth synchronization and differences in image/depth resolution.  
  <https://developer.apple.com/documentation/avfoundation/enhancing-live-video-by-leveraging-truedepth-camera-data>
- **[S4] Apple — ARFaceAnchor.geometry.** Coarse facial mesh definition.  
  <https://developer.apple.com/documentation/arkit/arfaceanchor/geometry>
- **[S5] Web Platform DX — Web Features Explorer.** Browser implementation status, including depth sensing.  
  <https://web-platform-dx.github.io/web-features-explorer/only-in/chromium/>
- **[S6] W3C — Media Capture Depth Stream Extensions.** Discontinued draft; not an implemented cross-browser solution to rely on.  
  <https://www.w3.org/TR/mediacapture-depth/>
- **[S7] Apple — Core ML.** On-device model execution and available compute resources.  
  <https://developer.apple.com/documentation/coreml>
- **[S8] Apple — Streaming depth data from the TrueDepth camera.** Native capture example and requirement for physical-device testing.  
  <https://developer.apple.com/documentation/avfoundation/streaming-depth-data-from-the-truedepth-camera>
- **[S9] Apple — AVDepthData.** Depth data, calibration, and geometric rectification considerations.  
  <https://developer.apple.com/documentation/avfoundation/avdepthdata>
- **[S10] Seite et al., 2019 — Development and accuracy of an artificial intelligence algorithm for acne grading from smartphone photographs.** Research feasibility; not validation of this implementation.  
  <https://pubmed.ncbi.nlm.nih.gov/31446631/>
- **[S11] Cronin et al., 2023 — Effect of camera distance and angle on color of diverse skin tone-based standards in smartphone photos.** Evidence for capture geometry as a color-measurement confounder.  
  <https://pubmed.ncbi.nlm.nih.gov/36772956/>
- **[S12] EADV AI Task Force, 2024 — Position statement on AI-assisted smartphone apps and web-based services for skin disease.** Image quality and validation across devices and skin tones.  
  <https://onlinelibrary.wiley.com/doi/10.1111/jdv.19521>

