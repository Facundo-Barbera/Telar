import SwiftUI

/// A FIXED BOX AND THE GLYPH INSIDE IT, SCALING BY THE SAME RATIO (#674).
///
/// The Dynamic Type sweep (#248) converted absolute font sizes to text styles
/// everywhere but one shape: a glyph locked in a frame fixed in BOTH
/// dimensions. Those it deferred on purpose — the frame clips, so a glyph that
/// grew with the reader's text would only outgrow its own target. This is the
/// pass that makes the frames grow too, and it is the reason those sites were
/// deferred rather than mapped onto a rung and hoped over.
///
/// THE POINT IS THE SHARED RATIO, not the scaling on its own. Two
/// `@ScaledMetric`s — one seeded with the box, one with the glyph, both
/// `relativeTo: .body` — multiply by the SAME factor at every content size, so
/// 16-inside-44 keeps 16-inside-44's proportion from xSmall to AX5. Converting
/// the glyph to a `Font.TextStyle` and scaling only the box would NOT: Apple's
/// styles scale at different rates, so glyph and box would drift apart at the
/// extremes, which is the original failure inverted rather than fixed.
///
/// It also means NOTHING MOVES AT THE DEFAULT TEXT SIZE. The literals a caller
/// passes are the literals that were already there, and a reader who has not
/// touched the slider sees the pixels they saw before.
///
/// `.system(size:)` HERE IS THE ESCAPE HATCH #248 DOCUMENTS AND AVOIDS, used
/// where it is right: an icon in a tap target is not sub-body text, so the
/// four-step ramp does not describe it and there is no rung to land on. Prose
/// still takes a token. If you are holding a number that IS on the ramp, you
/// want `Theme.caption` and friends, not this.
///
/// `.body` is the reference style everywhere rather than whatever text happens
/// to sit next to a given target. Controls are body-sized by Apple's own
/// convention, and one reference means every tap target in the app grows by one
/// ratio — targets that scaled at different rates would be a worse answer than
/// targets that did not scale at all.
private struct ScaledGlyphBox: ViewModifier {
    @ScaledMetric private var side: CGFloat
    @ScaledMetric private var glyph: CGFloat
    private let weight: Font.Weight

    init(side: CGFloat, glyph: CGFloat, weight: Font.Weight) {
        _side = ScaledMetric(wrappedValue: side, relativeTo: .body)
        _glyph = ScaledMetric(wrappedValue: glyph, relativeTo: .body)
        self.weight = weight
    }

    func body(content: Content) -> some View {
        content
            .font(.system(size: glyph, weight: weight))
            .frame(width: side, height: side)
    }
}

/// The glyph half, for the targets whose box belongs to somebody else —
/// `ToolbarPill` draws the circle and its caller draws the symbol. Same
/// reference style as the box, so the two still move together across the gap.
private struct ScaledGlyph: ViewModifier {
    @ScaledMetric private var glyph: CGFloat
    private let weight: Font.Weight

    init(glyph: CGFloat, weight: Font.Weight) {
        _glyph = ScaledMetric(wrappedValue: glyph, relativeTo: .body)
        self.weight = weight
    }

    func body(content: Content) -> some View {
        content.font(.system(size: glyph, weight: weight))
    }
}

/// The box half, for the same split.
private struct ScaledSquare: ViewModifier {
    @ScaledMetric private var side: CGFloat

    init(side: CGFloat) {
        _side = ScaledMetric(wrappedValue: side, relativeTo: .body)
    }

    func body(content: Content) -> some View {
        content.frame(width: side, height: side)
    }
}

extension View {
    /// A glyph and the square it is locked in, scaling together. Replaces a
    /// `.font(.system(size:))` and a `.frame(width:height:)` that agreed with
    /// each other by hand and stopped agreeing the moment the reader moved the
    /// slider.
    func scaledGlyphBox(_ side: CGFloat, glyph: CGFloat, weight: Font.Weight = .regular) -> some View {
        modifier(ScaledGlyphBox(side: side, glyph: glyph, weight: weight))
    }

    /// The glyph alone, when its box is drawn by a wrapper.
    func scaledGlyph(_ glyph: CGFloat, weight: Font.Weight = .regular) -> some View {
        modifier(ScaledGlyph(glyph: glyph, weight: weight))
    }

    /// The square alone, when the glyph comes from a caller.
    func scaledSquare(_ side: CGFloat) -> some View {
        modifier(ScaledSquare(side: side))
    }
}
