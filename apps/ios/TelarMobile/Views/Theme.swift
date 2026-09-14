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
    /// The gutter the composer's lane adds around that measure, so a pill's
    /// edges sit outside the text it holds rather than on it.
    static let readingGutter: CGFloat = 32
    static let body = Font.system(.body)
    static let bodyMedium = Font.system(.body, weight: .medium)
    static let rowTitle = Font.system(.subheadline, weight: .medium)
    /// A SLIM SIDEBAR ROW'S TITLE — one step below `rowTitle`, and the reason
    /// a row under a project header reads as an item rather than as another
    /// header. The ratio is the desktop's (session-row.tsx): a card's title is
    /// a size up from the caption beside it, a slim row's title sits between
    /// the two and carries no extra weight.
    static let rowTitleSlim = Font.system(.footnote)
    /// A BAND'S CAPTION — the small uppercase word that names a band of the
    /// sidebar, at the desktop's scale (`CAPTION`, apps/web/components/
    /// app-sidebar.tsx: 10px, semibold, uppercase, wide tracking). 10px has no
    /// Dynamic Type style of its own; `.caption2` is the nearest that scales
    /// with the reader's text size, which a hard 10 would not.
    static let bandCaption = Font.system(.caption2, weight: .semibold)
    /// A PROJECT GROUP'S NAME — the desktop's `text-[0.8125rem] font-semibold`
    /// (project-group.tsx). A header is a size up in WEIGHT from the slim rows
    /// beneath it while staying the same size, which is what makes the group
    /// read as "a project, then its conversations" rather than as a flat list.
    static let groupHeader = Font.system(.footnote, weight: .semibold)
    static let meta = Font.system(.caption)
    static let metaSmall = Font.system(.caption2)
    static let mono = Font.system(.caption, design: .monospaced)
    static let monoSmall = Font.system(.caption2, design: .monospaced)
    /// THE SUB-BODY RAMP, NAMED. The app writes its small type as a hard point
    /// size — `.system(size: 11)` — on a four-step ramp between 9 and 15 that
    /// nothing here ever named. A hard size is absolute: it does not move when
    /// the reader turns their text up, so every one of those sites silently
    /// ignores Dynamic Type, which is the one accessibility setting a phone
    /// user is most likely to have changed.
    ///
    /// These four are `Font.TextStyle`, not `Font`, so a call site keeps the
    /// weight and design it already had and changes only the size:
    ///
    ///     .font(.system(size: 13, weight: .medium))   // before
    ///     .font(.system(Theme.footnote, weight: .medium))  // after
    ///
    /// The ramp does not map onto the system styles one-for-one — iOS has no
    /// 9, 10 or 14pt style — so each token is the nearest style that scales,
    /// and two neighbouring literals collapse onto one token. That collapse is
    /// the point: a 10 and an 11 on the same row were never a deliberate two
    /// points apart, they were two people picking a small number.
    ///
    /// ONE KIND OF SITE KEEPS ITS ABSOLUTE SIZE: a glyph locked inside a fixed
    /// hit target — the composer's 44pt circles, the jump-to-bottom button.
    /// The frame cannot grow with the reader's text, and it clips, so a glyph
    /// that scaled inside it would only outgrow its own circle. Those need a
    /// `@ScaledMetric` frame, which is a layout change rather than a swap.
    static let captionTiny: Font.TextStyle = .caption2   // was 9
    static let caption: Font.TextStyle = .caption        // was 10, 11
    static let footnote: Font.TextStyle = .footnote      // was 12, 13
    static let subhead: Font.TextStyle = .subheadline    // was 14, 15
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
    /// THE ONE WAY A BAND ANNOUNCES ITSELF, so "Needs you" and the two shelves
    /// are the same kind of word rather than three small grey labels written on
    /// different days — which is the mistake the desktop made and then fixed by
    /// giving every caption `CAPTION` (app-sidebar.tsx). The tracking is the
    /// web's `tracking-wider`; uppercase at this size needs the extra air or
    /// the letters close up.
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
    /// THE COLUMN THE CONVERSATION LIVES IN — one definition, so every row at
    /// the top level of a session lands on the same two edges.
    ///
    /// A row that skips it does not look wrong until it has a BACKGROUND: an
    /// unfilled row merely sits too wide and nobody notices, while a filled
    /// one runs the whole detail view and, on an iPad with the panel open,
    /// reaches under the floating sidebar on one side and under the panel on
    /// the other. That is how the recap banner looked before it was removed.
    /// Use this for anything at the top level of a session.
    func readingColumn(gutter: CGFloat = 0) -> some View {
        self
            .frame(maxWidth: Theme.readingMeasure + gutter)
            .frame(maxWidth: .infinity)
    }
}
