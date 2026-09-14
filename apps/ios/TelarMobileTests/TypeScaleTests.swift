import SwiftUI
import Testing
@testable import TelarMobile

/// THE FOUR TOKENS ARE DYNAMIC TYPE STYLES, NOT SIZES. That is the whole
/// point of them: a `Font.TextStyle` moves when the reader turns their text
/// up, and the `.system(size:)` literals they replace do not. Pinning each
/// one here means a later "this looked a bit big, let me nudge it" cannot
/// quietly put an absolute size back behind a token's name.
@Suite struct TypeScaleTests {
    @Test func captionTinyIsCaption2() {
        #expect(Theme.captionTiny == .caption2)
    }

    @Test func captionIsCaption() {
        #expect(Theme.caption == .caption)
    }

    @Test func footnoteIsFootnote() {
        #expect(Theme.footnote == .footnote)
    }

    @Test func subheadIsSubheadline() {
        #expect(Theme.subhead == .subheadline)
    }

    /// THE RAMP ONLY GOES ONE WAY. Four tokens over four rungs, each one a
    /// distinct style — if two ever collapsed onto the same style the ramp
    /// would have three steps and the sweep would be flattening the type it
    /// was meant to preserve.
    @Test func theFourStepsAreFourDistinctStyles() {
        let steps: [Font.TextStyle] = [Theme.captionTiny, Theme.caption, Theme.footnote, Theme.subhead]
        #expect(Set(steps).count == steps.count)
    }
}
