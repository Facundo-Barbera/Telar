import SwiftUI

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

struct ScaledSquare: ViewModifier {
    @ScaledMetric private var side: CGFloat

    init(side: CGFloat) {
        _side = ScaledMetric(wrappedValue: side, relativeTo: .body)
    }

    func body(content: Content) -> some View {
        content.frame(width: side, height: side)
    }
}

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
    func scaledHeight(_ height: CGFloat, relativeTo style: Font.TextStyle) -> some View {
        modifier(ScaledHeight(height, relativeTo: style))
    }

    func scaledGlyphBox(_ side: CGFloat, glyph: CGFloat, weight: Font.Weight = .regular) -> some View {
        modifier(ScaledGlyphBox(side: side, glyph: glyph, weight: weight))
    }

    func scaledGlyph(_ glyph: CGFloat, weight: Font.Weight = .regular) -> some View {
        modifier(ScaledGlyph(glyph: glyph, weight: weight))
    }

    func scaledSquare(_ side: CGFloat) -> some View {
        modifier(ScaledSquare(side: side))
    }
}
