import Foundation
import AVFoundation
import CoreMedia
import CoreVideo
import UIKit

struct CaptureRequestConfig {
    let view: String
    let variant: String
    let requestDepth: Bool
}

struct SelectedFormatChoice {
    let videoFormat: AVCaptureDevice.Format
    let depthFormat: AVCaptureDevice.Format?
    let maxPhotoDimensions: CMVideoDimensions?
}

enum TrueDepthCaptureError: LocalizedError {
    case simulatorUnsupported
    case permissionDenied(String)
    case cameraUnavailable
    case sessionConfigurationFailed(String)
    case captureFailed(String)
    case persistenceFailed(String)

    var errorDescription: String? {
        switch self {
        case .simulatorUnsupported:
            return "Camera capture requires a physical iPhone (iOS Simulator does not expose TrueDepth)."
        case .permissionDenied(let status):
            return "Camera permission is not authorized (current status: \(status))."
        case .cameraUnavailable:
            return "No front-facing camera is available on this device."
        case .sessionConfigurationFailed(let reason):
            return "Failed to configure AVCaptureSession: \(reason)"
        case .captureFailed(let reason):
            return "Photo capture failed: \(reason)"
        case .persistenceFailed(let reason):
            return "Failed to persist capture locally: \(reason)"
        }
    }
}

final class TrueDepthCaptureManager: NSObject {
    private let sessionQueue = DispatchQueue(label: "com.hikarimoon.skintrace.camera.session")
    private var activeSession: AVCaptureSession?
    private var photoOutput: AVCapturePhotoOutput?
    private var pendingCompletion: ((Result<[String: Any], Error>) -> Void)?
    private var pendingConfig: CaptureRequestConfig?
    private var pendingStartTime: CFAbsoluteTime = 0
    private var pendingWarnings: [String] = []
    private var pendingDeviceType: String = "unknown"
    private var pendingSelectedVideoFormat: [String: Any]?
    private var pendingSelectedDepthFormat: [String: Any]?

