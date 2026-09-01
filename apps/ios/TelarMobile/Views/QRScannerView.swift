import SwiftUI
import VisionKit

/// The camera path for pairing: scan the QR off the Mac's Remote access
/// panel. `DataScannerViewController.isSupported` is FALSE on the simulator
/// (it needs the Neural Engine), which is why the paste field exists and is
/// the automation path — this view only ever appears on hardware.
struct QRScannerView: UIViewControllerRepresentable {
    /// Return true to ACCEPT (scanning stops); false keeps the camera live
    /// so a wrong code — someone's wifi QR — doesn't freeze the preview.
    let onScan: (String) -> Bool

    static var isUsable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        // `.fast` + no highlighting: a pairing QR is large and high-contrast
        // on a Mac screen, so the low-res pipeline reads it instantly, and
        // the live tracking overlay was pure frame-rate cost — we accept the
        // first valid code, nothing is ever highlighted long enough to see.
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .fast,
            isHighlightingEnabled: false
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan)
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Bool
        private var accepted = false
        /// Rejected payloads, so one bad code doesn't re-fire per frame.
        private var refused: Set<String> = []

        init(onScan: @escaping (String) -> Bool) {
            self.onScan = onScan
        }

        func dataScanner(_ scanner: DataScannerViewController, didAdd added: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !accepted else { return }
            for item in added {
                guard case .barcode(let barcode) = item, let payload = barcode.payloadStringValue,
                      !refused.contains(payload)
                else { continue }
                if onScan(payload) {
                    accepted = true
                    scanner.stopScanning()
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
