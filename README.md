# Skin Trace

Personal visual skincare progress tracker targeting **iPhone 16 Pro**, focused first on **acne and blemishes**, with **dark spots** and **redness** staged next.

Built as a **hybrid app**:
- **Web UI**: Vite + React + TypeScript (also runs in a standard browser for rapid UI iteration and RGB-only baselines).
- **Native iOS Camera Bridge**: Local Capacitor Swift plugin (`plugins/truedepth-camera`) using `AVFoundation` to probe and capture paired front RGB + TrueDepth depth data on a physical iPhone 16 Pro.

> **Current Status: M0–M4 Implemented (Physical iPhone 12 `iPhone13,2` verified for M0–M3; M4 Validation Lab & physical iPhone 16 Pro sign-off ready)**  
> Built end-to-end with paired 12 MP RGB + TrueDepth capture, live quality gating & ghost overlay (M1), on-device Core ML blemish detection & manual inspection/annotation (M2), CIELAB 2D illumination-detrended redness & dark-spot contrast metrics (M3), and the Variant A/B/C repeatability & longitudinal **Validation Lab** (M4). All facial images remain strictly local on-device, and no detections or composite "skin health" scores are fabricated.

## Milestone Overview

| Milestone | Scope | Verification Status |
| --- | --- | --- |
| **M0: Camera Feasibility** | Dynamic front RGB + TrueDepth format probe, paired capture, local file-protected storage | Verified on physical iPhone 12 (`iPhone13,2`, iOS 26.5.2); iPhone 16 Pro pending Developer Mode |
| **M1: Progress Journal** | Live synchronized RGB + TrueDepth guidance, sharpness/pose/expression gates, ghost overlay, aligned Before/After viewer | Verified on physical iPhone 12 |
| **M2: Blemish Analysis** | Decoupled `analysis.json`, on-device Core ML YOLO detector + manual annotation, TrueDepth `mm²` lesion area, spatial lesion tracking | Verified on physical iPhone 12 (`163 ms` warm inference) |
| **M3: Spots & Redness** | Deterministic sRGB D65 → CIELAB (`cielab-roi-srgb-v2`) with 2D illumination-plane detrending, glare/shadow masking, strict EV/WB/scale gate, `3.0pp` noise floor | Verified on physical iPhone 12 (`v1` tested; `v2` detrending ready for device check) |
| **M4: Longitudinal Validation** | Isolated Variant A/B/C repeatability engine, provisional release thresholds, TrueDepth keep/optional verdict, batch analyzer, multi-day trajectory & Markdown/JSON report export | Unit-tested locally (`npm test`); ready for 15-shot iPhone 12 pilot & iPhone 16 Pro sign-off |

## Authoritative Planning Docs

- [Product & Technical Handoff](docs/skincare-iphone16pro-handoff.md)
- [TrueDepth & RGB Skin Analysis Research](specs/truedepth-skin-analysis-research.md)
- [Architecture Decisions (ADRs)](specs/architecture-decisions.md)
- [M0 Device Capability Report Template](specs/m0-device-capability-report.template.md)
- [M2 Model Evaluation Protocol](specs/m2-model-evaluation-protocol.md)
- [M4 Physical-Device Validation Protocol](specs/m4-validation-protocol.md)
- [Agent & Engineering Rules](AGENTS.md)

## Repository Layout