    static var sessionsRootURL: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("SkinTraceSessions", isDirectory: true)
    }

    static func selectBestDepthCapableFormat(
        for device: AVCaptureDevice
    ) -> SelectedFormatChoice? {
        let candidates = device.formats.filter { !$0.supportedDepthDataFormats.isEmpty }
        guard !candidates.isEmpty else { return nil }

        let ranked = candidates.max { lhs, rhs in
            let lhsMax = lhs.supportedMaxPhotoDimensions.map { Int($0.width) * Int($0.height) }.max() ?? 0
            let rhsMax = rhs.supportedMaxPhotoDimensions.map { Int($0.width) * Int($0.height) }.max() ?? 0
            return lhsMax < rhsMax
        }

        guard let videoFormat = ranked else { return nil }

        let preferredDepthFormat = videoFormat.supportedDepthDataFormats.first { fmt in
            let subType = CMFormatDescriptionGetMediaSubType(fmt.formatDescription)
            return subType == kCVPixelFormatType_DepthFloat32
        } ?? videoFormat.supportedDepthDataFormats.first { fmt in
            let subType = CMFormatDescriptionGetMediaSubType(fmt.formatDescription)
            return subType == kCVPixelFormatType_DisparityFloat32
        } ?? videoFormat.supportedDepthDataFormats.first

        let maxPhotoDim = videoFormat.supportedMaxPhotoDimensions.max {
            (Int($0.width) * Int($0.height)) < (Int($1.width) * Int($1.height))
        }

        return SelectedFormatChoice(
            videoFormat: videoFormat,
            depthFormat: preferredDepthFormat,
            maxPhotoDimensions: maxPhotoDim
        )
    }

    static func makePhotoSettings(
        for output: AVCapturePhotoOutput,
        maxPhotoDimensions: CMVideoDimensions?
    ) -> AVCapturePhotoSettings {
        let settings: AVCapturePhotoSettings
        if output.availablePhotoCodecTypes.contains(.hevc) {
            settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.hevc])
        } else {
            settings = AVCapturePhotoSettings()
        }
        if let maxDim = maxPhotoDimensions {
            settings.maxPhotoDimensions = maxDim
        }
        if output.isDepthDataDeliveryEnabled {
            settings.isDepthDataDeliveryEnabled = true
            settings.embedsDepthDataInPhoto = true
        }
        return settings
    }

    func capturePairedPhoto(
        config: CaptureRequestConfig,
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        #if targetEnvironment(simulator)
        completion(.failure(TrueDepthCaptureError.simulatorUnsupported))
        return
        #else
        let authStatus = AVCaptureDevice.authorizationStatus(for: .video)
        guard authStatus == .authorized else {
            completion(.failure(TrueDepthCaptureError.permissionDenied(TrueDepthDeviceInspector.currentPermissionState())))
            return
        }

        sessionQueue.async { [weak self] in
            guard let self else { return }
            guard self.pendingCompletion == nil else {
                completion(.failure(TrueDepthCaptureError.captureFailed("A capture is already in progress.")))
                return
            }

            self.pendingStartTime = CFAbsoluteTimeGetCurrent()
            self.pendingConfig = config
            self.pendingWarnings = []
            self.pendingSelectedVideoFormat = nil
            self.pendingSelectedDepthFormat = nil

            let session = AVCaptureSession()
            session.beginConfiguration()

            let trueDepthDevice = AVCaptureDevice.default(
                .builtInTrueDepthCamera,
                for: .video,
                position: .front
            )
            let fallbackDevice = AVCaptureDevice.default(
                .builtInWideAngleCamera,
                for: .video,
                position: .front
            )

            guard let device = (config.requestDepth ? (trueDepthDevice ?? fallbackDevice) : (fallbackDevice ?? trueDepthDevice)) else {
                session.commitConfiguration()
                completion(.failure(TrueDepthCaptureError.cameraUnavailable))
                return
            }

            self.pendingDeviceType = device.deviceType.rawValue
            if config.requestDepth && trueDepthDevice == nil {
                self.pendingWarnings.append("TrueDepth camera unavailable; captured using fallback front camera.")
            }

            do {
                let input = try AVCaptureDeviceInput(device: device)
                let output = AVCapturePhotoOutput()

                guard session.canAddInput(input), session.canAddOutput(output) else {
                    session.commitConfiguration()
                    completion(.failure(TrueDepthCaptureError.sessionConfigurationFailed("Cannot attach front camera input or photo output.")))
                    return
                }

                session.addInput(input)
                session.addOutput(output)

                var selectedMaxPhotoDim: CMVideoDimensions?
                if config.requestDepth, let bestFormat = Self.selectBestDepthCapableFormat(for: device) {
                    session.sessionPreset = .inputPriority
                    try device.lockForConfiguration()
                    device.activeFormat = bestFormat.videoFormat
                    if let depthFormat = bestFormat.depthFormat {
                        device.activeDepthDataFormat = depthFormat
                        let dDims = CMVideoFormatDescriptionGetDimensions(depthFormat.formatDescription)
                        self.pendingSelectedDepthFormat = [
                            "width": Int(dDims.width),
                            "height": Int(dDims.height),
                            "pixelFormat": TrueDepthDeviceInspector.fourCCString(
                                CMFormatDescriptionGetMediaSubType(depthFormat.formatDescription)
                            )
                        ]
                    }
                    device.unlockForConfiguration()
                    selectedMaxPhotoDim = bestFormat.maxPhotoDimensions
                } else {
                    session.sessionPreset = .photo
                    selectedMaxPhotoDim = device.activeFormat.supportedMaxPhotoDimensions.max(by: {
                        (Int($0.width) * Int($0.height)) < (Int($1.width) * Int($1.height))
                    })
                }

                // Keep stored image coordinates unmirrored and upright.
                if let connection = output.connection(with: .video) {
                    if connection.isVideoMirroringSupported {
                        connection.isVideoMirrored = false
                    }
                    if connection.isVideoRotationAngleSupported(90) {
                        connection.videoRotationAngle = 90
                    }
                }

                let activeVideoDims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
                self.pendingSelectedVideoFormat = [
                    "width": Int(activeVideoDims.width),
                    "height": Int(activeVideoDims.height),
                    "pixelFormat": TrueDepthDeviceInspector.fourCCString(
                        CMFormatDescriptionGetMediaSubType(device.activeFormat.formatDescription)
                    )
                ]

                if let maxDim = selectedMaxPhotoDim {
                    output.maxPhotoDimensions = maxDim
                }

                let enableDepth = config.requestDepth && output.isDepthDataDeliverySupported
                output.isDepthDataDeliveryEnabled = enableDepth
                if config.requestDepth && !output.isDepthDataDeliverySupported {
                    self.pendingWarnings.append("AVCapturePhotoOutput reported isDepthDataDeliverySupported == false for the active configuration.")
                }

                session.commitConfiguration()
                self.activeSession = session
                self.photoOutput = output
                self.pendingCompletion = completion

                session.startRunning()

                // Allow brief AE/AF settle on a cold single-shot M0 session before triggering shutter.
                self.sessionQueue.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                    guard let self, let output = self.photoOutput else { return }
                    let settings = Self.makePhotoSettings(for: output, maxPhotoDimensions: selectedMaxPhotoDim)
                    output.capturePhoto(with: settings, delegate: self)
                }
            } catch {
                session.commitConfiguration()
                completion(.failure(TrueDepthCaptureError.sessionConfigurationFailed(error.localizedDescription)))
            }
        }
        #endif
    }

    func listLocalSessions() -> [[String: Any]] {
        let fm = FileManager.default
        let root = Self.sessionsRootURL
        guard let dirs = try? fm.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        var results: [[String: Any]] = []
        for dir in dirs {
            let metaURL = dir.appendingPathComponent("session.json")
            guard let data = try? Data(contentsOf: metaURL),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            results.append(json)
        }

        results.sort { lhs, rhs in
            let lDate = lhs["capturedAtIso"] as? String ?? ""
            let rDate = rhs["capturedAtIso"] as? String ?? ""
            return lDate > rDate
        }
        return results
    }

    func deleteLocalSession(sessionId: String) throws -> Bool {
        guard UUID(uuidString: sessionId) != nil else { return false }
        let target = Self.sessionsRootURL.appendingPathComponent(sessionId, isDirectory: true)
        guard FileManager.default.fileExists(atPath: target.path) else { return false }
        try FileManager.default.removeItem(at: target)
        return true
    }

    private func tearDownSession() {
        activeSession?.stopRunning()
        activeSession = nil
        photoOutput = nil
        pendingConfig = nil
        pendingWarnings = []
    }

    static func persistCapture(
        photo: AVCapturePhoto,
        photoData: Data,
        config: CaptureRequestConfig,
        warnings initialWarnings: [String],
        durationMs: Int,
        deviceType: String,
        selectedVideoFormat: [String: Any]?,
        selectedDepthFormat: [String: Any]?,
        liveGuidanceAtShutter: [String: Any]?
    ) throws -> [String: Any] {
        var warnings = initialWarnings
        let sessionId = UUID().uuidString
        let fm = FileManager.default
        let sessionDir = sessionsRootURL.appendingPathComponent(sessionId, isDirectory: true)
        try fm.createDirectory(at: sessionDir, withIntermediateDirectories: true)

        let fileExt = (photoData.count >= 12 &&
            photoData[4] == 0x66 && photoData[5] == 0x74 && photoData[6] == 0x79 && photoData[7] == 0x70)
            ? "heic"
            : "jpg"
        let rgbURL = sessionDir.appendingPathComponent("original.\(fileExt)")
        try photoData.write(to: rgbURL, options: [.atomic, .completeFileProtection])

        let rgbWidth = photo.resolvedSettings.photoDimensions.width
        let rgbHeight = photo.resolvedSettings.photoDimensions.height

        var depthFileUri: String?
        var depthPayload: [String: Any]
        let effectiveMode: String

        if let rawDepth = photo.depthData {
            let depthSummary = try extractAndPersistDepth(
                depthData: rawDepth,
                sessionDir: sessionDir,
                warnings: &warnings
            )
            depthPayload = depthSummary.stats
            depthFileUri = depthSummary.fileUri
            effectiveMode = "rgb_plus_truedepth"
        } else {
            effectiveMode = "rgb_only_native"
            let reason = config.requestDepth
                ? "AVCapturePhoto.depthData was nil even though depth was requested."
                : "Depth was not requested for this capture variant."
            if config.requestDepth {
                warnings.append(reason)
            }
            depthPayload = [
                "available": false,
                "unavailableReason": reason,
                "calibration": ["present": false]
            ]
        }

        var record: [String: Any] = [
            "sessionId": sessionId,
            "capturedAtIso": ISO8601DateFormatter().string(from: Date()),
            "timezone": TimeZone.current.identifier,
            "platform": "ios",
            "isSimulatedOrWebFallback": false,
            "deviceModel": TrueDepthDeviceInspector.hardwareModelIdentifier(),
            "systemVersion": UIDevice.current.systemVersion,
            "cameraDeviceType": deviceType,
            "view": config.view,
            "requestedVariant": config.variant,
            "effectiveCaptureMode": effectiveMode,
            "storedImageMirrored": false,
            "rgbDimensions": [
                "width": Int(rgbWidth),
                "height": Int(rgbHeight)
            ],
            "rgbFileUri": rgbURL.absoluteString,
            "depth": depthPayload,
            "captureDurationMs": durationMs,
            "warnings": warnings
        ]

        if let depthFileUri {
            record["depthFileUri"] = depthFileUri
        }
        if let selectedVideoFormat {
            record["selectedVideoFormat"] = selectedVideoFormat
        }
        if let selectedDepthFormat {
            record["selectedDepthFormat"] = selectedDepthFormat
        }
        if let liveGuidanceAtShutter {
            record["liveGuidanceAtShutter"] = liveGuidanceAtShutter
        }

        let metadataData = try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys])
        let metadataURL = sessionDir.appendingPathComponent("session.json")
        try metadataData.write(to: metadataURL, options: [.atomic, .completeFileProtection])

        return record
    }

    private static func extractAndPersistDepth(
        depthData: AVDepthData,
        sessionDir: URL,
        warnings: inout [String]
    ) throws -> (stats: [String: Any], fileUri: String?) {
        let originalPixelFormat = TrueDepthDeviceInspector.fourCCString(depthData.depthDataType)
        let accuracyStr: String
        switch depthData.depthDataAccuracy {
        case .absolute: accuracyStr = "absolute"
        case .relative: accuracyStr = "relative"
        @unknown default: accuracyStr = "unknown"
        }

        let qualityStr: String
        switch depthData.depthDataQuality {
        case .high: qualityStr = "high"
        case .low: qualityStr = "low"
        @unknown default: qualityStr = "unknown"
        }

        let converted = depthData.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32)
        let pixelBuffer = converted.depthDataMap
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)

        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        var validCount = 0
        let totalPixels = width * height
        var centerValues: [Float] = []
        var rawFloatData = Data(capacity: totalPixels * MemoryLayout<Float32>.size)

        if let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) {
            let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
            let xStart = Int(Double(width) * 0.4)
            let xEnd = Int(Double(width) * 0.6)
            let yStart = Int(Double(height) * 0.4)
            let yEnd = Int(Double(height) * 0.6)

            for y in 0..<height {
                let rowPtr = baseAddress.advanced(by: y * bytesPerRow).assumingMemoryBound(to: Float32.self)
                rawFloatData.append(UnsafeBufferPointer(start: rowPtr, count: width))
                for x in 0..<width {
                    let val = rowPtr[x]
                    if val.isFinite && val > 0 {
                        validCount += 1
                        if x >= xStart && x < xEnd && y >= yStart && y < yEnd {
                            centerValues.append(val)
                        }
                    }
                }
            }
        }

        var depthFileUri: String?
        if !rawFloatData.isEmpty {
            let depthURL = sessionDir.appendingPathComponent("depth_float32.bin")
            try rawFloatData.write(to: depthURL, options: [.atomic, .completeFileProtection])
            depthFileUri = depthURL.absoluteString
        }

        centerValues.sort()
        let validRatio = totalPixels > 0 ? Double(validCount) / Double(totalPixels) : 0
        if validRatio < 0.5 {
            warnings.append(String(format: "Low valid depth coverage (%.1f%% of pixels finite and positive).", validRatio * 100.0))
        }

        var calibrationDict: [String: Any] = ["present": false]
        if let cal = depthData.cameraCalibrationData {
            let m = cal.intrinsicMatrix
            let matrixArray: [Float] = [
                m.columns.0.x, m.columns.1.x, m.columns.2.x,
                m.columns.0.y, m.columns.1.y, m.columns.2.y,
                m.columns.0.z, m.columns.1.z, m.columns.2.z
            ]
            calibrationDict = [
                "present": true,
                "intrinsicMatrix": matrixArray,
                "intrinsicMatrixReferenceDimensions": [
                    "width": Int(cal.intrinsicMatrixReferenceDimensions.width),
                    "height": Int(cal.intrinsicMatrixReferenceDimensions.height)
                ],
                "pixelSizeMm": cal.pixelSize,
                "lensDistortionCenter": [
                    "x": Double(cal.lensDistortionCenter.x),
                    "y": Double(cal.lensDistortionCenter.y)
                ],
                "hasLensDistortionLookupTable": cal.lensDistortionLookupTable != nil,
                "hasInverseLensDistortionLookupTable": cal.inverseLensDistortionLookupTable != nil
            ]
        }

        var stats: [String: Any] = [
            "available": true,
            "originalPixelFormat": originalPixelFormat,
            "width": width,
            "height": height,
            "accuracy": accuracyStr,
            "quality": qualityStr,
            "isFiltered": depthData.isDepthDataFiltered,
            "validPixelRatio": validRatio,
            "calibration": calibrationDict
        ]

        if let minV = centerValues.first, let maxV = centerValues.last {
            let medianV = centerValues[centerValues.count / 2]
            stats["centerWindowMinMeters"] = Double(minV)
            stats["centerWindowMedianMeters"] = Double(medianV)
            stats["centerWindowMaxMeters"] = Double(maxV)
        } else {
            warnings.append("Center depth window contained no valid positive depth samples.")
        }

        return (stats, depthFileUri)
    }
}

