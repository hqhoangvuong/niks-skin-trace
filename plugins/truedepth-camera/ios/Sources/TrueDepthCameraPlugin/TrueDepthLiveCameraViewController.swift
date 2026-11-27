import Foundation
import AVFoundation
import CoreMedia
import UIKit

enum GuidedCaptureOutcome {
    case captured([String: Any])
    case cancelled
    case failed(Error)
}

/// Native full-screen live preview and synchronized RGB + TrueDepth guidance controller.
/// Keeps preview mirroring separate from stored unmirrored photo coordinates.
final class TrueDepthLiveCameraViewController: UIViewController {
    private let config: LiveGuidanceConfig
    private let onGuidanceUpdate: ([String: Any]) -> Void
    private let onComplete: (GuidedCaptureOutcome) -> Void

    private let sessionQueue = DispatchQueue(label: "com.hikarimoon.skintrace.live.session")
    private let dataOutputQueue = DispatchQueue(label: "com.hikarimoon.skintrace.live.data")

    private let session = AVCaptureSession()
    private var activeDevice: AVCaptureDevice?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let photoOutput = AVCapturePhotoOutput()
    private let videoDataOutput = AVCaptureVideoDataOutput()
    private var depthDataOutput: AVCaptureDepthDataOutput?
    private var outputSynchronizer: AVCaptureDataOutputSynchronizer?

    private var selectedMaxPhotoDim: CMVideoDimensions?
    private var activeDeviceType: String = "unknown"
    private var selectedVideoFormatDict: [String: Any]?
    private var selectedDepthFormatDict: [String: Any]?
    private var shutterCameraMetadata: [String: Any]?
    private var setupWarnings: [String] = []
    private var isCapturing = false
    private var isSessionInterrupted = false
    private var captureShutterStart: CFAbsoluteTime = 0
    private var lastEvaluationTime: CFAbsoluteTime = 0
    private var latestGuidanceDict: [String: Any]?
    private var ghostEnabled = true
    private var finished = false

    // UI elements
    private let previewContainer = UIView()
    private let ghostImageView = UIImageView()
    private let guideOvalLayer = CAShapeLayer()
    private let hudCard = UIView()
    private let headerLabel = UILabel()
    private let metricsLabel = UILabel()
    private let messageLabel = UILabel()
    private let cancelButton = UIButton(type: .system)
    private let shutterButton = UIButton(type: .system)
    private let ghostToggleButton = UIButton(type: .system)

