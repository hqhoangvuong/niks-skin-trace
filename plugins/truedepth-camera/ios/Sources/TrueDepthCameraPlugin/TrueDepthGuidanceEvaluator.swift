import Foundation
import AVFoundation
import CoreVideo
import Vision

struct LiveGuidanceConfig {
    let view: String
    let variant: String
    let requestDepth: Bool
    let targetMinMeters: Double
    let targetMaxMeters: Double
    let ghostImageUri: String?
    let ghostOpacity: Double
}

struct ImageQualityMetrics {
    let meanLuma: Double?
    let clippedHighlightRatio: Double?
    let clippedShadowRatio: Double?
    let sharpnessScore: Double?
}

struct EvaluatedGuidance {
    let faceCount: Int
    let faceCentered: Bool?
    let faceCoverageRatio: Double?
    let yawDegrees: Double?
    let rollDegrees: Double?
    let pitchDegrees: Double?
    let meanLuma: Double?
    let clippedHighlightRatio: Double?
    let clippedShadowRatio: Double?
    let sharpnessScore: Double?
    let isSharp: Bool?
    let neutralExpression: Bool?
    let mouthOpenRatio: Double?
    let mouthWidthRatio: Double?
    let depthAvailable: Bool
    let faceDistanceMeters: Double?
    let depthValidRatio: Double?
    let distanceState: String
    let sessionInterrupted: Bool
    let readyToCapture: Bool
    let guidanceMessages: [String]

    func toDictionary(config: LiveGuidanceConfig) -> [String: Any] {
        var dict: [String: Any] = [
            "timestampIso": ISO8601DateFormatter().string(from: Date()),
            "view": config.view,
            "variant": config.variant,
            "thresholdsProvisional": true,
            "faceCount": faceCount,
            "depthAvailable": depthAvailable,
            "distanceState": distanceState,
            "sessionInterrupted": sessionInterrupted,
            "readyToCapture": readyToCapture,
            "guidanceMessages": guidanceMessages
        ]
        dict["faceCentered"] = faceCentered ?? NSNull()
        dict["faceCoverageRatio"] = faceCoverageRatio ?? NSNull()
        dict["yawDegrees"] = yawDegrees ?? NSNull()
        dict["rollDegrees"] = rollDegrees ?? NSNull()
        dict["pitchDegrees"] = pitchDegrees ?? NSNull()
        dict["meanLuma"] = meanLuma ?? NSNull()
        dict["clippedHighlightRatio"] = clippedHighlightRatio ?? NSNull()
        dict["clippedShadowRatio"] = clippedShadowRatio ?? NSNull()
        dict["sharpnessScore"] = sharpnessScore ?? NSNull()
        dict["isSharp"] = isSharp ?? NSNull()
        dict["neutralExpression"] = neutralExpression ?? NSNull()
        dict["mouthOpenRatio"] = mouthOpenRatio ?? NSNull()
        dict["mouthWidthRatio"] = mouthWidthRatio ?? NSNull()
        dict["faceDistanceMeters"] = faceDistanceMeters ?? NSNull()
        dict["depthValidRatio"] = depthValidRatio ?? NSNull()
        return dict
    }
}

/// Evaluates synchronized RGB video + optional AVDepthData frames for live M1 capture quality gating.
/// All numerical thresholds are marked provisional pending physical-device pilot calibration.
enum TrueDepthGuidanceEvaluator {
    private static let provisionalSharpnessMin: Double = 35.0
    private static let provisionalHighlightClipMax: Double = 0.08
    private static let provisionalShadowClipMax: Double = 0.12
    private static let provisionalMouthOpenMax: Double = 0.16
    private static let provisionalMouthWidthMax: Double = 0.44

