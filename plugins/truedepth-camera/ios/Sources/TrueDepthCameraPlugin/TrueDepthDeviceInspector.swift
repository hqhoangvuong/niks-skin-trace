import Foundation
import AVFoundation
import CoreMedia
import UIKit

enum TrueDepthDeviceInspector {
    static func currentPermissionState() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return "granted"
        case .denied:
            return "denied"
        case .restricted:
            return "restricted"
        case .notDetermined:
            return "prompt"
        @unknown default:
            return "unsupported"
        }
    }

    static func hardwareModelIdentifier() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let mirror = Mirror(reflecting: systemInfo.machine)
        let identifier = mirror.children.reduce(into: "") { acc, element in
            guard let value = element.value as? Int8, value != 0 else { return }
            acc.append(String(UnicodeScalar(UInt8(value))))
        }
        return identifier.isEmpty ? UIDevice.current.model : identifier
    }

    static func fourCCString(_ code: FourCharCode) -> String {
        let bytes: [UInt8] = [
            UInt8((code >> 24) & 0xFF),
            UInt8((code >> 16) & 0xFF),
            UInt8((code >> 8) & 0xFF),
            UInt8(code & 0xFF)
        ]
        if bytes.allSatisfy({ $0 >= 32 && $0 <= 126 }),
           let str = String(bytes: bytes, encoding: .ascii) {
            return str
        }
        return String(format: "0x%08X", code)
    }

    static func probe() -> [String: Any] {
        let isoNow = ISO8601DateFormatter().string(from: Date())
        let permission = currentPermissionState()
        let modelId = hardwareModelIdentifier()
        let systemVersion = UIDevice.current.systemVersion

        #if targetEnvironment(simulator)
        return [
            "probedAtIso": isoNow,
            "platform": "ios",
            "isSimulator": true,
            "deviceModel": modelId,
            "systemVersion": systemVersion,
            "cameraPermission": permission,
            "trueDepthSupported": false,
            "activeDeviceType": "simulator",
            "photoOutputDepthDeliverySupported": false,
            "totalFrontFormatCount": 0,
            "depthCapableFormats": [],
            "notes": [
                "Running in iOS Simulator. TrueDepth hardware and AVDepthData cannot be validated in a simulator.",
                "Run on a physical iPhone 16 Pro to complete Milestone M0."
            ]
        ]
        #else
        var notes: [String] = []
        let trueDepthDevice = AVCaptureDevice.default(
            .builtInTrueDepthCamera,
            for: .video,
            position: .front
        )
        let fallbackFrontDevice = AVCaptureDevice.default(
            .builtInWideAngleCamera,
            for: .video,
            position: .front
        )

        guard let device = trueDepthDevice ?? fallbackFrontDevice else {
            return [
                "probedAtIso": isoNow,
                "platform": "ios",
                "isSimulator": false,
                "deviceModel": modelId,
                "systemVersion": systemVersion,
                "cameraPermission": permission,
                "trueDepthSupported": false,
                "activeDeviceType": "none",
                "photoOutputDepthDeliverySupported": false,
                "totalFrontFormatCount": 0,
                "depthCapableFormats": [],
                "notes": ["No front-facing camera device was discovered on this device."]
            ]
        }

        let isTrueDepth = (trueDepthDevice != nil)
        if !isTrueDepth {
            notes.append("builtInTrueDepthCamera is unavailable; fell back to front builtInWideAngleCamera.")
        }

        var depthCapableFormats: [[String: Any]] = []
        for format in device.formats {
            guard !format.supportedDepthDataFormats.isEmpty else { continue }

            let videoDims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            let videoSubType = fourCCString(CMFormatDescriptionGetMediaSubType(format.formatDescription))
            let maxPhotoDims: [[String: Int]]
            if #available(iOS 16.0, *) {
                maxPhotoDims = format.supportedMaxPhotoDimensions.map { dim in
                    ["width": Int(dim.width), "height": Int(dim.height)]
                }
            } else {
                let dim = format.highResolutionStillImageDimensions
                maxPhotoDims = [["width": Int(dim.width), "height": Int(dim.height)]]
            }

            let depthFormats: [[String: Any]] = format.supportedDepthDataFormats.map { depthFmt in
                let dDims = CMVideoFormatDescriptionGetDimensions(depthFmt.formatDescription)
                let dSubType = fourCCString(CMFormatDescriptionGetMediaSubType(depthFmt.formatDescription))
                let maxFps = depthFmt.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0
                return [
                    "width": Int(dDims.width),
                    "height": Int(dDims.height),
                    "pixelFormat": dSubType,
                    "maxFrameRate": maxFps
                ]
            }

            depthCapableFormats.append([
                "width": Int(videoDims.width),
                "height": Int(videoDims.height),
                "pixelFormat": videoSubType,
                "supportedMaxPhotoDimensions": maxPhotoDims,
                "supportedDepthFormats": depthFormats
            ])
        }

        var photoOutputDepthSupported: Any = NSNull()
        if permission == "granted" {
            let probeSession = AVCaptureSession()
            probeSession.beginConfiguration()
            probeSession.sessionPreset = .photo
            do {
                let input = try AVCaptureDeviceInput(device: device)
                let output = AVCapturePhotoOutput()
                if probeSession.canAddInput(input) && probeSession.canAddOutput(output) {
                    probeSession.addInput(input)
                    probeSession.addOutput(output)
                    probeSession.commitConfiguration()
                    photoOutputDepthSupported = output.isDepthDataDeliverySupported
                } else {
                    probeSession.commitConfiguration()
                    notes.append("Could not attach front camera input and AVCapturePhotoOutput during capability probe.")
                }
            } catch {
                probeSession.commitConfiguration()
                notes.append("Capability probe session setup error: \(error.localizedDescription)")
            }
        } else {
            notes.append("Grant camera permission to probe AVCapturePhotoOutput.isDepthDataDeliverySupported.")
        }

        return [
            "probedAtIso": isoNow,
            "platform": "ios",
            "isSimulator": false,
            "deviceModel": modelId,
            "systemVersion": systemVersion,
            "cameraPermission": permission,
            "trueDepthSupported": isTrueDepth,
            "activeDeviceType": device.deviceType.rawValue,
            "photoOutputDepthDeliverySupported": photoOutputDepthSupported,
            "totalFrontFormatCount": device.formats.count,
            "depthCapableFormats": depthCapableFormats,
            "notes": notes
        ]
        #endif
    }
}
