import SwiftUI
import UIKit

/// HOW WIDE THE WIDEST LINE IS, WITHOUT LAYING ONE OUT — issue #405.
///
/// THE PROBLEM THIS SOLVES. A two-axis scroll view over a LAZY stack of rows
/// that each take their natural width knows its content width only for the rows
/// it has laid out. So the horizontal extent JUMPED as you scrolled down — a
/// long line coming into view widened the content under your finger — and the
/// gesture locked to whichever axis moved first because the axis it could scroll
/// kept changing. The fix is to know the width before the first frame, and the
/// text is monospaced, so the width is arithmetic rather than layout: the widest
/// line in columns, times one glyph's advance.
///
/// COLUMNS, NOT CHARACTERS, and the difference is the two cases a character
/// count gets wrong. A TAB advances to the next tab stop rather than occupying
/// one cell, so an indented file measured by character count comes out far too
/// narrow. A CJK IDEOGRAPH or an emoji occupies two cells in every monospaced
/// font, so a file of Japanese comments comes out half its real width. Both
/// under-measure, and under-measuring is the one direction that costs something
/// — see the note on `contentWidth`.
///
/// GRAPHEMES, NOT SCALARS. A flag, a skin-toned emoji and an `é` written as `e`
/// plus a combining accent are one cell each and several scalars each; counting
/// scalars would widen a file for marks that take no room.
enum CodeLayout {
    /// The tab stop every code surface in this app assumes. Four, because that
    /// is what the transcript's fenced blocks and the editor already render.
    static let tabStop = 4

    /// One line's width in columns.
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

    /// The widest line in a whole file, in columns. One pass over the string and
    /// no attributed text, no font metrics and no layout — which is what makes
    /// it affordable on a 10K-line file at read time.
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

    /// Two cells for the wide scripts, one for everything else — the East Asian
    /// Wide and Fullwidth ranges, plus the emoji planes, which is the same
    /// approximation every terminal makes.
    ///
    /// A CHARACTER THIS MISJUDGES COSTS SLACK, NEVER A CUT: the first scalar
    /// decides, so a wide base with combining marks still counts two.
    private static func width(of character: Character) -> Int {
        guard let scalar = character.unicodeScalars.first else { return 0 }
        return isWide(scalar) ? 2 : 1
    }

    private static func isWide(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x1100...0x115F,      // Hangul Jamo
             0x2E80...0x303E,      // CJK radicals, Kangxi, CJK symbols
             0x3041...0x33FF,      // Hiragana through CJK compatibility
             0x3400...0x4DBF,      // CJK extension A
             0x4E00...0x9FFF,      // CJK unified
             0xA000...0xA4CF,      // Yi
             0xAC00...0xD7A3,      // Hangul syllables
             0xF900...0xFAFF,      // CJK compatibility ideographs
             0xFE30...0xFE6F,      // CJK compatibility forms
             0xFF00...0xFF60,      // Fullwidth forms
             0xFFE0...0xFFE6,
             0x1F300...0x1FAFF,    // emoji and pictographs
             0x20000...0x3FFFD:    // CJK extensions B onward
            return true
        default:
            return false
        }
    }

    /// The content width a stack of those lines needs, in points.
    ///
    /// ONE COLUMN OF SLACK, and it is deliberate. This measure is a floor the
    /// stack is given (`minWidth`), never a cut: a row still takes its natural
    /// width, so over-measuring costs a sliver of empty space at the right and
    /// under-measuring costs nothing worse than the old jitter, on the one file
    /// whose widest glyph the table above misjudges. The slack buys the common
    /// rounding case outright.
    static func contentWidth(columns: Int, advance: CGFloat) -> CGFloat {
        CGFloat(max(columns, 0) + 1) * advance
    }

    /// One glyph's advance in the monospaced system font at a given size —
    /// measured from the font rather than guessed, and cached on the main actor
    /// (where every caller is, being a view body) because otherwise every row of
    /// every file would ask the type engine the same question.
    @MainActor static func advance(ofSize size: CGFloat) -> CGFloat {
        if let cached = advances[size] { return cached }
        let font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
        let width = ("0" as NSString).size(withAttributes: [.font: font]).width
        advances[size] = width
        return width
    }

    @MainActor private static var advances: [CGFloat: CGFloat] = [:]
}

/// THE BACK-SWIPE AND A SIDEWAYS SCROLL CANNOT BOTH OWN THE LEFT EDGE — #405.
///
/// On a compact width the panel is a push (`SessionView`'s
/// `.navigationDestination`), so the system's interactive pop gesture claims
/// drags that begin within about 20pt of the screen's left edge. A file viewer
/// scrolled sideways has real content there, and the reader's drag to get back
/// to column zero popped the whole panel instead.
///
/// GATED ON THE OFFSET, NOT INSET AWAY. The other fix #405 offers is to inset
/// the scroll view past the edge-pan region, which would cost every file a strip
/// of its width forever to serve the case where the file is scrolled. This costs
/// the back-swipe only while there is somewhere to scroll back to, and the
/// moment the content is at column zero the gesture is the system's again —
/// which is also when a leftward drag has nothing else it could mean.
///
/// THE PREVIOUS VALUE IS RESTORED, and the navigation controller is held weakly
/// from the moment it is found rather than looked up again on the way out: by
/// the time this view leaves the window its responder chain is already detached,
/// so a second lookup would find nothing and leave the app with no back-swipe at
/// all. That is the failure worth writing code against.
struct InteractivePopGate: UIViewRepresentable {
    /// True while the content is scrolled off its leading edge.
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
    /// Hang the gate off a scroll view without giving it a size or a hit area.
    func interactivePopDisabled(_ disabled: Bool) -> some View {
        overlay(InteractivePopGate(disabled: disabled).frame(width: 0, height: 0).allowsHitTesting(false))
    }
}