    static func evaluate(
        videoPixelBuffer: CVPixelBuffer,
        depthData: AVDepthData?,
        config: LiveGuidanceConfig,
        sessionInterrupted: Bool
    ) -> EvaluatedGuidance {
        if sessionInterrupted {
            return EvaluatedGuidance(
                faceCount: 0,
                faceCentered: nil,
                faceCoverageRatio: nil,
                yawDegrees: nil,
                rollDegrees: nil,
                pitchDegrees: nil,
                meanLuma: nil,
                clippedHighlightRatio: nil,
                clippedShadowRatio: nil,
                sharpnessScore: nil,
                isSharp: nil,
                neutralExpression: nil,
                mouthOpenRatio: nil,
                mouthWidthRatio: nil,
                depthAvailable: depthData != nil,
                faceDistanceMeters: nil,
                depthValidRatio: nil,
                distanceState: "unavailable",
                sessionInterrupted: true,
                readyToCapture: false,
                guidanceMessages: ["Camera session interrupted. Waiting for camera to resume."]
            )
        }

        let faces = detectFacesWithLandmarks(pixelBuffer: videoPixelBuffer)
        let faceCount = faces.count
        var messages: [String] = []

        var faceCentered: Bool?
        var faceCoverage: Double?
        var yawDeg: Double?
        var rollDeg: Double?
        var pitchDeg: Double?
        var faceRectNormalized: CGRect?
        var neutralExpression: Bool?
        var mouthOpenRatio: Double?
        var mouthWidthRatio: Double?

        if faceCount == 0 {
            messages.append("Position your face inside the frame.")
        } else if faceCount > 1 {
            messages.append("Multiple faces detected. Capture one face at a time.")
        } else if let face = faces.first {
            let box = face.boundingBox
            faceRectNormalized = box
            let centerX = box.midX
            let centerY = box.midY
            let centered = abs(centerX - 0.5) <= 0.16 && abs(centerY - 0.5) <= 0.18
            faceCentered = centered
            faceCoverage = Double(box.width * box.height)

            if !centered {
                messages.append("Center your face inside the guide oval.")
            }

            if let yaw = face.yaw?.doubleValue {
                yawDeg = yaw * 180.0 / .pi
            }
            if let roll = face.roll?.doubleValue {
                rollDeg = roll * 180.0 / .pi
            }
            if #available(iOS 15.0, *), let pitch = face.pitch?.doubleValue {
                pitchDeg = pitch * 180.0 / .pi
            }

            if let r = rollDeg, abs(r) > 12.0 {
                messages.append("Keep your head level.")
            }

            if let y = yawDeg {
                switch config.view {
                case "front":
                    if abs(y) > 15.0 {
                        messages.append("Look straight ahead for the front view.")
                    }
                case "left_cheek", "right_cheek":
                    if abs(y) < 18.0 {
                        messages.append("Turn slightly toward the side for the \(config.view.replacingOccurrences(of: "_", with: " ")) view.")
                    }
                default:
                    break
                }
            }

            // Neutral-expression check via Vision lip landmarks (front view is most reliable).
            if let landmarks = face.landmarks,
               let outerLips = landmarks.outerLips {
                let outerPts = outerLips.normalizedPoints
                if let minX = outerPts.map(\.x).min(),
                   let maxX = outerPts.map(\.x).max(),
                   let minY = outerPts.map(\.y).min(),
                   let maxY = outerPts.map(\.y).max() {
                    let outerWidth = Double(maxX - minX)
                    mouthWidthRatio = outerWidth

                    var openHeight = Double(maxY - minY) * 0.35
                    if let innerLips = landmarks.innerLips {
                        let innerPts = innerLips.normalizedPoints
                        if let iMinY = innerPts.map(\.y).min(),
                           let iMaxY = innerPts.map(\.y).max() {
                            openHeight = Double(iMaxY - iMinY)
                        }
                    }

                    let openRatio = outerWidth > 0.01 ? (openHeight / outerWidth) : 0
                    mouthOpenRatio = openRatio

                    let isNeutral = (openRatio <= provisionalMouthOpenMax) && (outerWidth <= provisionalMouthWidthMax)
                    neutralExpression = isNeutral
                    if !isNeutral && config.view == "front" {
                        messages.append("Relax your mouth to a neutral expression.")
                    }
                }
            }
        }

        let imageQuality = measureFaceRoiImageQuality(
            pixelBuffer: videoPixelBuffer,
            visionFaceBox: faceRectNormalized
        )

        var isSharp: Bool?
        if let sharpness = imageQuality.sharpnessScore {
            let sharpOK = sharpness >= provisionalSharpnessMin
            isSharp = sharpOK
            if !sharpOK {
                messages.append("Image looks soft — hold steady or adjust distance for focus.")
            }
        }

        if let luma = imageQuality.meanLuma {
            if luma < 0.18 {
                messages.append("Scene looks dark. Move toward even front lighting.")
            } else if luma > 0.88 {
                messages.append("Scene looks overexposed. Avoid harsh direct glare.")
            }
        }
        if let hiClip = imageQuality.clippedHighlightRatio, hiClip > provisionalHighlightClipMax {
            messages.append("Strong glare on face. Soften direct light.")
        }
        if let loClip = imageQuality.clippedShadowRatio, loClip > provisionalShadowClipMax {
            messages.append("Strong shadows on face. Face an even light source.")
        }

