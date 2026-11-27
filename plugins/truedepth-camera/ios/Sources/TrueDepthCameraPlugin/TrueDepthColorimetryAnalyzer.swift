import Foundation
import CoreGraphics
import CoreImage

/// Deterministic sRGB D65 -> CIELAB redness and dark-spot appearance analyzer
/// operating on upright full-resolution facial ROI crops.
/// Reports relative optical appearance proxies only (never clinical melanin concentration).
enum TrueDepthColorimetryAnalyzer {
    private static let algorithmVersion = "cielab-roi-srgb-v2"
    private static let metricDefinitionVersion = "colorimetry-metrics-v1"
    private static let standardRegions = [
        "forehead",
        "anatomicalLeftCheek",
        "anatomicalRightCheek",
        "chin"
    ]
    private static let minValidSkinRatio: Double = 0.35
    private static let rednessAStarMargin: Double = 3.0
    private static let darkSpotLStarMargin: Double = 6.0
    private static let maxSampleEdgePx: Int = 256

    static func analyze(sessionId: String) -> [String: Any] {
        let startTime = CFAbsoluteTimeGetCurrent()
        let isoNow = ISO8601DateFormatter().string(from: Date())

        func unavailable(_ reason: String, warnings: [String] = []) -> [String: Any] {
            return [
                "sessionId": sessionId,
                "analyzedAtIso": isoNow,
                "state": "unavailable",
                "unavailableReason": reason,
                "algorithmVersion": algorithmVersion,
                "metricDefinitionVersion": metricDefinitionVersion,
                "colorSpace": "sRGB_D65",
                "computationTimeMs": Int((CFAbsoluteTimeGetCurrent() - startTime) * 1000.0),
                "regions": [],
                "warnings": warnings
            ]
        }

        guard UUID(uuidString: sessionId) != nil else {
            return unavailable("Invalid sessionId.")
        }

        let sessionDir = TrueDepthCaptureManager.sessionsRootURL.appendingPathComponent(sessionId, isDirectory: true)
        let sessionMetaURL = sessionDir.appendingPathComponent("session.json")
        guard let metaData = try? Data(contentsOf: sessionMetaURL),
              let sessionMeta = try? JSONSerialization.jsonObject(with: metaData) as? [String: Any] else {
            return unavailable("Session metadata not found locally for \(sessionId).")
        }

        guard let alignment = sessionMeta["facialAlignment"] as? [String: Any],
              let regionsDict = alignment["regions"] as? [String: Any] else {
            return unavailable("Facial ROI regions are unavailable for this session. Recapture with face visible.")
        }

        let heicURL = sessionDir.appendingPathComponent("original.heic")
        let jpgURL = sessionDir.appendingPathComponent("original.jpg")
        let imageURL = FileManager.default.fileExists(atPath: heicURL.path) ? heicURL : jpgURL
        guard FileManager.default.fileExists(atPath: imageURL.path),
              let ciImage = CIImage(contentsOf: imageURL, options: [.applyOrientationProperty: true]),
              let srgbSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
            return unavailable("Original RGB capture file could not be loaded into sRGB.")
        }

        let ciContext = CIContext(options: [.workingColorSpace: srgbSpace])
        guard let fullSRGBImage = ciContext.createCGImage(
            ciImage,
            from: ciImage.extent,
            format: .RGBA8,
            colorSpace: srgbSpace
        ) else {
            return unavailable("Failed to materialize sRGB CGImage from original capture.")
        }

        let imgW = CGFloat(fullSRGBImage.width)
        let imgH = CGFloat(fullSRGBImage.height)
        guard imgW > 0, imgH > 0 else {
            return unavailable("Original image has zero dimensions.")
        }

        var regionResults: [[String: Any]] = []
        var measuredCount = 0
        var warnings: [String] = []

        for regionKey in standardRegions {
            guard let normRect = parseNormalizedRect(regionsDict[regionKey]) else {
                regionResults.append(makeUnavailableRegion(regionKey, reason: "ROI rect missing in facialAlignment."))
                continue
            }

            let pixelRect = CGRect(
                x: (normRect.minX * imgW).rounded(.down),
                y: (normRect.minY * imgH).rounded(.down),
                width: max(1, (normRect.width * imgW).rounded(.up)),
                height: max(1, (normRect.height * imgH).rounded(.up))
            ).intersection(CGRect(x: 0, y: 0, width: imgW, height: imgH))

            guard pixelRect.width >= 8, pixelRect.height >= 8,
                  let cropped = fullSRGBImage.cropping(to: pixelRect) else {
                regionResults.append(makeUnavailableRegion(regionKey, reason: "ROI crop too small or out of bounds."))
                continue
            }

            guard let raster = renderToSRGBBytes(cgImage: cropped, srgbSpace: srgbSpace) else {
                regionResults.append(makeUnavailableRegion(regionKey, reason: "Failed to rasterize ROI pixels into sRGB."))
                continue
            }

            let metrics = computeRegionMetrics(
                rgba: raster.bytes,
                width: raster.width,
                height: raster.height,
                region: regionKey
            )
            if (metrics["state"] as? String) == "measured" {
                measuredCount += 1
            } else if let reason = metrics["unavailableReason"] as? String {
                warnings.append("\(regionKey): \(reason)")
            }
            regionResults.append(metrics)
        }

