import AVFoundation
import SwiftUI
import UIKit

/// The camera path for pairing: scan the QR off the Mac's Remote access
/// panel. AVFoundation's metadata output, NOT VisionKit's DataScanner — the
/// scanner ran a per-frame ML pipeline for a job the capture hardware does
/// natively, and the preview stuttered for it (worst in Debug builds, which
/// is what the dev flavor always is). The preview layer here is fed straight
/// by the capture session; no frame ever crosses into Swift.
struct QRScannerView: UIViewRepresentable {
    /// Return true to ACCEPT (scanning stops); false keeps the camera live
    /// so a wrong code — someone's wifi QR — doesn't freeze the preview.
    let onScan: (String) -> Bool

    /// False on the simulator (no camera), which is why the paste field
    /// exists and is the automation path.
    static var isUsable: Bool {
        AVCaptureDevice.default(for: .video) != nil
    }

    func makeUIView(context: Context) -> ScannerPreviewView {
        let view = ScannerPreviewView()
        context.coordinator.start(in: view)
        return view
    }

    func updateUIView(_ view: ScannerPreviewView, context: Context) {}

    static func dismantleUIView(_ view: ScannerPreviewView, coordinator: Coordinator) {
        coordinator.stop()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan)
    }

    final class ScannerPreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        private let onScan: (String) -> Bool
        private let session = AVCaptureSession()
        /// Session start/stop block; never on the main thread.
        private let sessionQueue = DispatchQueue(label: "telar.qr.session")
        private var accepted = false
        /// Rejected payloads, so one bad code doesn't re-fire per frame.
        private var refused: Set<String> = []

        init(onScan: @escaping (String) -> Bool) {
            self.onScan = onScan
        }

        func start(in view: ScannerPreviewView) {
            view.previewLayer.session = session
            view.previewLayer.videoGravity = .resizeAspectFill
            // First use prompts (NSCameraUsageDescription); a denial leaves a
            // black preview and the paste path still works.
            AVCaptureDevice.requestAccess(for: .video) { granted in
                guard granted else { return }
                self.configureAndRun()
            }
        }

        private func configureAndRun() {
            sessionQueue.async { [session, self] in
                guard let camera = AVCaptureDevice.default(for: .video),
                      let input = try? AVCaptureDeviceInput(device: camera)
                else { return }
                session.beginConfiguration()
                // 720p is plenty for a QR filling half the frame, and keeps
                // the pipeline light; the default preset is much larger.
                if session.canSetSessionPreset(.hd1280x720) {
                    session.sessionPreset = .hd1280x720
                }
                if session.canAddInput(input) { session.addInput(input) }
                let output = AVCaptureMetadataOutput()
                if session.canAddOutput(output) {
                    session.addOutput(output)
                    // Type must be set AFTER the output joins the session.
                    output.setMetadataObjectsDelegate(self, queue: .main)
                    output.metadataObjectTypes = [.qr]
                }
                session.commitConfiguration()
                session.startRunning()
            }
        }

        func stop() {
            sessionQueue.async { [session] in
                if session.isRunning { session.stopRunning() }
            }
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard !accepted else { return }
            for object in metadataObjects {
                guard let code = object as? AVMetadataMachineReadableCodeObject,
                      let payload = code.stringValue,
                      !refused.contains(payload)
                else { continue }
                if onScan(payload) {
                    accepted = true
                    stop()
                    return
                }
                refused.insert(payload)
            }
        }
    }
}

/// Sheet wrapper: scanner on top, a cancel bar below, and the parse feedback
/// inline — a scanned code that is not a Telar pairing link says so instead
/// of silently staying open.
struct QRScannerSheet: View {
    let onPaired: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var rejected = false

    var body: some View {
        VStack(spacing: 0) {
            QRScannerView { payload in
                if Pairing.parsePairingURL(payload) != nil {
                    onPaired(payload)
                    dismiss()
                    return true
                }
                rejected = true
                return false
            }
            VStack(spacing: 8) {
                if rejected {
                    Text("That code is not a Telar pairing link.")
                        .font(Theme.meta)
                        .foregroundStyle(Theme.statusAmber)
                }
                Button("Cancel") { dismiss() }
                    .font(Theme.bodyMedium)
                    .padding(.vertical, 8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Theme.canvas)
        }
    }
}
