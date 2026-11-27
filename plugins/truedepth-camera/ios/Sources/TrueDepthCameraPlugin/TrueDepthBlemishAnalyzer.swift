import Foundation
import CoreGraphics
import CoreImage
import CoreML
import Vision

struct BlemishModelManifest: Decodable {
    let modelVersion: String
    let preprocessingVersion: String
    let licenseScope: String
    let modelSource: String
    let classMap: [String: String]
    let defaultConfidenceThreshold: Double?
    let defaultUncertainThreshold: Double?
}

/// On-device Core ML ROI-crop blemish analyzer.
/// Requires an explicit app-bundled `BlemishDetector.mlmodelc` + `blemish_model_manifest.json`.
/// Never fabricates detections or coerces failed/incompatible inference into a measured zero.
enum TrueDepthBlemishAnalyzer {
    private static let metricDefinitionVersion = "blemish-metrics-v1"
    private static let standardRegions = [
        "forehead",
        "anatomicalLeftCheek",
        "anatomicalRightCheek",
        "chin"
    ]
    private static let activeCategories: Set<String> = [
        "comedone",
        "papule_pustule",
        "nodule_cyst",
        "active_blemish_unspecified"
    ]
    private static let residualCategories: Set<String> = [
        "residual_red_mark_pie",
        "residual_dark_spot_pih"
    ]

    private struct RawDetection {
        let region: String
        let category: String
        let bbox: CGRect // Full-image top-left normalized [0, 1]
        let confidence: Double
        let uncertaintyState: String
    }

