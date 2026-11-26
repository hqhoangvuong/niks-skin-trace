# AGENTS.md — Skin Trace Engineering Guardrails

Read [docs/skincare-iphone16pro-handoff.md](docs/skincare-iphone16pro-handoff.md) and [specs/architecture-decisions.md](specs/architecture-decisions.md) before making architectural changes.

## Project Identity & Scope

- **Product**: Skincare visual progress tracker targeting **iPhone 16 Pro** (acne/blemishes first; dark spots and redness staged next).
- **Stack**: Hybrid app — **Vite + React + TypeScript** Web UI bridged via **Capacitor** to a local **Swift/AVFoundation** native iOS plugin (`plugins/truedepth-camera`).
- **Workflow**: Authored on Linux/WSL2; built, signed, and validated on macOS + Xcode against a physical iPhone 16 Pro.

## Non-Negotiable Technical Rules

1. **Color photo is primary; TrueDepth is supporting.**
   - Do not build a joint RGB-D neural network or assume ARKit's coarse face mesh resolves pores or pimple height.
   - Use TrueDepth for distance guidance, depth validity checks, and geometric alignment experiments.
2. **Query device formats dynamically — never hardcode TrueDepth resolution.**
   - Enumerate `AVCaptureDevice.formats` and `supportedDepthDataFormats` at runtime.
   - Always record the actual selected RGB dimensions, depth dimensions, pixel format, accuracy, quality, filtering, and calibration availability.
3. **Separate concerns strictly.**
   - Keep **capture & quality**, **region alignment**, **skin inference**, and **longitudinal comparison** in distinct modules and data records.
4. **Never fabricate detections, accuracy numbers, or improvement scores.**
   - Distinguish `not_analyzed`, `unavailable`, and `not_comparable` from a measured zero (`0`).
   - Do not create a single composite "skin health" / "beauty" score or turn generic embedding similarity into "% improved".
   - On web or iOS Simulator, explicitly label runs as `web_fallback` or `simulator` and report `trueDepthSupported: false`.
5. **Preserve originals and coordinate conventions.**
   - Never overwrite the original captured color photo.
   - Keep preview mirroring separate from stored image coordinates so left/right facial regions remain consistent.
6. **Keep facial images local by default.**
   - Store captures in app-local storage with `FileProtectionType.complete` on iOS. Never add background cloud upload without an explicit product decision.
7. **Report verification honestly.**
   - Clearly distinguish what was authored, what was built/tested locally, what was verified on a physical iPhone 16 Pro, and what remains unverified.

## Milestone Gates

- **M0 (Current)**: Reproducible paired RGB + TrueDepth capture on a physical iPhone 16 Pro with actual format/calibration capability logging.
- **M1**: Guided capture, capture quality checks, local timeline, aligned before/after viewer (still without fabricated AI results).
- **M2**: Licensed candidate blemish model, region metrics, inspectable detections, uncertainty states.
- **M3**: Dark spots & redness appearance metrics and color-consistency checks.
- **M4**: Variant A/B/C repeatability experiment (unguided RGB vs guided RGB vs guided RGB + TrueDepth) and longitudinal evaluation.
