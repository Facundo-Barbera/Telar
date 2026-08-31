import SwiftUI
import UIKit

/// Telar Mobile's design tokens, ported from t3code's role palette
/// (packages/shared/src/themePalettes.ts + the compiled default stylesheet).
/// This is their neutral "default" theme — zinc steps in light, translucent
/// white overlays over near-black in dark — with their blue primary.
///
/// THE STRUCTURAL RULES, which matter more than any one value:
///  - Dark borders and fills are WHITE AT LOW ALPHA (4–8%), never opaque
///    grays; light mode uses opaque zinc steps.
///  - Dark surfaces are lifted by lightness + hairline, never by shadow.
///    Shadows exist only in light mode: big blur, low opacity.
///  - Status colors: amber = needs approval, indigo = awaiting input,
///    sky = working (the ONLY one that animates), violet = plan,
///    emerald = done. Dark variants are the -300 tint at ~90% alpha,
///    never the light -500/-600.
///  - Type: body 14pt, metadata 10–13pt, weights regular/medium only,
///    tabular digits on every number.
enum Theme {
    // MARK: surfaces

    /// canvas — the page. zinc-25 / neutral-950.
    static let canvas = adaptive(light: 0xFCFCFC, dark: 0x0A0A0A)
    /// card / composer surface. white / background lifted 3–4% toward white.
    static let surface = adaptive(light: 0xFFFFFF, dark: 0x151515)
    /// secondary/muted fill. zinc-50 / white 4%.
    static let fill = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.04)
            : UIColor(rgb: 0xFAFAFA)
    })
    /// accent fill (hover/selected rows, user bubble in default theme).
    /// zinc-100 / white 4%.
    static let messageSurface = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.06)
            : UIColor(rgb: 0xF4F4F5)
    })
    /// code block background.
    static let codeBackground = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.05)
            : UIColor(rgb: 0xF7F7F8)
    })

    // MARK: ink

    /// text — zinc-800 / neutral-100.
    static let text = adaptive(light: 0x27272A, dark: 0xF5F5F5)
    /// muted text — zinc-500 / neutral-500 blended toward white.
    static let textMuted = adaptive(light: 0x71717A, dark: 0x8B8B8B)
    /// hairline. zinc-200 opaque / white 8%.
    static let border = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.08)
            : UIColor(rgb: 0xE4E4E7)
    })

    // MARK: accent

    /// primary — oklch(.488 .217 264) light, oklch(.571 .21 264) dark.
    static let accent = adaptive(light: 0x1B4ED8, dark: 0x346BF1)

    // MARK: status (the sidebar's whole vocabulary)

    /// Needs approval / blocked.
    static let statusAmber = adaptive(light: 0xD97706, dark: 0xFCD34D, darkAlpha: 0.9)
    /// Awaiting input (a question).
    static let statusIndigo = adaptive(light: 0x4F46E5, dark: 0xA5B4FC, darkAlpha: 0.9)
    /// Working / connecting — the only status that animates.
    static let statusSky = adaptive(light: 0x0284C7, dark: 0x7DD3FC, darkAlpha: 0.8)
    /// Plan ready.
    static let statusViolet = adaptive(light: 0x7C3AED, dark: 0xC4B5FD, darkAlpha: 0.9)
    /// Done.
    static let statusEmerald = adaptive(light: 0x059669, dark: 0x6EE7B7, darkAlpha: 0.9)
    /// Failed / destructive text. red-700 / red-400.
    static let statusRed = adaptive(light: 0xB91C1C, dark: 0xF87171)

    // MARK: shape — one knob, five stops (6/8/10/14/18) + the specials

    static let radiusControl: CGFloat = 8
    static let radiusRow: CGFloat = 8
    static let radiusCard: CGFloat = 10
    static let radiusBubble: CGFloat = 18
    static let radiusComposer: CGFloat = 22
    static let radiusDrawer: CGFloat = 16

    // MARK: type

    /// Chat body: 14pt with a relaxed line.
    static let body = Font.system(size: 14)
    static let bodyMedium = Font.system(size: 14, weight: .medium)
    /// Row titles: small and medium, never large and bold.
    static let rowTitle = Font.system(size: 14, weight: .medium)
    /// Metadata: 12pt regular.
    static let meta = Font.system(size: 12)
    static let metaSmall = Font.system(size: 11)
    /// Code and labels that name files/commands.
    static let mono = Font.system(size: 12, design: .monospaced)
    static let monoSmall = Font.system(size: 11, design: .monospaced)

    private static func adaptive(light: UInt32, dark: UInt32, darkAlpha: CGFloat = 1) -> Color {
        Color(UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor(rgb: dark).withAlphaComponent(darkAlpha)
                : UIColor(rgb: light)
        })
    }
}

extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}

// MARK: - shared visual idioms

extension View {
    /// t3code's hairline: 1px border at low alpha, the whole of dark-mode
    /// elevation. Light mode may add the soft ambient shadow separately.
    func hairline(_ radius: CGFloat) -> some View {
        overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Theme.border, lineWidth: 1))
    }

    /// Every number in the app wears tabular digits — timestamps, counts,
    /// token figures. A t3code constant.
    func tabularNumbers() -> some View {
        monospacedDigit()
    }
}

/// The stepped status pulse: t3code dots don't breathe smoothly, they
/// quantize opacity into discrete steps (steps(6) over 2s) — a terminal-LED
/// cadence. TimelineView gives us the same quantization for free.
struct SteppedPulseDot: View {
    let color: Color

    var body: some View {
        TimelineView(.periodic(from: .now, by: 2.0 / 6.0)) { context in
            let step = Int(context.date.timeIntervalSinceReferenceDate / (2.0 / 6.0)) % 6
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
                .opacity(step < 3 ? 1 : 0.5)
        }
    }
}
