import SwiftUI
import UIKit

enum Theme {
    static let canvas = adaptive(light: 0xFCFCFC, dark: 0x0A0A0A)
    static let surface = adaptive(light: 0xFFFFFF, dark: 0x161616)
    static let fill = adaptive(light: 0xF4F4F5, dark: 0x252525)
    static let messageSurface = adaptive(light: 0xF1F1F3, dark: 0x252525)
    static let codeBackground = adaptive(light: 0xF4F4F5, dark: 0x252525)
    static let text = adaptive(light: 0x27272A, dark: 0xF5F5F5)
    static let textMuted = adaptive(light: 0x696973, dark: 0xA1A1A1)

    static let accent = Accent.indigo.fill
    static let statusAmber = adaptive(light: 0x8E5B01, dark: 0xF2A635)
    static let statusSky = adaptive(light: 0x007386, dark: 0x22BEDC)
    static let statusEmerald = adaptive(light: 0x02744E, dark: 0x2AC48A)
    static let statusRed = adaptive(light: 0xB71822, dark: 0xFF645E)
    static let sheet = adaptive(light: 0xF6F6F6, dark: 0x101010)
    static let card = adaptive(light: 0xFFFFFF, dark: 0x161616)
    static let subtle = adaptive(light: 0xF1F1F3, dark: 0x252525)
    static let subtleStrong = adaptive(light: 0xF0F0F1, dark: 0x2F2F2F)

    static let popover = adaptive(light: 0xFFFFFF, dark: 0x1C1C1C)

    static let composerSurface = popover
    static let primaryGlyph = Accent.indigo.glyph
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

    static let readingMeasure: CGFloat = 680

    static let readingGutter: CGFloat = 32
    static let body = Font.system(.body)
    static let bodyMedium = Font.system(.body, weight: .medium)
    static let rowTitle = Font.system(.subheadline, weight: .medium)

    static let rowTitleSlim = Font.system(.footnote)

    static let bandCaption = Font.system(.caption2, weight: .semibold)

    static let groupHeader = Font.system(.footnote, weight: .semibold)
    static let meta = Font.system(.caption)
    static let metaSmall = Font.system(.caption2)
    static let mono = Font.system(.caption, design: .monospaced)
    static let monoSmall = Font.system(.caption2, design: .monospaced)

    enum Accent: String, CaseIterable, Sendable {
        case indigo, sky, sea, moss, amber, rose, plum, violet

        var fill: Color {
            switch self {
            case .indigo: Theme.adaptive(light: 0x2F58B9, dark: 0x6594FA)
            case .sky: Theme.adaptive(light: 0x0067AB, dark: 0x1AA2EB)
            case .sea: Theme.adaptive(light: 0x006F7B, dark: 0x21ABB8)
            case .moss: Theme.adaptive(light: 0x3B6E2F, dark: 0x6BAC5C)
            case .amber: Theme.adaptive(light: 0x8A5100, dark: 0xCE871B)
            case .rose: Theme.adaptive(light: 0xAA2340, dark: 0xEE6476)
            case .plum: Theme.adaptive(light: 0x8B3790, dark: 0xC675CB)
            case .violet: Theme.adaptive(light: 0x6745B5, dark: 0x9D82F1)
            }
        }

        var glyph: Color {
            switch self {
            case .indigo: Theme.adaptive(light: 0xFFFFFF, dark: 0x070F21)
            case .sky: Theme.adaptive(light: 0xFFFFFF, dark: 0x00111F)
            case .sea: Theme.adaptive(light: 0xFFFFFF, dark: 0x001418)
            case .moss: Theme.adaptive(light: 0xFFFFFF, dark: 0x061304)
            case .amber: Theme.adaptive(light: 0xFFFFFF, dark: 0x1A0C00)
            case .rose: Theme.adaptive(light: 0xFFFFFF, dark: 0x1E070A)
            case .plum: Theme.adaptive(light: 0xFFFFFF, dark: 0x180919)
            case .violet: Theme.adaptive(light: 0xFFFFFF, dark: 0x100B1F)
            }
        }
    }

    static let captionTiny: Font.TextStyle = .caption2
    static let caption: Font.TextStyle = .caption
    static let footnote: Font.TextStyle = .footnote
    static let subhead: Font.TextStyle = .subheadline
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

    func bandCaption() -> some View {
        font(Theme.bandCaption).textCase(.uppercase).tracking(0.6).foregroundStyle(Theme.textMuted)
    }
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

extension View {
    func readingColumn(gutter: CGFloat = 0) -> some View {
        self
            .frame(maxWidth: Theme.readingMeasure + gutter)
            .frame(maxWidth: .infinity)
    }
}
