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
    /// THE ANCHOR HUE, AND IT BELONGS TO THE COCKPIT — see `Accent`. Indigo is
    /// the default on both platforms, and this reads it from the table rather
    /// than restating it so the two cannot drift.
    static let accent = Accent.indigo.fill
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
    /// THE COMPOSER'S TWO CORNERS, BECAUSE IT HAS TWO SHAPES. At rest the box
    /// is a 54pt pill beside a 44pt send button and the corner is half its
    /// height — a pill, not a rounded rectangle. Focused it grows into a card
    /// that holds seven lines, and a card at 27 looks like a lozenge, so the
    /// corner comes in as the box goes up. That easing between them is the
    /// affordance: the composer visibly becomes a different object when you
    /// start writing, which the desktop's static box does not do.
    ///
    /// #250 item 12 asked whether the web should gain that or iOS should lose
    /// it, and the owner kept it — the defect was never the animation, it was
    /// that 20 and 27 were literals at three call sites in no scale at all.
    /// They are outside the proportional ladder ON PURPOSE, for the same reason
    /// `--control-radius` is on the web: this is one object at one size, and a
    /// pill's corner is a function of its own height rather than of a step.
    static let radiusComposerRest: CGFloat = 27
    static let radiusComposerFocused: CGFloat = 20
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

    /// THE EIGHT ACCENTS, AND WHOSE CHOICE THEY ARE.
    ///
    /// The cockpit lets a person move `--primary` around the wheel
    /// (globals.css, "ACCENTS — the anchor hue as a setting"). The phone had no
    /// appearance settings at all, so the look you chose did not travel: pick
    /// rose on the desktop, open the phone, it is indigo. Issue #250 item 11
    /// settled WHOSE setting it is — **the phone follows its paired cockpit**.
    /// It gets no picker of its own, ever; the accent is the cockpit's property
    /// and the phone is showing you that cockpit's sessions.
    ///
    /// WHAT IS HERE AND WHAT IS NOT. This is the table, and the table is live:
    /// `Theme.accent` and `Theme.primaryGlyph` ARE this enum's indigo row, so
    /// the default is provably the same colour the cockpit ships and nothing
    /// below is an unused token. Carrying the paired cockpit's choice over the
    /// wire is a follow-up — when it lands, it replaces the two `.indigo`
    /// references above with the stored value and nothing else changes.
    ///
    /// THE VALUES ARE CONVERTED, NOT CHOSEN. Each is its `oklch()` from
    /// globals.css in sRGB, clipped the way the rest of this file's ports are:
    /// lightness pinned at 0.488 light / 0.68 dark so every accent keeps the
    /// same contrast maths, and chroma per-hue because sRGB's gamut is not
    /// round — sea and moss run out of room long before rose does. The dark
    /// glyph re-tints with the hue, which is why it is per-accent rather than
    /// one near-black: a rose accent with an indigo-tinted glyph on it is the
    /// drift this table exists to prevent.
    enum Accent: String, CaseIterable, Sendable {
        case indigo, sky, sea, moss, amber, rose, plum, violet

        /// The fill — the cockpit's `--primary` on this hue.
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

        /// What reads ON the fill — the cockpit's `--primary-foreground`. White
        /// in light on every hue; in dark it is `oklch(0.17 0.04 <hue>)`, the
        /// hue's own near-black.
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
