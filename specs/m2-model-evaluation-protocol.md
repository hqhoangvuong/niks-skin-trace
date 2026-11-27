# M2 Blemish Model Licensing Audit & Evaluation Protocol

**Milestone:** M2 — Blemish Analysis  
**Target hardware:** iPhone 16 Pro (prototype tested on iPhone 12)  
**Status:** No commercial model weights bundled yet; manual ground-truth annotation and the manifest-gated Core ML ROI runner (`TrueDepthBlemishAnalyzer.swift`) are live.

---

## 1. Verified Dataset & Detector License Matrix

Never assume a community mirror's license tag (e.g., CC BY 4.0 on Roboflow or Hugging Face) overrides the original dataset authors' terms.

| Resource | Role | License / Terms | Commercial Product Viability |
| --- | --- | --- | --- |
| **ACNE04** (`1,457` images, `18,983` lesion boxes) | Acne counting & localization | **Academic / Non-Commercial Research Only** | **Not permitted** without written commercial clearance from original authors. Suitable only for internal research benchmarking (`licenseScope: "non_commercial_research_only"`). |
| **Fitzpatrick17k** (`16,577` clinical atlas images) | Skin-tone fairness evaluation | Research / educational; underlying images from third-party dermatology atlases | **Restricted** — do not bundle weights trained on uncleared atlas images into a commercial build. |
| **Ultralytics YOLOv8 / YOLOv11** | Object detector training framework | **AGPL-3.0** (or paid Ultralytics Enterprise license) | Requires AGPL compliance or paid enterprise license if deployed commercially. |
| **Permissive Detector Architectures** (e.g., `YOLOX`, `RT-DETR`, `NanoDet-Plus`, `torchvision MobileNetV3-SSD`, Apple **Create ML Object Detector**) | On-device Core ML detector backbone | **Apache-2.0 / MIT / Apple SDK** | **Recommended** for commercial deployment once trained on cleared/owned data. |
| **Skin Trace Manual Annotations** (`manual_annotation`) | User-authored pins exported locally | `user_authored` | Fully cleared for personal ground-truth tracking and user-consented evaluation. |

---

## 2. Required Lesion Taxonomy & Data Split Rules

1. **Active blemishes vs. residual marks (mandatory class split):**
   - **Active blemishes**: `comedone`, `papule_pustule`, `nodule_cyst`, `active_blemish_unspecified`.
   - **Residual marks (never counted as active acne)**: `residual_red_mark_pie` (post-inflammatory erythema), `residual_dark_spot_pih` (post-inflammatory hyperpigmentation).
2. **Participant-level disjoint splits:**
   - Every photograph of a participant must live in **exactly one** partition (`train`, `validation`, or `test`). Never split photos of the same person across train and test (prevents identity/skin-texture leakage).
3. **Front-camera domain match:**
   - Include smartphone front-camera crops matching Skin Trace's calibrated operating regime (`~22–34 cm`, `~0.10–0.12 mm/pixel`, indoor lighting, neutral expression) across diverse Fitzpatrick skin phototypes (I–VI) and facial hair.

---

## 3. Offline & Physical-Device Promotion Gate

A candidate model starts as `modelSource: "research_coreml_model"` and `licenseScope: "non_commercial_research_only"`. Before promoting to `validated_coreml_model` / `commercial_cleared`, record all of the following on a held-out participant-disjoint test set and on a physical **iPhone 16 Pro**:

- [ ] **Commercial license clearance** verified in writing for training data, labels, and detector architecture.
- [ ] **Single-image detection accuracy**: per-class precision, recall, F1, and lesion count MAE (reported overall and stratified by Fitzpatrick skin tone).
- [ ] **Repeatability on unchanged skin**: false-change rate across repeat Variant B vs. Variant C captures of the same person within one session.
- [ ] **Longitudinal change agreement**: agreement with expert-reviewed change labels (`fewer` / `no clear change` / `more`), evaluated separately from single-image precision/recall.
- [ ] **Core ML conversion stability**: output parity check between PyTorch/ONNX reference and converted `.mlpackage` (`float16` / `int8`).
- [ ] **Physical iPhone 16 Pro runtime benchmark** across 10 consecutive captures:
  - Per-session ROI inference latency (`computationTimeMs`)
  - Peak RSS memory (MB)
  - Thermal state / zero crashes or OOM kills

---

## 4. Personal Research Quickstart: Export & Bundle a Core ML Model on Mac

For **personal / non-commercial R&D**, run [scripts/export-coreml-blemish-model.py](../scripts/export-coreml-blemish-model.py) on your Mac to download `mufasabrownie/glowlytics-skin-models` (`acne_detector_best.pt`, YOLOv8s 640×640), inspect its class labels, and export both files required by `TrueDepthBlemishAnalyzer.swift`:

```bash
python3 -m venv .venv-ml
source .venv-ml/bin/activate
pip install --upgrade pip ultralytics coremltools huggingface_hub
python3 scripts/export-coreml-blemish-model.py
```

Then in Xcode (`npx cap open ios`):
1. Drag **`ml-export/BlemishDetector.mlpackage`** and **`ml-export/blemish_model_manifest.json`** into the `App/App` group.
2. Check **Copy items if needed** and **Add to targets: App** (confirm both appear under `App` → **Build Phases → Copy Bundle Resources**).
3. Clean (`Cmd + Shift + K`) and Run (`Cmd + R`) on your iPhone.
4. Open any session → **Inspect / Annotate** → **Run On-Device Core ML**.

## 5. Manual Bundling Reference (Any Custom Model)

`TrueDepthBlemishAnalyzer.swift` automatically activates when both files are present in **Copy Bundle Resources**:

1. **`BlemishDetector.mlpackage`** (Xcode compiles it to `BlemishDetector.mlmodelc` in the app bundle) — object detector outputting `VNRecognizedObjectObservation` (export with `nms=True` or Core ML NMS pipeline).
2. **`blemish_model_manifest.json`** declaring explicit provenance, class mapping, and thresholds:

```json
{
  "modelVersion": "acne-research-v0.1",
  "preprocessingVersion": "roi-crop-scaleFit-v1",
  "licenseScope": "non_commercial_research_only",
  "modelSource": "research_coreml_model",
  "classMap": {
    "comedone": "comedone",
    "papule": "papule_pustule",
    "pustule": "papule_pustule",
    "nodule": "nodule_cyst",
    "pie": "residual_red_mark_pie",
    "pih": "residual_dark_spot_pih"
  },
  "defaultConfidenceThreshold": 0.45,
  "defaultUncertainThreshold": 0.25
}
```

When either file is absent, `runCoreMLBlemishAnalysis` returns `state: "unavailable"` honestly and never fabricates detections.