        var depthAvailable = false
        var faceDistanceMeters: Double?
        var depthValidRatio: Double?
        var distanceState = "unavailable"

        if let depthData {
            depthAvailable = true
            let sample = sampleDepth(depthData: depthData, visionFaceBox: faceRectNormalized)
            depthValidRatio = sample.validRatio
            faceDistanceMeters = sample.medianMeters

            if let ratio = sample.validRatio, ratio < 0.45 {
                messages.append("Low valid depth signal. Hold steady and keep sensor unobstructed.")
            }

            if let dist = sample.medianMeters {
                if dist < config.targetMinMeters {
                    distanceState = "too_close"
                    messages.append(String(format: "Move slightly farther back (%.0f cm; target %.0f–%.0f cm).", dist * 100.0, config.targetMinMeters * 100.0, config.targetMaxMeters * 100.0))
                } else if dist > config.targetMaxMeters {
                    distanceState = "too_far"
                    messages.append(String(format: "Move slightly closer (%.0f cm; target %.0f–%.0f cm).", dist * 100.0, config.targetMinMeters * 100.0, config.targetMaxMeters * 100.0))
                } else {
                    distanceState = "in_range"
                }
            } else {
                messages.append("Waiting for valid depth distance reading.")
            }
        } else if config.requestDepth {
            messages.append("Live TrueDepth stream unavailable on this frame.")
        }

        let isUnguided = (config.variant == "rgb_unguided")
        let ready: Bool
        if isUnguided {
            ready = true
        } else {
            let basicFaceOK = (faceCount == 1) && (faceCentered == true)
            let depthOK = !config.requestDepth || (depthAvailable && distanceState == "in_range" && (depthValidRatio ?? 0) >= 0.45)
            ready = basicFaceOK && depthOK && messages.isEmpty
        }

        if ready && messages.isEmpty {
            messages.append(isUnguided ? "Unguided baseline ready." : "Quality checks passed — tap Capture.")
        }