    static func analyze(
        sessionId: String,
        confidenceThreshold: Double?,
        uncertainThreshold: Double?
    ) -> [String: Any] {
        let startTime = CFAbsoluteTimeGetCurrent()
        let isoNow = ISO8601DateFormatter().string(from: Date())

        func unavailable(_ reason: String, warnings: [String] = []) -> [String: Any] {
            return [
                "sessionId": sessionId,
                "analyzedAtIso": isoNow,
                "state": "unavailable",
                "unavailableReason": reason,
                "source": "research_coreml_model",
                "licenseScope": "non_commercial_research_only",
                "modelVersion": NSNull(),
                "preprocessingVersion": NSNull(),
                "metricDefinitionVersion": metricDefinitionVersion,
                "computationTimeMs": Int((CFAbsoluteTimeGetCurrent() - startTime) * 1000.0),
                "lesions": [],
                "regions": [],
                "warnings": warnings
            ]
        }

        guard UUID(uuidString: sessionId) != nil else {
            return unavailable("Invalid sessionId.")
        }

        guard let modelURL = Bundle.main.url(forResource: "BlemishDetector", withExtension: "mlmodelc"),
              let manifestURL = Bundle.main.url(forResource: "blemish_model_manifest", withExtension: "json") else {
            return unavailable(
                "No licensed Core ML model bundled (expected BlemishDetector.mlmodelc and blemish_model_manifest.json in app bundle). Use Manual Annotation or bundle a manifest-verified model."
            )
        }

        let manifest: BlemishModelManifest
        do {
            let manifestData = try Data(contentsOf: manifestURL)
            manifest = try JSONDecoder().decode(BlemishModelManifest.self, from: manifestData)
        } catch {
            return unavailable("Invalid blemish_model_manifest.json: \(error.localizedDescription)")
        }

        let sessionDir = TrueDepthCaptureManager.sessionsRootURL.appendingPathComponent(sessionId, isDirectory: true)
        let sessionMetaURL = sessionDir.appendingPathComponent("session.json")
        guard let metaData = try? Data(contentsOf: sessionMetaURL),
              let sessionMeta = try? JSONSerialization.jsonObject(with: metaData) as? [String: Any] else {
            return unavailable("Session metadata not found locally for \(sessionId).")
        }

        let heicURL = sessionDir.appendingPathComponent("original.heic")
        let jpgURL = sessionDir.appendingPathComponent("original.jpg")
        let imageURL = FileManager.default.fileExists(atPath: heicURL.path) ? heicURL : jpgURL
        guard FileManager.default.fileExists(atPath: imageURL.path),
              let ciImage = CIImage(contentsOf: imageURL, options: [.applyOrientationProperty: true]) else {
            return unavailable("Original RGB capture file could not be loaded.")
        }

        let ciContext = CIContext(options: [.useSoftwareRenderer: false])
        guard let fullCGImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else {
            return unavailable("Failed to materialize upright full-resolution CGImage from original capture.")
        }

        let imgWidth = CGFloat(fullCGImage.width)
        let imgHeight = CGFloat(fullCGImage.height)
        guard imgWidth > 0, imgHeight > 0 else {
            return unavailable("Original image has zero dimensions.")
        }

        let mlConfig = MLModelConfiguration()
        mlConfig.computeUnits = .all
        let vnModel: VNCoreMLModel
        do {
            let mlModel = try MLModel(contentsOf: modelURL, configuration: mlConfig)
            vnModel = try VNCoreMLModel(for: mlModel)
        } catch {
            return unavailable("Failed to load Core ML model: \(error.localizedDescription)")
        }

        let confThresh = confidenceThreshold ?? manifest.defaultConfidenceThreshold ?? 0.45
        let uncThresh = min(confThresh, uncertainThreshold ?? manifest.defaultUncertainThreshold ?? 0.25)

        var warnings: [String] = []
        if manifest.licenseScope != "commercial_cleared" {
            warnings.append("Model licenseScope is '\(manifest.licenseScope)' — outputs are for research/evaluation only.")
        }

        // Parse unpadded ROI boxes so region assignment matches TS assignLesionToRegion 1:1.
        var unpaddedRegions: [String: CGRect] = [:]
        var cropJobs: [(region: String, rect: CGRect)] = []
        if let alignment = sessionMeta["facialAlignment"] as? [String: Any],
           let regionsDict = alignment["regions"] as? [String: Any] {
            for regionKey in standardRegions {
                if let r = parseNormalizedRect(regionsDict[regionKey]) {
                    unpaddedRegions[regionKey] = r
                    cropJobs.append((regionKey, padAndClamp(r, padFraction: 0.08)))
                }
            }
        }
        if cropJobs.isEmpty,
           let alignment = sessionMeta["facialAlignment"] as? [String: Any],
           let faceBox = parseNormalizedRect(alignment["faceBoundingBox"]) {
            warnings.append("Regional ROI boxes missing; ran inference on full face bounding box crop.")
            cropJobs.append(("other", padAndClamp(faceBox, padFraction: 0.05)))
        }
        if cropJobs.isEmpty {
            return unavailable("No facial alignment bounding box available for ROI cropping. Recapture with face visible.")
        }

        var rawDetections: [RawDetection] = []
        var successfulRoiCount = 0
        var failedRoiReasons: [String] = []

        for job in cropJobs {
            let rawPixelRect = CGRect(
                x: (job.rect.minX * imgWidth).rounded(.down),
                y: (job.rect.minY * imgHeight).rounded(.down),
                width: max(1, (job.rect.width * imgWidth).rounded(.up)),
                height: max(1, (job.rect.height * imgHeight).rounded(.up))
            )
            // Expand to a 1:1 square pixel window centered on the ROI so Vision scaleFill
            // preserves lesion aspect ratio without letterbox coordinate drift.
            let side = min(max(rawPixelRect.width, rawPixelRect.height), min(imgWidth, imgHeight))
            let sqX = max(0, min(imgWidth - side, rawPixelRect.midX - side / 2.0)).rounded(.down)
            let sqY = max(0, min(imgHeight - side, rawPixelRect.midY - side / 2.0)).rounded(.down)
            let pixelRect = CGRect(x: sqX, y: sqY, width: side.rounded(.down), height: side.rounded(.down))
                .intersection(CGRect(x: 0, y: 0, width: imgWidth, height: imgHeight))

            guard pixelRect.width >= 16, pixelRect.height >= 16,
                  let cropped = fullCGImage.cropping(to: pixelRect) else {
                failedRoiReasons.append("ROI '\(job.region)' crop was too small or invalid.")
                continue
            }

            let request = VNCoreMLRequest(model: vnModel)
            request.imageCropAndScaleOption = .scaleFill
            let handler = VNImageRequestHandler(cgImage: cropped, orientation: .up, options: [:])
            do {
                try handler.perform([request])
            } catch {
                failedRoiReasons.append("ROI '\(job.region)' inference failed: \(error.localizedDescription)")
                continue
            }

            let rawResults = request.results ?? []
            if !rawResults.isEmpty && !(rawResults is [VNRecognizedObjectObservation]) {
                return unavailable(
                    "Bundled Core ML model did not return VNRecognizedObjectObservation detections (incompatible model output type)."
                )
            }

            successfulRoiCount += 1
            let observations = (rawResults as? [VNRecognizedObjectObservation]) ?? []

            let cropNormX = Double(pixelRect.minX / imgWidth)
            let cropNormY = Double(pixelRect.minY / imgHeight)
            let cropNormW = Double(pixelRect.width / imgWidth)
            let cropNormH = Double(pixelRect.height / imgHeight)

            for obs in observations {
                guard let topLabel = obs.labels.first else { continue }
                // For 1-class Core ML NMS models, topLabel.confidence is conditional P(class|obj) == 1.0,
                // while obs.confidence holds the true detection box score.
                let conf = Double(min(obs.confidence, topLabel.confidence))
                guard conf.isFinite && conf >= uncThresh else { continue }

                // Never coerce unmapped/background labels into active acne.
                guard let mappedCategory = manifest.classMap[topLabel.identifier],
                      activeCategories.contains(mappedCategory) || residualCategories.contains(mappedCategory) else {
                    warnings.append("Ignored unmapped model label '\(topLabel.identifier)'.")
                    continue
                }

                let localTopY = 1.0 - Double(obs.boundingBox.maxY)
                let rawRect = CGRect(
                    x: cropNormX + Double(obs.boundingBox.minX) * cropNormW,
                    y: cropNormY + localTopY * cropNormH,
                    width: Double(obs.boundingBox.width) * cropNormW,
                    height: Double(obs.boundingBox.height) * cropNormH
                )
                let clampedRect = rawRect.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
                guard !clampedRect.isNull && !clampedRect.isEmpty,
                      clampedRect.minX.isFinite, clampedRect.minY.isFinite,
                      clampedRect.width.isFinite, clampedRect.height.isFinite else {
                    continue
                }

                let center = CGPoint(x: clampedRect.midX, y: clampedRect.midY)
                let assignedRegion = assignRegion(center: center, unpaddedRegions: unpaddedRegions)
                let uncertainty = conf >= confThresh ? "confident" : "uncertain"
                rawDetections.append(
                    RawDetection(
                        region: assignedRegion,
                        category: mappedCategory,
                        bbox: clampedRect,
                        confidence: conf,
                        uncertaintyState: uncertainty
                    )
                )
            }
        }

        // Never coerce failed ROI inference into a measured zero.
        if successfulRoiCount == 0 || !failedRoiReasons.isEmpty {
            let reason = failedRoiReasons.joined(separator: " ")
            return unavailable(
                "Core ML inference incomplete (\(successfulRoiCount)/\(cropJobs.count) ROIs succeeded): \(reason)",
                warnings: warnings
            )
        }

        let deduped = applyIoUNMS(rawDetections, iouThreshold: 0.45)

        let depthDict = sessionMeta["depth"] as? [String: Any]
        let mmPerPx = depthDict?["estimatedMmPerPixelAtRgb"] as? Double
        let totalRgbPixels = Double(fullCGImage.width * fullCGImage.height)

        var lesionDicts: [[String: Any]] = []
        var buckets: [String: (active: Int, residual: Int, uncertain: Int, normArea: Double)] = [:]
        for r in standardRegions {
            buckets[r] = (0, 0, 0, 0)
        }

        for det in deduped {
            let id = UUID().uuidString
            let cx = Double(det.bbox.midX)
            let cy = Double(det.bbox.midY)
            lesionDicts.append([
                "id": id,
                "region": det.region,
                "category": det.category,
                "centerNormalized": ["x": cx, "y": cy],
                "bboxNormalized": [
                    "x": Double(det.bbox.minX),
                    "y": Double(det.bbox.minY),
                    "width": Double(det.bbox.width),
                    "height": Double(det.bbox.height)
                ],
                "confidence": det.confidence,
                "uncertaintyState": det.uncertaintyState,
                "source": manifest.modelSource
            ])

            var b = buckets[det.region] ?? (0, 0, 0, 0)
            if det.uncertaintyState == "uncertain" {
                b.uncertain += 1
            } else {
                b.normArea += Double(det.bbox.width * det.bbox.height)
                if activeCategories.contains(det.category) {
                    b.active += 1
                } else if residualCategories.contains(det.category) {
                    b.residual += 1
                }
            }
            buckets[det.region] = b
        }

        var orderedRegions = standardRegions
        if buckets["other"] != nil {
            orderedRegions.append("other")
        }

        let regionSummaries: [[String: Any]] = orderedRegions.map { regionKey in
            let b = buckets[regionKey] ?? (0, 0, 0, 0)
            let mm2: Any
            if let scale = mmPerPx, scale.isFinite && scale > 0 {
                mm2 = b.normArea * totalRgbPixels * scale * scale
            } else {
                mm2 = NSNull()
            }
            return [
                "region": regionKey,
                "activeBlemishCount": b.active,
                "residualMarkCount": b.residual,
                "uncertainCount": b.uncertain,
                "affectedAreaNormalized": b.normArea,
                "affectedAreaMm2": mm2
            ]
        }

        let durationMs = Int((CFAbsoluteTimeGetCurrent() - startTime) * 1000.0)
        let record: [String: Any] = [
            "sessionId": sessionId,
            "analyzedAtIso": isoNow,
            "state": "measured",
            "source": manifest.modelSource,
            "licenseScope": manifest.licenseScope,
            "modelVersion": manifest.modelVersion,
            "preprocessingVersion": manifest.preprocessingVersion,
            "metricDefinitionVersion": metricDefinitionVersion,
            "computationTimeMs": durationMs,
            "lesions": lesionDicts,
            "regions": regionSummaries,
            "warnings": warnings
        ]

        do {
            let saved = try TrueDepthCaptureManager.saveSessionAnalysis(sessionId: sessionId, analysis: record)
            if !saved {
                return unavailable("Failed to persist Core ML analysis.json locally.", warnings: warnings)
            }
        } catch {
            return unavailable("Failed to persist Core ML analysis.json: \(error.localizedDescription)", warnings: warnings)
        }

        return record
    }

