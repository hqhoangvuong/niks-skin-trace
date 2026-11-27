import Foundation
import CoreGraphics
import Vision

/// Extracts normalized top-left-origin ([0, 1]) facial landmark anchors and repeatable
/// skin ROI boxes from a captured still photo (respecting EXIF orientation automatically).
enum TrueDepthLandmarkAligner {
    static func extract(from photoData: Data) -> [String: Any] {
        let rectRequest = VNDetectFaceRectanglesRequest()
        let landmarkRequest = VNDetectFaceLandmarksRequest()
        let handler = VNImageRequestHandler(data: photoData, options: [:])

        do {
            try handler.perform([rectRequest, landmarkRequest])
        } catch {
            return [
                "detected": false,
                "faceCount": 0,
                "error": error.localizedDescription
            ]
        }

        let rectFaces = rectRequest.results ?? []
        let landmarkFaces = landmarkRequest.results ?? []
        let faceCount = max(rectFaces.count, landmarkFaces.count)

        guard let face = landmarkFaces.first ?? rectFaces.first else {
            return [
                "detected": false,
                "faceCount": 0
            ]
        }

        let poseSource = rectFaces.first ?? face
        let box = face.boundingBox

        // Convert Vision bottom-left normalized rect to top-left normalized rect [0, 1].
        let topLeftBox = CGRect(
            x: box.minX,
            y: 1.0 - box.maxY,
            width: box.width,
            height: box.height
        )

        func toImageTopLeft(_ pt: CGPoint) -> CGPoint {
            let imgX = box.minX + pt.x * box.width
            let imgYBottomLeft = box.minY + pt.y * box.height
            return CGPoint(x: imgX, y: 1.0 - imgYBottomLeft)
        }

        func centroid(of region: VNFaceLandmarkRegion2D?) -> CGPoint? {
            guard let region, region.pointCount > 0 else { return nil }
            let pts = region.normalizedPoints
            let sum = pts.reduce(CGPoint.zero) { acc, p in
                CGPoint(x: acc.x + p.x, y: acc.y + p.y)
            }
            let avg = CGPoint(x: sum.x / CGFloat(pts.count), y: sum.y / CGFloat(pts.count))
            return toImageTopLeft(avg)
        }

        func pointDict(_ pt: CGPoint) -> [String: Double] {
            ["x": Double(pt.x), "y": Double(pt.y)]
        }

        func rectDict(_ rect: CGRect) -> [String: Double] {
            let clampedX = max(0.0, min(1.0, Double(rect.minX)))
            let clampedY = max(0.0, min(1.0, Double(rect.minY)))
            let clampedW = max(0.0, min(1.0 - clampedX, Double(rect.width)))
            let clampedH = max(0.0, min(1.0 - clampedY, Double(rect.height)))
            return [
                "x": clampedX,
                "y": clampedY,
                "width": clampedW,
                "height": clampedH
            ]
        }

        let anatomicalLeftEye = centroid(of: face.landmarks?.leftEye)
        let anatomicalRightEye = centroid(of: face.landmarks?.rightEye)
        let noseTip = centroid(of: face.landmarks?.noseCrest) ?? centroid(of: face.landmarks?.nose)
        let mouthCenter = centroid(of: face.landmarks?.outerLips)

        var result: [String: Any] = [
            "detected": true,
            "faceCount": faceCount,
            "coordinateOrigin": "top_left_normalized",
            "faceBoundingBox": rectDict(topLeftBox)
        ]

        if let leftEye = anatomicalLeftEye {
            result["anatomicalLeftEye"] = pointDict(leftEye)
        }
        if let rightEye = anatomicalRightEye {
            result["anatomicalRightEye"] = pointDict(rightEye)
        }
        if let noseTip {
            result["noseTip"] = pointDict(noseTip)
        }
        if let mouthCenter {
            result["mouthCenter"] = pointDict(mouthCenter)
        }

        if let leftEye = anatomicalLeftEye, let rightEye = anatomicalRightEye {
            // Order left-to-right in image space so eyeLineAngleDegrees is near 0° for an upright head.
            let imgLeftEye = leftEye.x <= rightEye.x ? leftEye : rightEye
            let imgRightEye = leftEye.x <= rightEye.x ? rightEye : leftEye
            let dx = Double(imgRightEye.x - imgLeftEye.x)
            let dy = Double(imgRightEye.y - imgLeftEye.y)
            let dist = hypot(dx, dy)
            let angleDeg = atan2(dy, dx) * 180.0 / .pi
            let midpoint = CGPoint(
                x: (imgLeftEye.x + imgRightEye.x) / 2.0,
                y: (imgLeftEye.y + imgRightEye.y) / 2.0
            )
            result["eyeCenterMidpoint"] = pointDict(midpoint)
            result["interEyeDistance"] = dist
            result["eyeLineAngleDegrees"] = angleDeg
        }

        var poseDict: [String: Any] = [:]
        if let yaw = poseSource.yaw?.doubleValue {
            poseDict["yawDegrees"] = yaw * 180.0 / .pi
        }
        if let roll = poseSource.roll?.doubleValue {
            poseDict["rollDegrees"] = roll * 180.0 / .pi
        }
        if #available(iOS 15.0, *), let pitch = poseSource.pitch?.doubleValue {
            poseDict["pitchDegrees"] = pitch * 180.0 / .pi
        }
        if !poseDict.isEmpty {
            result["poseDegrees"] = poseDict
        }

        // Approximate repeatable facial skin ROI boxes (excluding eye & lip bands).
        let fw = topLeftBox.width
        let fh = topLeftBox.height
        let fx = topLeftBox.minX
        let fy = topLeftBox.minY

        let eyeY = ((anatomicalLeftEye?.y ?? (fy + fh * 0.34)) + (anatomicalRightEye?.y ?? (fy + fh * 0.34))) / 2.0
        let mouthY = mouthCenter?.y ?? (fy + fh * 0.76)

        let foreheadRect = CGRect(
            x: fx + fw * 0.22,
            y: max(fy - fh * 0.04, 0),
            width: fw * 0.56,
            height: max(fh * 0.16, (eyeY - fy) * 0.65)
        )

        let cheekTop = eyeY + fh * 0.10
        let cheekHeight = max(fh * 0.16, (mouthY - cheekTop) * 0.85)
        // In an unmirrored front-camera photo, the viewer's left side corresponds to anatomical right cheek.
        let anatomicalRightCheekRect = CGRect(
            x: fx + fw * 0.10,
            y: cheekTop,
            width: fw * 0.27,
            height: cheekHeight
        )
        let anatomicalLeftCheekRect = CGRect(
            x: fx + fw * 0.63,
            y: cheekTop,
            width: fw * 0.27,
            height: cheekHeight
        )
        let chinRect = CGRect(
            x: fx + fw * 0.30,
            y: min(mouthY + fh * 0.08, fy + fh * 0.84),
            width: fw * 0.40,
            height: fh * 0.15
        )

        result["regions"] = [
            "forehead": rectDict(foreheadRect),
            "anatomicalLeftCheek": rectDict(anatomicalLeftCheekRect),
            "anatomicalRightCheek": rectDict(anatomicalRightCheekRect),
            "chin": rectDict(chinRect)
        ]

        return result
    }
}
