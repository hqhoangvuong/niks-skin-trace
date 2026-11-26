# Architecture Decisions

## ADR-001: Hybrid Packaging with Capacitor + Local Swift TrueDepth Plugin

- **Date**: 2026-11-26
- **Status**: Accepted
- **Context**: The original product concept was a web UI, while direct TrueDepth depth-map access on iPhone 16 Pro requires native `AVFoundation` APIs (`AVCaptureDevice.DeviceType.builtInTrueDepthCamera`, `AVCapturePhotoOutput.isDepthDataDeliverySupported`, `AVDepthData`). Safari lacks WebXR/Media Capture depth support.
- **Decision**: Use a **Capacitor** hybrid architecture:
  - **Web UI**: Vite + React + TypeScript at the repository root (`src/`).
  - **Native iOS bridge**: Local Capacitor Swift plugin in `plugins/truedepth-camera/` implementing `AVFoundation` hardware inspection, permission handling, paired RGB + depth photo capture, and protected local file persistence.
  - **Web fallback**: `plugins/truedepth-camera/src/web.ts` provides an explicit RGB-only/fallback implementation (`trueDepthSupported: false`) so UI work and web baselines run cleanly without faking depth data.
- **Consequences**:
  - Preserves web UI velocity and browser testing while unlocking full native `AVFoundation` / `Vision` / `Core ML` capabilities in Swift.
  - Because `ios/` is generated via `npx cap add ios` on macOS, the native camera code lives in version-controlled `plugins/truedepth-camera/ios/` so Linux authoring stays clean and Xcode builds pull it in via Swift Package Manager (`Package.swift`) or CocoaPods (`.podspec`).

## ADR-002: Local-First Storage & Honest Status Modeling

- **Date**: 2026-11-26
- **Status**: Accepted
- **Context**: Facial photographs are sensitive personal data, and M0–M1 precede any validated skin-analysis ML model.
- **Decision**:
  - Store original photos, depth payloads, and session metadata strictly on-device (`Documents/SkinTraceSessions/<sessionId>/` on iOS with `FileProtectionType.complete`).
  - Explicitly represent `not_analyzed`, `unavailable`, and `not_comparable` states in domain types (`src/types/domain.ts`) rather than coercing missing data to zero.
  - Tag every capture with its experiment variant (`rgb_unguided`, `rgb_guided`, `rgb_depth_guided`) from M0 onward to support the Variant A vs. B vs. C repeatability study without schema rewrites.
- **Consequences**:
  - No backend is required for M0–M2.
  - Future model versions and metric definitions can be version-checked before allowing session comparisons.