    private static func assignRegion(center: CGPoint, unpaddedRegions: [String: CGRect]) -> String {
        for key in standardRegions {
            if let rect = unpaddedRegions[key], rect.contains(center) {
                return key
            }
        }
        return "other"
    }

    private static func parseNormalizedRect(_ value: Any?) -> CGRect? {
        guard let dict = value as? [String: Any],
              let x = dict["x"] as? Double,
              let y = dict["y"] as? Double,
              let w = dict["width"] as? Double,
              let h = dict["height"] as? Double,
              x.isFinite, y.isFinite, w.isFinite, h.isFinite,
              w > 0, h > 0 else {
            return nil
        }
        return CGRect(x: x, y: y, width: w, height: h)
    }

    private static func padAndClamp(_ rect: CGRect, padFraction: CGFloat) -> CGRect {
        let dx = rect.width * padFraction
        let dy = rect.height * padFraction
        let expanded = rect.insetBy(dx: -dx, dy: -dy)
        return expanded.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
    }

    private static func applyIoUNMS(_ detections: [RawDetection], iouThreshold: Double) -> [RawDetection] {
        let sorted = detections.sorted { $0.confidence > $1.confidence }
        var kept: [RawDetection] = []
        for candidate in sorted {
            let overlaps = kept.contains { existing in
                let inter = existing.bbox.intersection(candidate.bbox)
                guard !inter.isNull && !inter.isEmpty else { return false }
                let interArea = Double(inter.width * inter.height)
                let unionArea = Double(existing.bbox.width * existing.bbox.height + candidate.bbox.width * candidate.bbox.height) - interArea
                guard unionArea > 0 else { return false }
                return (interArea / unionArea) >= iouThreshold
            }
            if !overlaps {
                kept.append(candidate)
            }
        }
        return kept
    }
}