    init(
        config: LiveGuidanceConfig,
        onGuidanceUpdate: @escaping ([String: Any]) -> Void,
        onComplete: @escaping (GuidedCaptureOutcome) -> Void
    ) {
        self.config = config
        self.onGuidanceUpdate = onGuidanceUpdate
        self.onComplete = onComplete
        super.init(nibName: nil, bundle: nil)
        self.modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        buildUI()
        loadGhostImageIfConfigured()
        registerNotifications()
        configureAndStartSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = previewContainer.bounds
        updateGuideOvalPath()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopSession()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    private func buildUI() {
        previewContainer.translatesAutoresizingMaskIntoConstraints = false
        previewContainer.backgroundColor = .black
        view.addSubview(previewContainer)

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        previewContainer.layer.insertSublayer(preview, at: 0)
        self.previewLayer = preview

        // Mirror the unmirrored stored reference photo horizontally to match live selfie preview framing.
        ghostImageView.translatesAutoresizingMaskIntoConstraints = false
        ghostImageView.contentMode = .scaleAspectFill
        ghostImageView.clipsToBounds = true
        ghostImageView.isUserInteractionEnabled = false
        ghostImageView.transform = CGAffineTransform(scaleX: -1, y: 1)
        ghostImageView.alpha = CGFloat(min(0.6, max(0.05, config.ghostOpacity)))
        ghostImageView.isHidden = true
        previewContainer.addSubview(ghostImageView)

        let isUnguided = (config.variant == "rgb_unguided")

        guideOvalLayer.fillColor = UIColor.clear.cgColor
        guideOvalLayer.strokeColor = UIColor.white.withAlphaComponent(0.75).cgColor
        guideOvalLayer.lineWidth = 2.5
        guideOvalLayer.lineDashPattern = [8, 6]
        guideOvalLayer.isHidden = isUnguided
        previewContainer.layer.addSublayer(guideOvalLayer)

        hudCard.translatesAutoresizingMaskIntoConstraints = false
        hudCard.backgroundColor = UIColor.black.withAlphaComponent(0.72)
        hudCard.layer.cornerRadius = 14
        hudCard.layer.borderWidth = 1
        hudCard.layer.borderColor = UIColor.white.withAlphaComponent(0.18).cgColor
        view.addSubview(hudCard)

        headerLabel.translatesAutoresizingMaskIntoConstraints = false
        headerLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        headerLabel.textColor = UIColor(white: 0.85, alpha: 1)
        if isUnguided {
            headerLabel.text = "View: \(config.view) · Variant A (Unguided RGB Baseline)"
        } else if config.requestDepth {
            headerLabel.text = String(
                format: "View: %@ · %@ · Target %.0f–%.0f cm",
                config.view,
                config.variant,
                config.targetMinMeters * 100.0,
                config.targetMaxMeters * 100.0
            )
        } else {
            headerLabel.text = "View: \(config.view) · Variant B (2D RGB Guided)"
        }

        metricsLabel.translatesAutoresizingMaskIntoConstraints = false
        metricsLabel.font = .monospacedDigitSystemFont(ofSize: 12.5, weight: .medium)
        metricsLabel.textColor = .white
        metricsLabel.numberOfLines = 2
        metricsLabel.isHidden = isUnguided
        metricsLabel.text = config.requestDepth
            ? "Dist: — · Valid: — · Sharp: — · Neutral: —"
            : "RGB-only · Sharp: — · Faces: 0 · Neutral: —"

        messageLabel.translatesAutoresizingMaskIntoConstraints = false
        messageLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        messageLabel.textColor = isUnguided ? .white : UIColor.systemYellow
        messageLabel.numberOfLines = 2
        messageLabel.text = isUnguided
            ? "Baseline selfie mode — frame naturally and tap shutter."
            : "Initializing camera…"

        let hudStack = UIStackView(arrangedSubviews: [headerLabel, metricsLabel, messageLabel])
        hudStack.translatesAutoresizingMaskIntoConstraints = false
        hudStack.axis = .vertical
        hudStack.spacing = 6
        hudCard.addSubview(hudStack)

        configureCapsuleButton(cancelButton, title: "Cancel")
        cancelButton.addTarget(self, action: #selector(handleCancelTapped), for: .touchUpInside)
        view.addSubview(cancelButton)

        shutterButton.translatesAutoresizingMaskIntoConstraints = false
        shutterButton.backgroundColor = .white
        shutterButton.layer.cornerRadius = 36
        shutterButton.layer.borderWidth = 4
        shutterButton.layer.borderColor = UIColor.white.withAlphaComponent(0.45).cgColor
        shutterButton.accessibilityLabel = "Capture photo"
        shutterButton.addTarget(self, action: #selector(handleCaptureTapped), for: .touchUpInside)
        view.addSubview(shutterButton)

        configureCapsuleButton(ghostToggleButton, title: "Ghost: On")
        ghostToggleButton.isHidden = true
        ghostToggleButton.addTarget(self, action: #selector(handleToggleGhost), for: .touchUpInside)
        view.addSubview(ghostToggleButton)

        NSLayoutConstraint.activate([
            previewContainer.topAnchor.constraint(equalTo: view.topAnchor),
            previewContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            previewContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            previewContainer.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            ghostImageView.topAnchor.constraint(equalTo: previewContainer.topAnchor),
            ghostImageView.leadingAnchor.constraint(equalTo: previewContainer.leadingAnchor),
            ghostImageView.trailingAnchor.constraint(equalTo: previewContainer.trailingAnchor),
            ghostImageView.bottomAnchor.constraint(equalTo: previewContainer.bottomAnchor),

            hudCard.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            hudCard.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            hudCard.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),

            hudStack.topAnchor.constraint(equalTo: hudCard.topAnchor, constant: 12),
            hudStack.leadingAnchor.constraint(equalTo: hudCard.leadingAnchor, constant: 14),
            hudStack.trailingAnchor.constraint(equalTo: hudCard.trailingAnchor, constant: -14),
            hudStack.bottomAnchor.constraint(equalTo: hudCard.bottomAnchor, constant: -12),

            shutterButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            shutterButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            shutterButton.widthAnchor.constraint(equalToConstant: 72),
            shutterButton.heightAnchor.constraint(equalToConstant: 72),

            cancelButton.centerYAnchor.constraint(equalTo: shutterButton.centerYAnchor),
            cancelButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),

            ghostToggleButton.centerYAnchor.constraint(equalTo: shutterButton.centerYAnchor),
            ghostToggleButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20)
        ])
    }

    private func configureCapsuleButton(_ button: UIButton, title: String) {
        if #available(iOS 15.0, *) {
            var cfg = UIButton.Configuration.filled()
            cfg.title = title
            cfg.baseForegroundColor = .white
            cfg.baseBackgroundColor = UIColor.black.withAlphaComponent(0.55)
            cfg.cornerStyle = .capsule
            cfg.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16)
            button.configuration = cfg
        } else {
            button.setTitle(title, for: .normal)
            button.setTitleColor(.white, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
            button.backgroundColor = UIColor.black.withAlphaComponent(0.55)
            button.layer.cornerRadius = 20
        }
        button.translatesAutoresizingMaskIntoConstraints = false
    }

