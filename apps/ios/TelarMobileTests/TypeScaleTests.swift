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

    /// THE PER-FILE SWEEP PIN IS NOT HERE, AND MUST NOT COME BACK HERE.
    /// Counting the `.system(size:)` literals left in each swept file is a
    /// SOURCE-TEXT invariant, and it lives in `scripts/source-invariants.mjs`
    /// with the others of its kind.
    ///
    /// It was briefly a test in this file, resolving the source root from
    /// `#filePath` and reading the files off disk. That cannot work: `#filePath`
    /// is baked in at compile time as the path on the machine that COMPILED
    /// the test, while a unit test runs in the app's process on the
    /// destination. On a simulator sharing the Mac's filesystem it passed; on
    /// a device that path does not exist and it threw.
    ///
    /// The script runs in `verify.yml`, which gates every PR and needs no Mac,
    /// so the check now covers more than it did from in here. What belongs in
    /// this file is what needs the app: the tokens themselves, above.
}