        if measuredCount == 0 {
            return unavailable(
                "No facial ROI had sufficient valid skin pixels (minimum 35% unclipped skin required).",
                warnings: warnings
            )
        }

        let durationMs = Int((CFAbsoluteTimeGetCurrent() - startTime) * 1000.0)
        let record: [String: Any] = [
            "sessionId": sessionId,
            "analyzedAtIso": isoNow,
            "state": "measured",
            "algorithmVersion": algorithmVersion,
            "metricDefinitionVersion": metricDefinitionVersion,
            "colorSpace": "sRGB_D65",
            "computationTimeMs": durationMs,
            "regions": regionResults,
            "warnings": warnings
        ]

        do {
            let saved = try TrueDepthCaptureManager.saveSessionColorimetry(sessionId: sessionId, colorimetry: record)
            if !saved {
                return unavailable("Failed to persist colorimetry.json locally.", warnings: warnings)
            }
        } catch {
            return unavailable("Failed to persist colorimetry.json: \(error.localizedDescription)", warnings: warnings)
        }

        return record
    }

    private static func makeUnavailableRegion(
        _ region: String,
        reason: String,
        sampledCount: Int = 0,
        validRatio: Double = 0
    ) -> [String: Any] {
        return [
            "region": region,
            "state": "unavailable",
            "unavailableReason": reason,
            "sampledPixelCount": sampledCount,
            "validSkinPixelRatio": validRatio,
            "meanLStar": NSNull(),
            "meanAStar": NSNull(),
            "meanBStar": NSNull(),
            "erythemaIndex": NSNull(),
            "melaninIndexProxy": NSNull(),
            "elevatedRednessAreaFraction": NSNull(),
            "darkSpotContrastAreaFraction": NSNull(),
            "darkSpotContrastDeltaL": NSNull()
        ]
    }

    private static func renderToSRGBBytes(
        cgImage: CGImage,
        srgbSpace: CGColorSpace
    ) -> (bytes: [UInt8], width: Int, height: Int)? {
        let srcW = cgImage.width
        let srcH = cgImage.height
        let maxSrc = max(srcW, srcH)
        let scale = maxSrc > maxSampleEdgePx ? Double(maxSampleEdgePx) / Double(maxSrc) : 1.0
        let dstW = max(1, Int((Double(srcW) * scale).rounded()))
        let dstH = max(1, Int((Double(srcH) * scale).rounded()))

        let bytesPerRow = dstW * 4
        var buffer = [UInt8](repeating: 0, count: dstH * bytesPerRow)
        let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue

        let drawn: Bool = buffer.withUnsafeMutableBytes { rawPtr in
            guard let baseAddress = rawPtr.baseAddress,
                  let ctx = CGContext(
                    data: baseAddress,
                    width: dstW,
                    height: dstH,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: srgbSpace,
                    bitmapInfo: bitmapInfo
                  ) else {
                return false
            }
            ctx.interpolationQuality = .medium
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: dstW, height: dstH))
            return true
        }
        return drawn ? (buffer, dstW, dstH) : nil
    }

    private static func srgbToLinear(_ c255: UInt8) -> Double {
        let c = Double(c255) / 255.0
        return c <= 0.04045 ? (c / 12.92) : pow((c + 0.055) / 1.055, 2.4)
    }

    private static func labF(_ t: Double) -> Double {
        return t > 0.008856 ? cbrt(t) : (7.787 * t + 16.0 / 116.0)
    }

    private static func fitLinearPlane(
        xs: [Double],
        ys: [Double],
        vals: [Double]
    ) -> (Double, Double, Double)? {
        let n = vals.count
        guard n >= 16 else { return nil }

        var sx = 0.0, sy = 0.0, sxx = 0.0, sxy = 0.0, syy = 0.0
        var sv = 0.0, sxv = 0.0, syv = 0.0
        for i in 0..<n {
            let x = xs[i]
            let y = ys[i]
            let v = vals[i]
            sx += x
            sy += y
            sxx += x * x
            sxy += x * y
            syy += y * y
            sv += v
            sxv += x * v
            syv += y * v
        }

        let a00 = Double(n), a01 = sx, a02 = sy
        let a11 = sxx, a12 = sxy, a22 = syy

        let det =
            a00 * (a11 * a22 - a12 * a12) -
            a01 * (a01 * a22 - a12 * a02) +
            a02 * (a01 * a12 - a11 * a02)
        guard det.isFinite && abs(det) >= 1e-9 else { return nil }

        let det0 =
            sv * (a11 * a22 - a12 * a12) -
            a01 * (sxv * a22 - a12 * syv) +
            a02 * (sxv * a12 - a11 * syv)
        let det1 =
            a00 * (sxv * a22 - a12 * syv) -
            sv * (a01 * a22 - a12 * a02) +
            a02 * (a01 * syv - sxv * a02)
        let det2 =
            a00 * (a11 * syv - sxv * a12) -
            a01 * (a01 * syv - sxv * a02) +
            sv * (a01 * a12 - a11 * a02)

        return (det0 / det, det1 / det, det2 / det)
    }

    private static func computeRegionMetrics(
        rgba: [UInt8],
        width: Int,
        height: Int,
        region: String
    ) -> [String: Any] {
        let sampledCount = rgba.count / 4
        guard sampledCount > 0 else {
            return makeUnavailableRegion(region, reason: "No pixels sampled in ROI.")
        }

        let use2DPlane = (width >= 4 && height >= 4 && width * height == sampledCount)
        var lValues: [Double] = []
        var aValues: [Double] = []
        var xCoords: [Double] = []
        var yCoords: [Double] = []
        lValues.reserveCapacity(sampledCount)
        aValues.reserveCapacity(sampledCount)
        if use2DPlane {
            xCoords.reserveCapacity(sampledCount)
            yCoords.reserveCapacity(sampledCount)
        }

        var sumL = 0.0
        var sumA = 0.0
        var sumB = 0.0
        var sumEi = 0.0
        var sumMi = 0.0

        for i in 0..<sampledCount {
            let offset = i * 4
            let r = rgba[offset]
            let g = rgba[offset + 1]
            let b = rgba[offset + 2]

            if (r >= 248 && g >= 248 && b >= 248) || (r <= 15 && g <= 15 && b <= 15) {
                continue
            }

            let rLin = srgbToLinear(r)
            let gLin = srgbToLinear(g)
            let bLin = srgbToLinear(b)

            let x = (0.4124564 * rLin + 0.3575761 * gLin + 0.1804375 * bLin) / 0.95047
            let y = 0.2126729 * rLin + 0.7151522 * gLin + 0.0721750 * bLin
            let z = (0.0193339 * rLin + 0.1191920 * gLin + 0.9503041 * bLin) / 1.08883

            let fx = labF(x)
            let fy = labF(y)
            let fz = labF(z)

            let lStar = 116.0 * fy - 16.0
            if !lStar.isFinite || lStar < 15.0 || lStar > 92.0 {
                continue
            }
            let aStar = 500.0 * (fx - fy)
            let bStar = 200.0 * (fy - fz)
            if !aStar.isFinite || !bStar.isFinite {
                continue
            }

            lValues.append(lStar)
            aValues.append(aStar)
            if use2DPlane {
                let px = i % width
                let py = i / width
                xCoords.append(Double(px) / Double(width - 1) - 0.5)
                yCoords.append(Double(py) / Double(height - 1) - 0.5)
            }
            sumL += lStar
            sumA += aStar
            sumB += bStar

            let rClamped = max(rLin, 1e-4)
            let gClamped = max(gLin, 1e-4)
            sumEi += 100.0 * log10(rClamped / gClamped)
            sumMi += 100.0 * log10(1.0 / rClamped)
        }

        let validCount = lValues.count
        let validRatio = Double(validCount) / Double(sampledCount)
        guard validCount > 0, validRatio >= minValidSkinRatio else {
            return makeUnavailableRegion(
                region,
                reason: String(format: "Valid skin pixel ratio too low (%.1f%%; minimum 35%%).", validRatio * 100.0),
                sampledCount: sampledCount,
                validRatio: validRatio
            )
        }

        var detrendedL = lValues
        if use2DPlane, let (c0, c1, c2) = fitLinearPlane(xs: xCoords, ys: yCoords, vals: lValues) {
            detrendedL = (0..<validCount).map { idx in
                lValues[idx] - (c0 + c1 * xCoords[idx] + c2 * yCoords[idx])
            }
        }

        let sortedA = aValues.sorted()
        let sortedL = detrendedL.sorted()
        let medianA = sortedA[min(sortedA.count - 1, Int(Double(sortedA.count - 1) * 0.5))]
        let p75L = sortedL[min(sortedL.count - 1, Int(Double(sortedL.count - 1) * 0.75))]

        var elevatedRedCount = 0
        var darkSpotCount = 0
        var darkSpotDeltaSum = 0.0

        for i in 0..<validCount {
            if aValues[i] - medianA >= rednessAStarMargin {
                elevatedRedCount += 1
            }
            let deltaL = p75L - detrendedL[i]
            if deltaL >= darkSpotLStarMargin {
                darkSpotCount += 1
                darkSpotDeltaSum += deltaL
            }
        }

        let n = Double(validCount)
        return [
            "region": region,
            "state": "measured",
            "sampledPixelCount": sampledCount,
            "validSkinPixelRatio": validRatio,
            "meanLStar": sumL / n,
            "meanAStar": sumA / n,
            "meanBStar": sumB / n,
            "erythemaIndex": sumEi / n,
            "melaninIndexProxy": sumMi / n,
            "elevatedRednessAreaFraction": Double(elevatedRedCount) / n,
            "darkSpotContrastAreaFraction": Double(darkSpotCount) / n,
            "darkSpotContrastDeltaL": darkSpotCount > 0 ? (darkSpotDeltaSum / Double(darkSpotCount)) : 0.0
        ]
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
}
