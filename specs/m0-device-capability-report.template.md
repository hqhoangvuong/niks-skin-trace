# M0 Device Capability Report — iPhone 16 Pro

Copy or fill this report directly from the JSON output of **Probe Hardware Capabilities** and **Capture Paired Photo** on a physical device. Do not fill from Apple spec sheets or the iOS Simulator.

## 1. Test Environment

- **Date**: YYYY-MM-DD
- **Device model identifier**: (e.g., `iPhone17,1`)
- **iOS version**: (e.g., `18.x`)
- **Xcode version**:
- **App commit / version**:
- **Physical device confirmed?**: [ ] Yes / [ ] No (Simulator results do not satisfy M0)

## 2. Camera Permission & Interruption Handling

- [ ] First-launch permission prompt displayed with clear `NSCameraUsageDescription`
- [ ] Authorized flow transitions to capture cleanly
- [ ] Denied flow surfaces actionable guidance without crashing
- [ ] Camera interruption (app backgrounded / FaceTime / Lock Screen) recovers cleanly

## 3. Observed Front Camera & TrueDepth Formats

Paste the probed device summary from `probeCapabilities()`:

```json
{
  "deviceModel": "",
  "systemVersion": "",
  "trueDepthSupported": false,
  "activeDeviceType": "",
  "supportedFormatCount": 0,
  "depthCapableFormats": []
}
```

### Key Observations

- Highest RGB photo resolution available **with** depth delivery enabled:
- Observed depth map dimensions & pixel formats (e.g. `DepthFloat32`, `DisparityFloat32`, `DepthFloat16`):
- Observed `AVDepthData.Accuracy` (`absolute` vs `relative`) and `Quality` (`high` vs `low`):
- `cameraCalibrationData` present? Intrinsic matrix / lens distortion lookup table status:
- Any format combinations that advertise support but fail or drop depth at capture time:

## 4. Paired Capture Verification

| Trial | Variant | View | RGB Dimensions | Depth Dimensions | Depth Valid % | Center Distance (m) | Calibration Present | Saved Locally | Notes / Failure Modes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `rgb_depth_guided` | `front` | | | | | | | |
| 2 | `rgb_depth_guided` | `left_cheek` | | | | | | | |
| 3 | `rgb_depth_guided` | `right_cheek` | | | | | | | |
| 4 | `rgb_unguided` | `front` | | | | | | | |

## 5. Orientation & Mirroring Check

- [ ] Original RGB image preserved without destructive re-encoding
- [ ] Left/right cheek orientation verified consistent between preview and saved file coordinates

## 6. M0 Gate Sign-Off

- [ ] Reproducible paired RGB + depth capture achieved on physical iPhone 16 Pro
- [ ] Missing/invalid depth handled explicitly without silently treating as depth-assisted
- [ ] Actual formats, calibration availability, latency, and failure modes documented above