extension TrueDepthCaptureManager: AVCapturePhotoCaptureDelegate {
    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            let completion = self.pendingCompletion
            let config = self.pendingConfig ?? CaptureRequestConfig(view: "front", variant: "rgb_depth_guided", requestDepth: true)
            let warnings = self.pendingWarnings
            let startTime = self.pendingStartTime
            let deviceType = self.pendingDeviceType
            let selectedVideoFormat = self.pendingSelectedVideoFormat
            let selectedDepthFormat = self.pendingSelectedDepthFormat

            self.pendingCompletion = nil
            self.tearDownSession()

            guard let completion else { return }

            if let error {
                completion(.failure(TrueDepthCaptureError.captureFailed(error.localizedDescription)))
                return
            }

            guard let photoData = photo.fileDataRepresentation() else {
                completion(.failure(TrueDepthCaptureError.captureFailed("AVCapturePhoto returned empty file data.")))
                return
            }

            let durationMs = Int((CFAbsoluteTimeGetCurrent() - startTime) * 1000.0)
            do {
                let record = try Self.persistCapture(
                    photo: photo,
                    photoData: photoData,
                    config: config,
                    warnings: warnings,
                    durationMs: durationMs,
                    deviceType: deviceType,
                    selectedVideoFormat: selectedVideoFormat,
                    selectedDepthFormat: selectedDepthFormat,
                    liveGuidanceAtShutter: nil
                )
                completion(.success(record))
            } catch {
                completion(.failure(error))
            }
        }
    }
}