```text
skin-trace/
├── AGENTS.md                           # Engineering guardrails & non-negotiables
├── capacitor.config.ts                 # Capacitor app config (com.hikarimoon.skintrace)
├── package.json                        # Root Vite/React/Capacitor workspace + iOS 18 sync hook
├── scripts/
│   ├── export-coreml-blemish-model.py  # macOS YOLO -> Core ML .mlpackage exporter
│   ├── run-tests.mjs                   # Zero-dependency Node test runner (npm test)
│   └── sync-ios-deployment-target.mjs  # Enforces iOS 18.0 across App + Pods on `cap sync ios`
├── src/                                # Web UI (Capture Lab, Timeline & Compare, Validation Lab)
│   ├── types/domain.ts                 # CaptureSession, QualityAssessment, AnalysisResult, ComparisonRecord
│   ├── services/
│   │   ├── alignment.ts                # 2D facial landmark similarity alignment
│   │   ├── blemishMetrics.ts           # M2 active/residual lesion metrics & spatial tracking
│   │   ├── cameraBridge.ts             # Typed bridge to TrueDepthCamera plugin
│   │   ├── colorimetryMetrics.ts       # M3 CIELAB v2 redness & dark-spot contrast metrics
│   │   ├── comparison.ts               # M1/M3 longitudinal comparability gate
│   │   └── validationMetrics.ts        # M4 Variant A/B/C repeatability, TrueDepth verdict & report engine
│   ├── components/
│   │   ├── BeforeAfterViewer.tsx       # Timeline, zoom/pan split viewer, blemish & colorimetry deltas
│   │   ├── BlemishInspector.tsx        # Inspect/annotate lesions & run Core ML / CIELAB
│   │   └── ValidationLab.tsx           # M4 cohort selector, batch analyzer, A/B/C matrix & report export
│   └── App.tsx
├── plugins/
│   └── truedepth-camera/               # Local Capacitor plugin (TS contract + web fallback + iOS Swift)
│       ├── Package.swift               # Swift Package Manager manifest (Capacitor 7, iOS 18)
│       ├── SkinTraceTruedepthCamera.podspec
│       ├── src/                        # TypeScript definitions & honest web fallback
│       └── ios/Sources/TrueDepthCameraPlugin/
│           ├── TrueDepthBlemishAnalyzer.swift
│           ├── TrueDepthCameraPlugin.swift
│           ├── TrueDepthDeviceInspector.swift
│           ├── TrueDepthCaptureManager.swift
│           ├── TrueDepthColorimetryAnalyzer.swift
│           ├── TrueDepthGuidanceEvaluator.swift
│           ├── TrueDepthLandmarkAligner.swift
│           └── TrueDepthLiveCameraViewController.swift
├── docs/
│   └── skincare-iphone16pro-handoff.md
└── specs/
    ├── architecture-decisions.md
    ├── m0-device-capability-report.template.md
    ├── m2-model-evaluation-protocol.md
    ├── m4-validation-protocol.md
    ├── plans/
    └── truedepth-skin-analysis-research.md
```

## Development Workflow (Author on Linux/WSL -> Build & Sign on Mac)

### 1. Initialize Git & Install Web Dependencies (Linux/WSL or Mac)

```bash
git init
npm install
npm run dev
```

In a desktop browser, `TrueDepthCamera` automatically runs the web fallback (`platform: "web"`, `trueDepthSupported: false`) so you can develop the UI without faking depth telemetry.

### 2. Generate & Open the iOS Xcode Project (macOS with Xcode 16+)

Run these commands on your Mac after cloning or pulling the repo:

```bash
npm install
npm run build
npx cap add ios
```

Add camera usage permission to `ios/App/App/Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>Skin Trace captures front-camera color photos and TrueDepth distance data locally on your iPhone to help align skincare progress photos.</string>
```

Sync and open in Xcode:

```bash
npx cap sync ios
npx cap open ios
```

In Xcode:
1. Select the `App` target -> **Signing & Capabilities** -> pick your Apple Account (Personal Team works for free) and confirm the Bundle Identifier is `com.hikarimoon.skintrace`.
2. Confirm Deployment Target is **iOS 18.0** (matching `Package.swift`).
3. Connect a **physical iPhone 16 Pro** (the iOS Simulator cannot validate TrueDepth).
4. Build and run, then run **Probe Hardware Capabilities** and **Capture Paired Photo** in the M0 Capture Lab.
5. Record the actual output in a copy of [specs/m0-device-capability-report.template.md](specs/m0-device-capability-report.template.md).

## Core Principles

1. **RGB is primary; TrueDepth is supporting**: Color imagery drives skin appearance analysis; depth is evaluated for distance guidance and geometric alignment.
2. **Prove repeatability before claiming progress**: Compare unguided RGB (Variant A), guided RGB (Variant B), and guided RGB + TrueDepth (Variant C).
3. **Never fabricate AI outputs**: Separate `not_analyzed`, `unavailable`, and `not_comparable` from a measured `0`.
4. **Local-first facial privacy**: Original photos and depth payloads stay in local app storage with iOS file protection enabled; no network upload is performed in the prototype.