    private func loadGhostImageIfConfigured() {
        guard config.variant != "rgb_unguided",
              let uriStr = config.ghostImageUri,
              let url = URL(string: uriStr),
              url.isFileURL else {
            return
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let image = UIImage(contentsOfFile: url.path) else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.ghostImageView.image = image
                self.ghostImageView.isHidden = !self.ghostEnabled
                self.ghostToggleButton.isHidden = false
            }
        }
    }

    @objc private func handleToggleGhost() {
        ghostEnabled.toggle()
        ghostImageView.isHidden = !ghostEnabled
        configureCapsuleButton(ghostToggleButton, title: ghostEnabled ? "Ghost: On" : "Ghost: Off")
    }

    private func updateGuideOvalPath() {
        let bounds = previewContainer.bounds
        let ovalWidth = min(bounds.width * 0.66, 300)
        let ovalHeight = ovalWidth * 1.32
        let ovalRect = CGRect(
            x: (bounds.width - ovalWidth) / 2.0,
            y: (bounds.height - ovalHeight) / 2.0,
            width: ovalWidth,
            height: ovalHeight
        )
        guideOvalLayer.path = UIBezierPath(ovalIn: ovalRect).cgPath
    }

    private func registerNotifications() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleSessionInterrupted),
            name: AVCaptureSession.wasInterruptedNotification,
            object: session
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleSessionInterruptionEnded),
            name: AVCaptureSession.interruptionEndedNotification,
            object: session
        )
    }

    @objc private func handleSessionInterrupted() {
        isSessionInterrupted = true
        DispatchQueue.main.async { [weak self] in
            self?.messageLabel.text = "Camera session interrupted. Waiting to resume…"
            self?.messageLabel.textColor = .systemOrange
            self?.shutterButton.isEnabled = false
        }
    }

    @objc private func handleSessionInterruptionEnded() {
        isSessionInterrupted = false
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.shutterButton.isEnabled = true
            if self.config.variant == "rgb_unguided" {
                self.messageLabel.text = "Baseline selfie mode — frame naturally and tap shutter."
                self.messageLabel.textColor = .white
            }
        }
    }

    private func configureAndStartSession() {
        #if targetEnvironment(simulator)
        finishWithOutcome(.failed(TrueDepthCaptureError.simulatorUnsupported))
        return
        #else
        sessionQueue.async { [weak self] in
            guard let self else { return }

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

            guard let device = (self.config.requestDepth ? (trueDepthDevice ?? fallbackDevice) : (fallbackDevice ?? trueDepthDevice)) else {
                self.finishWithOutcome(.failed(TrueDepthCaptureError.cameraUnavailable))
                return
            }

            self.activeDevice = device
            self.activeDeviceType = device.deviceType.rawValue
            if self.config.requestDepth && trueDepthDevice == nil {
                self.setupWarnings.append("TrueDepth camera unavailable; live session running on fallback front camera.")
            }

            self.session.beginConfiguration()

            do {
                let input = try AVCaptureDeviceInput(device: device)
                guard self.session.canAddInput(input),
                      self.session.canAddOutput(self.photoOutput),
                      self.session.canAddOutput(self.videoDataOutput) else {
                    self.session.commitConfiguration()
                    self.finishWithOutcome(.failed(TrueDepthCaptureError.sessionConfigurationFailed("Cannot attach front camera input/outputs.")))
                    return
                }

                self.session.addInput(input)
                self.session.addOutput(self.photoOutput)

                self.videoDataOutput.alwaysDiscardsLateVideoFrames = true
                self.videoDataOutput.videoSettings = [
                    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
                ]
                self.session.addOutput(self.videoDataOutput)

                var depthStreamingAttached = false
                if self.config.requestDepth,
                   let bestFormat = TrueDepthCaptureManager.selectBestDepthCapableFormat(for: device) {
                    self.session.sessionPreset = .inputPriority
                    try device.lockForConfiguration()
                    device.activeFormat = bestFormat.videoFormat
                    if let depthFormat = bestFormat.depthFormat {
                        device.activeDepthDataFormat = depthFormat
                        let dDims = CMVideoFormatDescriptionGetDimensions(depthFormat.formatDescription)
                        self.selectedDepthFormatDict = [
                            "width": Int(dDims.width),
                            "height": Int(dDims.height),
                            "pixelFormat": TrueDepthDeviceInspector.fourCCString(
                                CMFormatDescriptionGetMediaSubType(depthFormat.formatDescription)
                            )
                        ]
                    }
                    device.unlockForConfiguration()
                    self.selectedMaxPhotoDim = bestFormat.maxPhotoDimensions

                    let depthOut = AVCaptureDepthDataOutput()
                    depthOut.isFilteringEnabled = true
                    depthOut.alwaysDiscardsLateDepthData = true
                    if self.session.canAddOutput(depthOut) {
                        self.session.addOutput(depthOut)
                        self.depthDataOutput = depthOut
                        if let dConn = depthOut.connection(with: .depthData) {
                            dConn.isEnabled = true
                            TrueDepthCaptureManager.configurePortraitRotation(on: dConn)
                            if dConn.isVideoMirroringSupported {
                                dConn.isVideoMirrored = false
                            }
                        }
                        let sync = AVCaptureDataOutputSynchronizer(dataOutputs: [self.videoDataOutput, depthOut])
                        sync.setDelegate(self, queue: self.dataOutputQueue)
                        self.outputSynchronizer = sync
                        depthStreamingAttached = true
                    } else {
                        self.setupWarnings.append("Could not attach AVCaptureDepthDataOutput for live depth streaming.")
                    }
                } else {
                    self.session.sessionPreset = .photo
                    self.selectedMaxPhotoDim = TrueDepthCaptureManager.supportedPhotoDimensions(for: device.activeFormat).max {
                        (Int($0.width) * Int($0.height)) < (Int($1.width) * Int($1.height))
                    }
                }

                if !depthStreamingAttached {
                    self.videoDataOutput.setSampleBufferDelegate(self, queue: self.dataOutputQueue)
                }

                if let vConn = self.videoDataOutput.connection(with: .video) {
                    TrueDepthCaptureManager.configurePortraitRotation(on: vConn)
                    if vConn.isVideoMirroringSupported {
                        vConn.isVideoMirrored = false
                    }
                }

                // Keep stored photo unmirrored; preview layer below is mirrored separately for framing.
                if let pConn = self.photoOutput.connection(with: .video) {
                    TrueDepthCaptureManager.configurePortraitRotation(on: pConn)
                    if pConn.isVideoMirroringSupported {
                        pConn.isVideoMirrored = false
                    }
                }

                let activeVideoDims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
                self.selectedVideoFormatDict = [
                    "width": Int(activeVideoDims.width),
                    "height": Int(activeVideoDims.height),
                    "pixelFormat": TrueDepthDeviceInspector.fourCCString(
                        CMFormatDescriptionGetMediaSubType(device.activeFormat.formatDescription)
                    )
                ]

                TrueDepthCaptureManager.applyMaxPhotoDimensions(self.selectedMaxPhotoDim, to: self.photoOutput)

                let enablePhotoDepth = self.config.requestDepth && self.photoOutput.isDepthDataDeliverySupported
                self.photoOutput.isDepthDataDeliveryEnabled = enablePhotoDepth
                if self.config.requestDepth && !self.photoOutput.isDepthDataDeliverySupported {
                    self.setupWarnings.append("AVCapturePhotoOutput reported isDepthDataDeliverySupported == false during live capture.")
                }

                self.session.commitConfiguration()
                self.session.startRunning()

                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    if let previewConn = self.previewLayer?.connection {
                        TrueDepthCaptureManager.configurePortraitRotation(on: previewConn)
                        if previewConn.isVideoMirroringSupported {
                            previewConn.automaticallyAdjustsVideoMirroring = false
                            previewConn.isVideoMirrored = true
                        }
                    }
                }
            } catch {
                self.session.commitConfiguration()
                self.finishWithOutcome(.failed(TrueDepthCaptureError.sessionConfigurationFailed(error.localizedDescription)))
            }
        }
        #endif
    }

    private func stopSession() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if self.session.isRunning {
                self.session.stopRunning()
            }
        }
    }

    @objc private func handleCancelTapped() {
        finishWithOutcome(.cancelled)
    }

    @objc private func handleCaptureTapped() {
        sessionQueue.async { [weak self] in
            guard let self, !self.isCapturing else { return }
            self.isCapturing = true
            self.captureShutterStart = CFAbsoluteTimeGetCurrent()
            if let dev = self.activeDevice {
                self.shutterCameraMetadata = TrueDepthCaptureManager.captureCameraMetadata(from: dev)
            }

            DispatchQueue.main.async { [weak self] in
                self?.shutterButton.isEnabled = false
                self?.messageLabel.text = "Capturing paired photo…"
                self?.messageLabel.textColor = .white
            }

            let settings = TrueDepthCaptureManager.makePhotoSettings(
                for: self.photoOutput,
                maxPhotoDimensions: self.selectedMaxPhotoDim
            )
            self.photoOutput.capturePhoto(with: settings, delegate: self)
        }
    }

    private func processLiveFrame(videoBuffer: CVPixelBuffer, depthData: AVDepthData?) {
        let now = CFAbsoluteTimeGetCurrent()
        guard (now - lastEvaluationTime) >= 0.12 else { return }
        lastEvaluationTime = now

        let evaluated = TrueDepthGuidanceEvaluator.evaluate(
            videoPixelBuffer: videoBuffer,
            depthData: depthData,
            config: config,
            sessionInterrupted: isSessionInterrupted
        )
        let dict = evaluated.toDictionary(config: config)
        latestGuidanceDict = dict
        if config.variant != "rgb_unguided" {
            onGuidanceUpdate(dict)
        }

        DispatchQueue.main.async { [weak self] in
            guard let self, !self.isCapturing else { return }
            // Variant A (rgb_unguided): keep telemetry recorded silently above,
            // but suppress all live coaching prompts and readiness colors on screen.
            if self.config.variant == "rgb_unguided" {
                return
            }

            let distText = evaluated.faceDistanceMeters.map { String(format: "%.1f cm", $0 * 100.0) } ?? "—"
            let validText = evaluated.depthValidRatio.map { String(format: "%.0f%%", $0 * 100.0) } ?? "—"
            let sharpText = evaluated.sharpnessScore.map { String(format: "%.0f", $0) } ?? "—"
            let yawText = evaluated.yawDegrees.map { String(format: "%.0f°", $0) } ?? "—"
            let neutralText: String
            if let neutral = evaluated.neutralExpression {
                neutralText = neutral ? "OK" : "Relax"
            } else {
                neutralText = "—"
            }

            if self.config.requestDepth {
                self.metricsLabel.text = "Dist: \(distText) (\(validText)) · Sharp: \(sharpText) · Yaw: \(yawText) · Expr: \(neutralText)"
            } else {
                self.metricsLabel.text = "RGB-only · Faces: \(evaluated.faceCount) · Sharp: \(sharpText) · Yaw: \(yawText) · Expr: \(neutralText)"
            }

            self.messageLabel.text = evaluated.guidanceMessages.first ?? ""
            self.messageLabel.textColor = evaluated.readyToCapture ? .systemGreen : .systemYellow
            self.guideOvalLayer.strokeColor = (evaluated.readyToCapture ? UIColor.systemGreen : UIColor.white.withAlphaComponent(0.75)).cgColor
        }
    }

    private func finishWithOutcome(_ outcome: GuidedCaptureOutcome) {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.finished else { return }
            self.finished = true
            self.stopSession()
            self.dismiss(animated: true) {
                self.onComplete(outcome)
            }
        }
    }
}

