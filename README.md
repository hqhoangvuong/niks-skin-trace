# Skin Trace

Personal visual skincare progress tracker targeting **iPhone 16 Pro**, focused first on **acne and blemishes**, with **dark spots** and **redness** staged next.

Built as a **hybrid app**:
- **Web UI**: Vite + React + TypeScript (also runs in a standard browser for rapid UI iteration and RGB-only baselines).
- **Native iOS Camera Bridge**: Local Capacitor Swift plugin (`plugins/truedepth-camera`) using `AVFoundation` to probe and capture paired front RGB + TrueDepth depth data on a physical iPhone 16 Pro.

> **Current Milestone: M0 — Camera Feasibility**  
> This repository contains the M0 scaffold: device capability probing, paired RGB/depth capture bridge, local-only session storage, and honest status tracking. No skin analysis model is integrated yet, and no detections or improvement scores are fabricated.

## Authoritative Planning Docs

- [Product & Technical Handoff](docs/skincare-iphone16pro-handoff.md)
- [TrueDepth & RGB Skin Analysis Research](specs/truedepth-skin-analysis-research.md)
- [Architecture Decisions (ADRs)](specs/architecture-decisions.md)
- [M0 Device Capability Report Template](specs/m0-device-capability-report.template.md)
- [Agent & Engineering Rules](AGENTS.md)

## Repository Layout

```text
skin-trace/
├── AGENTS.md                           # Engineering guardrails & non-negotiables
├── capacitor.config.ts                 # Capacitor app config (com.hikarimoon.skintrace)
├── package.json                        # Root Vite/React/Capacitor workspace
├── src/                                # Web UI (M0 Capture Lab)
│   ├── types/domain.ts                 # CaptureSession, QualityAssessment, AnalysisResult, ComparisonRecord
│   ├── services/cameraBridge.ts        # Typed bridge to TrueDepthCamera plugin
│   └── App.tsx                         # M0 hardware probe, capture runner & session inspector
├── plugins/
│   └── truedepth-camera/               # Local Capacitor plugin (TS contract + web fallback + iOS Swift)
│       ├── Package.swift               # Swift Package Manager manifest (Capacitor 7)
│       ├── SkinTraceTruedepthCamera.podspec
│       ├── src/                        # TypeScript definitions & honest web fallback
│       └── ios/Sources/TrueDepthCameraPlugin/
│           ├── TrueDepthCameraPlugin.swift
│           ├── TrueDepthDeviceInspector.swift
│           ├── TrueDepthCaptureManager.swift
│           ├── TrueDepthGuidanceEvaluator.swift
│           ├── TrueDepthLandmarkAligner.swift
│           └── TrueDepthLiveCameraViewController.swift
├── docs/
│   └── skincare-iphone16pro-handoff.md
└── specs/
    ├── architecture-decisions.md
    ├── m0-device-capability-report.template.md
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
