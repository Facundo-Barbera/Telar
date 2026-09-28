import SwiftUI
import UIKit

enum CodeLayout {
    static let tabStop = 4

    static func columns(_ line: some StringProtocol) -> Int {
        var columns = 0
        for character in line {
            if character == "\t" {
                columns += tabStop - (columns % tabStop)
            } else {
                columns += width(of: character)
            }
        }
        return columns
    }

    static func widestLineColumns(_ text: some StringProtocol) -> Int {
        var widest = 0
        var line = 0
        for character in text {
            if character == "\n" {
                widest = max(widest, line)
                line = 0
            } else if character == "\t" {
                line += tabStop - (line % tabStop)
            } else {
                line += width(of: character)
            }
        }
        return max(widest, line)
    }

    private static func width(of character: Character) -> Int {
        guard let scalar = character.unicodeScalars.first else { return 0 }
        return isWide(scalar) ? 2 : 1
    }

    private static func isWide(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x1100...0x115F,
             0x2E80...0x303E,
             0x3041...0x33FF,
             0x3400...0x4DBF,
             0x4E00...0x9FFF,
             0xA000...0xA4CF,
             0xAC00...0xD7A3,
             0xF900...0xFAFF,
             0xFE30...0xFE6F,
             0xFF00...0xFF60,
             0xFFE0...0xFFE6,
             0x1F300...0x1FAFF,
             0x20000...0x3FFFD:
            return true
        default:
            return false
        }
    }

    static func contentWidth(columns: Int, advance: CGFloat) -> CGFloat {
        CGFloat(max(columns, 0) + 1) * advance
    }

    @MainActor static func advance(ofSize size: CGFloat) -> CGFloat {
        if let cached = advances[size] { return cached }
        let font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
        let width = ("0" as NSString).size(withAttributes: [.font: font]).width
        advances[size] = width
        return width
    }

    @MainActor private static var advances: [CGFloat: CGFloat] = [:]
}

struct InteractivePopGate: UIViewRepresentable {
    let disabled: Bool

    func makeUIView(context: Context) -> GateView { GateView() }
    func updateUIView(_ view: GateView, context: Context) { view.apply(disabled) }
    static func dismantleUIView(_ view: GateView, coordinator: ()) { view.restore() }

    final class GateView: UIView {
        private weak var navigation: UINavigationController?
        private var wasEnabled: Bool?
        private var wanted = false

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window == nil {
                restore()
            } else {
                navigation = navigation ?? findNavigation()
                apply(wanted)
            }
        }

        func apply(_ disabled: Bool) {
            wanted = disabled
            navigation = navigation ?? findNavigation()
            guard let gesture = navigation?.interactivePopGestureRecognizer else { return }
            if wasEnabled == nil { wasEnabled = gesture.isEnabled }
            gesture.isEnabled = disabled ? false : (wasEnabled ?? true)
            if !disabled { wasEnabled = nil }
        }

        func restore() {
            guard let wasEnabled, let gesture = navigation?.interactivePopGestureRecognizer else { return }
            gesture.isEnabled = wasEnabled
            self.wasEnabled = nil
        }

        private func findNavigation() -> UINavigationController? {
            var responder: UIResponder? = next
            while let current = responder {
                if let controller = current as? UINavigationController { return controller }
                if let controller = current as? UIViewController, let nav = controller.navigationController { return nav }
                responder = current.next
            }
            return nil
        }
    }
}

extension View {
    func interactivePopDisabled(_ disabled: Bool) -> some View {
        overlay(InteractivePopGate(disabled: disabled).frame(width: 0, height: 0).allowsHitTesting(false))
    }
}
