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
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let photoOutput = AVCapturePhotoOutput()
    private let videoDataOutput = AVCaptureVideoDataOutput()
    private var depthDataOutput: AVCaptureDepthDataOutput?
    private var outputSynchronizer: AVCaptureDataOutputSynchronizer?

    private var selectedMaxPhotoDim: CMVideoDimensions?
    private var activeDeviceType: String = "unknown"
    private var selectedVideoFormatDict: [String: Any]?
    private var selectedDepthFormatDict: [String: Any]?
    private var setupWarnings: [String] = []
    private var isCapturing = false
    private var isSessionInterrupted = false
    private var captureShutterStart: CFAbsoluteTime = 0
    private var lastEvaluationTime: CFAbsoluteTime = 0
    private var latestGuidanceDict: [String: Any]?
    private var finished = false

    // UI elements
    private let previewContainer = UIView()
    private let guideOvalLayer = CAShapeLayer()
    private let hudCard = UIView()
    private let headerLabel = UILabel()
    private let metricsLabel = UILabel()
    private let messageLabel = UILabel()
    private let cancelButton = UIButton(type: .system)
    private let shutterButton = UIButton(type: .system)

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
        previewContainer.layer.addSublayer(preview)
        self.previewLayer = preview

        guideOvalLayer.fillColor = UIColor.clear.cgColor
        guideOvalLayer.strokeColor = UIColor.white.withAlphaComponent(0.75).cgColor
        guideOvalLayer.lineWidth = 2.5
        guideOvalLayer.lineDashPattern = [8, 6]
        guideOvalLayer.isHidden = (config.variant == "rgb_unguided")
        previewContainer.layer.addSublayer(guideOvalLayer)

        hudCard.translatesAutoresizingMaskIntoConstraints = false
        hudCard.backgroundColor = UIColor.black.withAlphaComponent(0.68)
        hudCard.layer.cornerRadius = 14
        hudCard.layer.borderWidth = 1
        hudCard.layer.borderColor = UIColor.white.withAlphaComponent(0.18).cgColor
        view.addSubview(hudCard)

        headerLabel.translatesAutoresizingMaskIntoConstraints = false
        headerLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        headerLabel.textColor = UIColor(white: 0.85, alpha: 1)
        headerLabel.text = "View: \(config.view) · Mode: \(config.variant)"

        metricsLabel.translatesAutoresizingMaskIntoConstraints = false
        metricsLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
        metricsLabel.textColor = .white
        metricsLabel.numberOfLines = 2
        metricsLabel.text = config.requestDepth
            ? "Distance: — · Depth Valid: — · Faces: 0"
            : "RGB-only mode (TrueDepth disabled) · Faces: 0"

        messageLabel.translatesAutoresizingMaskIntoConstraints = false
        messageLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        messageLabel.textColor = UIColor.systemYellow
        messageLabel.numberOfLines = 2
        messageLabel.text = "Initializing camera…"

        let hudStack = UIStackView(arrangedSubviews: [headerLabel, metricsLabel, messageLabel])
        hudStack.translatesAutoresizingMaskIntoConstraints = false
        hudStack.axis = .vertical
        hudStack.spacing = 6
        hudCard.addSubview(hudStack)

        if #available(iOS 15.0, *) {
            var cancelConfig = UIButton.Configuration.filled()
            cancelConfig.title = "Cancel"
            cancelConfig.baseForegroundColor = .white
            cancelConfig.baseBackgroundColor = UIColor.black.withAlphaComponent(0.55)
            cancelConfig.cornerStyle = .capsule
            cancelConfig.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 18, bottom: 10, trailing: 18)
            cancelButton.configuration = cancelConfig
        } else {
            cancelButton.setTitle("Cancel", for: .normal)
            cancelButton.setTitleColor(.white, for: .normal)
            cancelButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
            cancelButton.backgroundColor = UIColor.black.withAlphaComponent(0.55)
            cancelButton.layer.cornerRadius = 22
        }
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
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

        NSLayoutConstraint.activate([
            previewContainer.topAnchor.constraint(equalTo: view.topAnchor),
            previewContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            previewContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            previewContainer.bottomAnchor.constraint(equalTo: view.bottomAnchor),

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
            cancelButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20)
        ])
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
            self?.shutterButton.isEnabled = true
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
        guard (now - lastEvaluationTime) >= 0.10 else { return }
        lastEvaluationTime = now

        let evaluated = TrueDepthGuidanceEvaluator.evaluate(
            videoPixelBuffer: videoBuffer,
            depthData: depthData,
            config: config,
            sessionInterrupted: isSessionInterrupted
        )
        let dict = evaluated.toDictionary(config: config)
        latestGuidanceDict = dict
        onGuidanceUpdate(dict)

        DispatchQueue.main.async { [weak self] in
            guard let self, !self.isCapturing else { return }
            let distText: String
            if let d = evaluated.faceDistanceMeters {
                distText = String(format: "%.1f cm", d * 100.0)
            } else {
                distText = "—"
            }
            let validText: String
            if let r = evaluated.depthValidRatio {
                validText = String(format: "%.0f%%", r * 100.0)
            } else {
                validText = "—"
            }
            let yawText = evaluated.yawDegrees.map { String(format: "%.0f°", $0) } ?? "—"
            let rollText = evaluated.rollDegrees.map { String(format: "%.0f°", $0) } ?? "—"

            if self.config.requestDepth {
                self.metricsLabel.text = "Dist: \(distText) · Valid: \(validText) · Faces: \(evaluated.faceCount) · Yaw: \(yawText) Roll: \(rollText)"
            } else {
                self.metricsLabel.text = "RGB-only · Faces: \(evaluated.faceCount) · Yaw: \(yawText) Roll: \(rollText)"
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
                    liveGuidanceAtShutter: self.latestGuidanceDict
                )
                self.finishWithOutcome(.captured(record))
            } catch {
                self.finishWithOutcome(.failed(error))
            }
        }
    }
}