extension TrueDepthLiveCameraViewController: AVCaptureDataOutputSynchronizerDelegate {
    func dataOutputSynchronizer(
        _ synchronizer: AVCaptureDataOutputSynchronizer,
        didOutput synchronizedDataCollection: AVCaptureSynchronizedDataCollection
    ) {
        guard let syncedVideo = synchronizedDataCollection.synchronizedData(for: videoDataOutput) as? AVCaptureSynchronizedSampleBufferData,
              !syncedVideo.sampleBufferWasDropped,
              let pixelBuffer = CMSampleBufferGetImageBuffer(syncedVideo.sampleBuffer) else {
            return
        }

        var depthData: AVDepthData?
        if let depthOut = depthDataOutput,
           let syncedDepth = synchronizedDataCollection.synchronizedData(for: depthOut) as? AVCaptureSynchronizedDepthData,
           !syncedDepth.depthDataWasDropped {
            depthData = syncedDepth.depthData
        }

        processLiveFrame(videoBuffer: pixelBuffer, depthData: depthData)
    }
}

extension TrueDepthLiveCameraViewController: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        processLiveFrame(videoBuffer: pixelBuffer, depthData: nil)
    }
}

extension TrueDepthLiveCameraViewController: AVCapturePhotoCaptureDelegate {
    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        sessionQueue.async { [weak self] in
            guard let self else { return }

            if let error {
                self.finishWithOutcome(.failed(TrueDepthCaptureError.captureFailed(error.localizedDescription)))
                return
            }

            guard let photoData = photo.fileDataRepresentation() else {
                self.finishWithOutcome(.failed(TrueDepthCaptureError.captureFailed("AVCapturePhoto returned empty file data.")))
                return
            }

            let durationMs = Int((CFAbsoluteTimeGetCurrent() - self.captureShutterStart) * 1000.0)
            let captureConfig = CaptureRequestConfig(
                view: self.config.view,
                variant: self.config.variant,
                requestDepth: self.config.requestDepth
            )

            do {
                let record = try TrueDepthCaptureManager.persistCapture(
                    photo: photo,
                    photoData: photoData,
                    config: captureConfig,
                    warnings: self.setupWarnings,
                    durationMs: durationMs,
                    deviceType: self.activeDeviceType,
                    selectedVideoFormat: self.selectedVideoFormatDict,
                    selectedDepthFormat: self.selectedDepthFormatDict,
                    cameraMetadata: self.shutterCameraMetadata,
                    liveGuidanceAtShutter: self.latestGuidanceDict
                )
                self.finishWithOutcome(.captured(record))
            } catch {
                self.finishWithOutcome(.failed(error))
            }
        }
    }
}
