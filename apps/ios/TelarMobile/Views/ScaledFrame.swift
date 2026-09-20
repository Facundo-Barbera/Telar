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
///
/// The three modifiers are internal rather than `private` only because the
/// `View` methods below hand them out; call those, not these.
struct ScaledGlyphBox: ViewModifier {
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
struct ScaledGlyph: ViewModifier {
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
struct ScaledSquare: ViewModifier {
    @ScaledMetric private var side: CGFloat

    init(side: CGFloat) {
        _side = ScaledMetric(wrappedValue: side, relativeTo: .body)
    }

    func body(content: Content) -> some View {
        content.frame(width: side, height: side)
    }
}

/// A BAR AS TALL AS THE TEXT IN IT (#717).
///
/// The sweep's rule — convert unless the container is fixed in BOTH dimensions
/// — left a third shape behind: a strip, toolbar, chip or row pinned to a
/// height with scaling text inside it. Correct at normal sizes, clipping at the
/// accessibility ones, and not a regression, because before the sweep the text
/// did not scale either. Half-finished rather than broken.
///
/// UNLIKE `scaledGlyphBox`, THE REFERENCE STYLE IS THE CALLER'S. A tap target
/// answers to the finger and wants one ratio across the whole app; a bar
/// answers to the words inside it, and a toolbar of `.caption` icons and a chip
/// of `.subheadline` text do not want the same growth. Pass the style the
/// content is actually drawn in.
///
/// THIS IS FOR A HEIGHT THAT BOUNDS TEXT, and nothing else. A `height: 1` rule
/// is a hairline, not a container — scaling it draws a thick line. A
/// `ProgressView().frame(height: 60)` reserves room for an image that is about
/// to arrive, and type has no opinion about how big that is. A `minHeight:` is
/// already the answer, since content grows past it, and a `maxHeight:` caps a
/// scroller whose content scrolls. None of those take this.
struct ScaledHeight: ViewModifier {
    @ScaledMetric private var height: CGFloat

    init(_ height: CGFloat, relativeTo style: Font.TextStyle) {
        _height = ScaledMetric(wrappedValue: height, relativeTo: style)
    }

    func body(content: Content) -> some View {
        content.frame(height: height)
    }
}

extension View {
    /// A fixed bar height that grows with the text inside it. `relativeTo` is
    /// the style that text is drawn in — see `ScaledHeight`.
    func scaledHeight(_ height: CGFloat, relativeTo style: Font.TextStyle) -> some View {
        modifier(ScaledHeight(height, relativeTo: style))
    }

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
