import Foundation
import AVFoundation
import Capacitor

@objc(TrueDepthCameraPlugin)
public class TrueDepthCameraPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TrueDepthCameraPlugin"
    public let jsName = "TrueDepthCamera"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probeCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capturePairedPhoto", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openGuidedCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listLocalSessions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteLocalSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveSessionAnalysis", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "runCoreMLBlemishAnalysis", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "runColorimetryAnalysis", returnType: CAPPluginReturnPromise)
    ]

    private let captureManager = TrueDepthCaptureManager()

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        call.resolve([
            "camera": TrueDepthDeviceInspector.currentPermissionState()
        ])
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        let current = AVCaptureDevice.authorizationStatus(for: .video)
        if current == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { _ in
                call.resolve([
                    "camera": TrueDepthDeviceInspector.currentPermissionState()
                ])
            }
        } else {
            call.resolve([
                "camera": TrueDepthDeviceInspector.currentPermissionState()
            ])
        }
    }

    @objc public func probeCapabilities(_ call: CAPPluginCall) {
        let report = TrueDepthDeviceInspector.probe()
        call.resolve(report)
    }

    @objc public func capturePairedPhoto(_ call: CAPPluginCall) {
        let view = call.getString("view") ?? "front"
        let variant = call.getString("variant") ?? "rgb_depth_guided"
        let requestDepth = call.getBool("requestDepth") ?? (variant == "rgb_depth_guided")

        let config = CaptureRequestConfig(
            view: view,
            variant: variant,
            requestDepth: requestDepth
        )

        captureManager.capturePairedPhoto(config: config) { result in
            switch result {
            case .success(let record):
                call.resolve(record)
            case .failure(let error):
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }

    @objc public func openGuidedCapture(_ call: CAPPluginCall) {
        let authStatus = AVCaptureDevice.authorizationStatus(for: .video)
        guard authStatus == .authorized else {
            call.reject("Camera permission is not authorized (current status: \(TrueDepthDeviceInspector.currentPermissionState())).")
            return
        }

        let view = call.getString("view") ?? "front"
        let variant = call.getString("variant") ?? "rgb_depth_guided"
        let requestDepth = call.getBool("requestDepth") ?? (variant == "rgb_depth_guided")
        let targetMin = call.getDouble("targetMinDistanceMeters") ?? 0.22
        let targetMax = call.getDouble("targetMaxDistanceMeters") ?? 0.34
        let ghostImageUri = call.getString("ghostImageUri")
        let ghostOpacity = call.getDouble("ghostOpacity") ?? 0.28

        let guidanceConfig = LiveGuidanceConfig(
            view: view,
            variant: variant,
            requestDepth: requestDepth,
            targetMinMeters: targetMin,
            targetMaxMeters: targetMax,
            ghostImageUri: ghostImageUri,
            ghostOpacity: ghostOpacity
        )

        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.bridge?.viewController else {
                call.reject("Unable to locate presenting view controller for live camera preview.")
                return
            }

            let controller = TrueDepthLiveCameraViewController(
                config: guidanceConfig,
                onGuidanceUpdate: { [weak self] snapshot in
                    self?.notifyListeners("guidanceUpdate", data: snapshot)
                },
                onComplete: { outcome in
                    switch outcome {
                    case .captured(let record):
                        call.resolve([
                            "cancelled": false,
                            "record": record
                        ])
                    case .cancelled:
                        call.resolve([
                            "cancelled": true
                        ])
                    case .failed(let error):
                        call.reject(error.localizedDescription, nil, error)
                    }
                }
            )
            presenter.present(controller, animated: true)
        }
    }

    @objc public func listLocalSessions(_ call: CAPPluginCall) {
        let sessions = captureManager.listLocalSessions()
        call.resolve(["sessions": sessions])
    }

    @objc public func deleteLocalSession(_ call: CAPPluginCall) {
        guard let sessionId = call.getString("sessionId") else {
            call.reject("Missing required parameter: sessionId")
            return
        }
        do {
            let deleted = try captureManager.deleteLocalSession(sessionId: sessionId)
            call.resolve(["deleted": deleted])
        } catch {
            call.reject(error.localizedDescription, nil, error)
        }
    }

    @objc public func saveSessionAnalysis(_ call: CAPPluginCall) {
        guard let sessionId = call.getString("sessionId"),
              let analysis = call.getObject("analysis") else {
            call.reject("Missing required parameters: sessionId and analysis")
            return
        }
        do {
            let saved = try TrueDepthCaptureManager.saveSessionAnalysis(sessionId: sessionId, analysis: analysis)
            call.resolve(["saved": saved])
        } catch {
            call.reject(error.localizedDescription, nil, error)
        }
    }

    @objc public func runCoreMLBlemishAnalysis(_ call: CAPPluginCall) {
        guard let sessionId = call.getString("sessionId") else {
            call.reject("Missing required parameter: sessionId")
            return
        }
        let confidenceThreshold = call.getDouble("confidenceThreshold")
        let uncertainThreshold = call.getDouble("uncertainThreshold")

        DispatchQueue.global(qos: .userInitiated).async {
            let record = TrueDepthBlemishAnalyzer.analyze(
                sessionId: sessionId,
                confidenceThreshold: confidenceThreshold,
                uncertainThreshold: uncertainThreshold
            )
            call.resolve(record)
        }
    }

    @objc public func runColorimetryAnalysis(_ call: CAPPluginCall) {
        guard let sessionId = call.getString("sessionId") else {
            call.reject("Missing required parameter: sessionId")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let record = TrueDepthColorimetryAnalyzer.analyze(sessionId: sessionId)
            call.resolve(record)
        }
    }
}
