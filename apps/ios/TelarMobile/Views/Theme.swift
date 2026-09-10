import SwiftUI
import UIKit

/// sRGB conversions of the default roles in apps/web/app/globals.css.
/// Neutral surfaces, blue human actions, and the same five work states.
enum Theme {
    static let canvas = adaptive(light: 0xFCFCFC, dark: 0x0A0A0A)
    static let surface = adaptive(light: 0xFFFFFF, dark: 0x161616)
    static let fill = adaptive(light: 0xF4F4F5, dark: 0x252525)
    static let messageSurface = adaptive(light: 0xF1F1F3, dark: 0x252525)
    static let codeBackground = adaptive(light: 0xF4F4F5, dark: 0x252525)
    static let text = adaptive(light: 0x27272A, dark: 0xF5F5F5)
    static let textMuted = adaptive(light: 0x696973, dark: 0xA1A1A1)
    static let accent = adaptive(light: 0x2F58B9, dark: 0x6594FA)
    static let statusAmber = adaptive(light: 0x8E5B01, dark: 0xF2A635)
    static let statusIndigo = adaptive(light: 0x8E5B01, dark: 0xF2A635)
    static let statusSky = adaptive(light: 0x007386, dark: 0x22BEDC)
    static let statusViolet = adaptive(light: 0x794ED7, dark: 0xA486FD)
    static let statusEmerald = adaptive(light: 0x02744E, dark: 0x2AC48A)
    static let statusRed = adaptive(light: 0xB71822, dark: 0xFF645E)
    static let sheet = adaptive(light: 0xF6F6F6, dark: 0x101010)
    static let card = adaptive(light: 0xFFFFFF, dark: 0x161616)
    static let textMuted2 = adaptive(light: 0x696973, dark: 0xA1A1A1)
    static let textTertiary = adaptive(light: 0x696973, dark: 0xA1A1A1)
    static let subtle = adaptive(light: 0xF1F1F3, dark: 0x252525)
    static let subtleStrong = adaptive(light: 0xF0F0F1, dark: 0x2F2F2F)
    static let composerSurface = adaptive(light: 0xFFFFFF, dark: 0x1C1C1C)
    static let primaryGlyph = adaptive(light: 0xFFFFFF, dark: 0x070F21)
    static let primaryFill = accent
    static let border = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 1, alpha: 0.10) : UIColor(rgb: 0xE4E4E7) })
    static let borderSubtle = border.opacity(0.6)
    static let chevron = textMuted
    static let dangerFill = statusRed.opacity(0.14)
    static let dangerGlyph = statusRed
    static let radiusControl: CGFloat = 8
    static let radiusRow: CGFloat = 8
    static let radiusCard: CGFloat = 14
    static let radiusBubble: CGFloat = 18
    static let radiusComposer: CGFloat = 22
    static let radiusDrawer: CGFloat = 16
    /// The transcript and composer lane, in points. About 70 characters of
    /// body text per line — the web's 50rem measure at its smaller type.
    static let readingMeasure: CGFloat = 680
    static let body = Font.system(.body)
    static let bodyMedium = Font.system(.body, weight: .medium)
    static let rowTitle = Font.system(.subheadline, weight: .medium)
    static let meta = Font.system(.caption)
    static let metaSmall = Font.system(.caption2)
    static let mono = Font.system(.caption, design: .monospaced)
    static let monoSmall = Font.system(.caption2, design: .monospaced)
    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { UIColor(rgb: $0.userInterfaceStyle == .dark ? dark : light) })
    }
}

extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(red: CGFloat((rgb >> 16) & 0xFF) / 255,
                  green: CGFloat((rgb >> 8) & 0xFF) / 255,
                  blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}
extension View {
    func hairline(_ radius: CGFloat) -> some View {
        overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Theme.border, lineWidth: 1))
    }
    func tabularNumbers() -> some View { monospacedDigit() }
}
struct SteppedPulseDot: View {
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        if reduceMotion {
            Circle().fill(color).frame(width: 7, height: 7)
        } else {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Circle().fill(color).frame(width: 7, height: 7)
                    .opacity(Int(context.date.timeIntervalSinceReferenceDate) % 2 == 0 ? 1 : 0.5)
            }
        }
    }
}