        return EvaluatedGuidance(
            faceCount: faceCount,
            faceCentered: faceCentered,
            faceCoverageRatio: faceCoverage,
            yawDegrees: yawDeg,
            rollDegrees: rollDeg,
            pitchDegrees: pitchDeg,
            meanLuma: imageQuality.meanLuma,
            clippedHighlightRatio: imageQuality.clippedHighlightRatio,
            clippedShadowRatio: imageQuality.clippedShadowRatio,
            sharpnessScore: imageQuality.sharpnessScore,
            isSharp: isSharp,
            neutralExpression: neutralExpression,
            mouthOpenRatio: mouthOpenRatio,
            mouthWidthRatio: mouthWidthRatio,
            depthAvailable: depthAvailable,
            faceDistanceMeters: faceDistanceMeters,
            depthValidRatio: depthValidRatio,
            distanceState: distanceState,
            sessionInterrupted: false,
            readyToCapture: ready,
            guidanceMessages: messages
        )
    }

    private static func detectFacesWithLandmarks(pixelBuffer: CVPixelBuffer) -> [VNFaceObservation] {
        let request = VNDetectFaceLandmarksRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
        do {
            try handler.perform([request])
            return request.results ?? []
        } catch {
            return []
        }
    }

    /// Computes mean luma, highlight/shadow clipping ratios, and Laplacian variance sharpness
    /// directly on the luma (Y) plane within the detected face ROI (or central 40% frame fallback).
    private static func measureFaceRoiImageQuality(
        pixelBuffer: CVPixelBuffer,
        visionFaceBox: CGRect?
    ) -> ImageQualityMetrics {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        guard CVPixelBufferIsPlanar(pixelBuffer),
              let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else {
            return ImageQualityMetrics(
                meanLuma: nil,
                clippedHighlightRatio: nil,
                clippedShadowRatio: nil,
                sharpnessScore: nil
            )
        }

        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let bytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        guard width > 8, height > 8 else {
            return ImageQualityMetrics(meanLuma: nil, clippedHighlightRatio: nil, clippedShadowRatio: nil, sharpnessScore: nil)
        }

        let roiXStart: Int
        let roiXEnd: Int
        let roiYStart: Int
        let roiYEnd: Int

        if let box = visionFaceBox {
            let inset = box.insetBy(dx: box.width * 0.1, dy: box.height * 0.1)
            roiXStart = max(2, min(width - 3, Int(inset.minX * CGFloat(width))))
            roiXEnd = max(roiXStart + 2, min(width - 2, Int(inset.maxX * CGFloat(width))))
            let topNorm = 1.0 - inset.maxY
            let bottomNorm = 1.0 - inset.minY
            roiYStart = max(2, min(height - 3, Int(topNorm * CGFloat(height))))
            roiYEnd = max(roiYStart + 2, min(height - 2, Int(bottomNorm * CGFloat(height))))
        } else {
            roiXStart = max(2, Int(Double(width) * 0.30))
            roiXEnd = min(width - 2, Int(Double(width) * 0.70))
            roiYStart = max(2, Int(Double(height) * 0.30))
            roiYEnd = min(height - 2, Int(Double(height) * 0.70))
        }

        let roiW = max(1, roiXEnd - roiXStart)
        let roiH = max(1, roiYEnd - roiYStart)
        let step = max(2, min(roiW, roiH) / 64)

        var lumaSum: Double = 0
        var highlightClipped = 0
        var shadowClipped = 0
        var lapSum: Double = 0
        var lapSqSum: Double = 0
        var count = 0

        var y = roiYStart
        while y < roiYEnd {
            let prevRow = base.advanced(by: (y - 1) * bytesPerRow).assumingMemoryBound(to: UInt8.self)
            let currRow = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)
            let nextRow = base.advanced(by: (y + 1) * bytesPerRow).assumingMemoryBound(to: UInt8.self)

            var x = roiXStart
            while x < roiXEnd {
                let c = Int(currRow[x])
                lumaSum += Double(c) / 255.0
                if c >= 245 { highlightClipped += 1 }
                if c <= 20 { shadowClipped += 1 }

                let lap = Double(4 * c - Int(currRow[x - 1]) - Int(currRow[x + 1]) - Int(prevRow[x]) - Int(nextRow[x]))
                lapSum += lap
                lapSqSum += lap * lap
                count += 1
                x += step
            }
            y += step
        }

        guard count > 0 else {
            return ImageQualityMetrics(meanLuma: nil, clippedHighlightRatio: nil, clippedShadowRatio: nil, sharpnessScore: nil)
        }

        let n = Double(count)
        let meanLap = lapSum / n
        let lapVariance = max(0, (lapSqSum / n) - (meanLap * meanLap))

        return ImageQualityMetrics(
            meanLuma: lumaSum / n,
            clippedHighlightRatio: Double(highlightClipped) / n,
            clippedShadowRatio: Double(shadowClipped) / n,
            sharpnessScore: lapVariance
        )
    }

    private static func sampleDepth(
        depthData: AVDepthData,
        visionFaceBox: CGRect?
    ) -> (medianMeters: Double?, validRatio: Double?) {
        let converted = depthData.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32)
        let buffer = converted.depthDataMap
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        guard width > 0, height > 0 else { return (nil, nil) }

        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }

        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return (nil, nil) }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)

        let roiXStart: Int
        let roiXEnd: Int
        let roiYStart: Int
        let roiYEnd: Int

        if let box = visionFaceBox {
            let insetBox = box.insetBy(dx: box.width * 0.2, dy: box.height * 0.2)
            roiXStart = max(0, min(width - 1, Int(insetBox.minX * CGFloat(width))))
            roiXEnd = max(roiXStart + 1, min(width, Int(insetBox.maxX * CGFloat(width))))
            let topNorm = 1.0 - insetBox.maxY
            let bottomNorm = 1.0 - insetBox.minY
            roiYStart = max(0, min(height - 1, Int(topNorm * CGFloat(height))))
            roiYEnd = max(roiYStart + 1, min(height, Int(bottomNorm * CGFloat(height))))
        } else {
            roiXStart = Int(Double(width) * 0.375)
            roiXEnd = Int(Double(width) * 0.625)
            roiYStart = Int(Double(height) * 0.375)
            roiYEnd = Int(Double(height) * 0.625)
        }

        let step = max(1, min(width, height) / 80)
        var totalSampled = 0
        var validSampled = 0
        var roiValues: [Float] = []

        var y = 0
        while y < height {
            let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: Float32.self)
            var x = 0
            while x < width {
                totalSampled += 1
                let v = row[x]
                if v.isFinite && v > 0.05 && v < 5.0 {
                    validSampled += 1
                    if x >= roiXStart && x < roiXEnd && y >= roiYStart && y < roiYEnd {
                        roiValues.append(v)
                    }
                }
                x += step
            }
            y += step
        }

        let validRatio = totalSampled > 0 ? Double(validSampled) / Double(totalSampled) : 0
        guard !roiValues.isEmpty else {
            return (nil, validRatio)
        }
        roiValues.sort()
        let median = Double(roiValues[roiValues.count / 2])
        return (median, validRatio)
    }
}
