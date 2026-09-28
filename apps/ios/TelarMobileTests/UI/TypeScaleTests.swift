import SwiftUI
import Testing
@testable import TelarMobile

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

    @Test func theFourStepsAreFourDistinctStyles() {
        let steps: [Font.TextStyle] = [Theme.captionTiny, Theme.caption, Theme.footnote, Theme.subhead]
        #expect(Set(steps).count == steps.count)
    }
}
