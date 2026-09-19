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

    /// A SWEPT FILE STAYS SWEPT. The sweep is per-file and lands over many
    /// PRs, so the failure it invites is silent: a file converted in March
    /// grows a fresh `.system(size:)` in April and nobody notices, because
    /// nothing about an absolute size looks wrong until you turn your text up.
    ///
    /// This counts the literals left in each file the sweep has been through
    /// and pins the number. Zero where the file is finished; a stated count
    /// where sites are deliberately held back, each documented in the file
    /// itself — a glyph inside a fixed, clipped hit target, or a grid whose
    /// cells are pinned to a fixed width AND height. Those want a
    /// `@ScaledMetric` frame, which is a layout change rather than a token
    /// swap, so they land in their own pass and this number drops when it does.
    ///
    /// Read off source rather than the test bundle: `#filePath` is absolute at
    /// compile time, and the sources are what the count is about.
    @Test func sweptFilesKeepOnlyTheirDocumentedAbsoluteSizes() throws {
        // <repo>/apps/ios/TelarMobileTests/TypeScaleTests.swift → <repo>/apps/ios
        let iosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let expected: KeyValuePairs<String, Int> = [
            "TelarMobile/Views/TranscriptViews.swift": 0,
            // The composer's send/attach/stop circles, the model pill and the
            // jump-to-bottom button — 44pt and 36pt fixed squares (#449).
            "TelarMobile/Views/SessionView.swift": 9,
            // The run button's 44pt square and the markdown marker beside it.
            "TelarMobile/Views/Panel/NotebookSurface.swift": 2,
            // DataframeGrid's 96×30 header and 96×22 cells.
            "TelarMobile/Views/Panel/CellOutputView.swift": 3,
            "TelarMobile/Views/DiffView.swift": 0,
            // The file strip's 28×28 tree toggle.
            "TelarMobile/Views/Panel/FilesSurface.swift": 1,
        ]
        for (path, allowed) in expected {
            let source = try String(contentsOf: iosRoot.appending(path: path), encoding: .utf8)
            let found = source.components(separatedBy: ".system(size:").count - 1
            #expect(found == allowed, "\(path) has \(found) absolute sizes, expected \(allowed)")
        }
    }
}
