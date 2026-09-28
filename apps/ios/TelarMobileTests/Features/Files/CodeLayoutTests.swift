import Foundation
import Testing
@testable import TelarMobile

/// The file viewer's width measure — issue #405. This is the number that makes
/// the horizontal extent stable before a single row is laid out, so the cases
/// that matter are the ones a plain character count gets wrong.
@Suite struct CodeLayoutTests {
    @Test func anAsciiLineIsItsCharacterCount() {
        #expect(CodeLayout.columns("") == 0)
        #expect(CodeLayout.columns("let x = 1") == 9)
    }

    /// A TAB ADVANCES TO THE NEXT STOP, it does not occupy one cell. An indented
    /// file measured by character count comes out far too narrow, which is the
    /// under-measure that would put the jitter straight back.
    @Test func tabsAdvanceToTheNextStop() {
        #expect(CodeLayout.columns("\t") == 4)
        #expect(CodeLayout.columns("\t\t") == 8)
        #expect(CodeLayout.columns("ab\tc") == 5)
        #expect(CodeLayout.columns("abcd\te") == 9)
        // Already on a stop: the tab still moves a full four.
        #expect(CodeLayout.columns("abcd\t") == 8)
    }

    /// TWO CELLS FOR THE WIDE SCRIPTS, one for everything else — a file of
    /// Japanese comments is twice as wide as its character count says.
    @Test func wideScriptsAndEmojiTakeTwoCells() {
        #expect(CodeLayout.columns("日本語") == 6)
        #expect(CodeLayout.columns("한국") == 4)
        #expect(CodeLayout.columns("# 犬") == 4)
        #expect(CodeLayout.columns("🚀") == 2)
    }

    /// GRAPHEMES, NOT SCALARS. A combining accent and a skin-toned emoji take no
    /// more room than the mark they modify, and counting scalars would widen a
    /// file for them.
    @Test func combinedGraphemesCountOnce() {
        #expect(CodeLayout.columns("e\u{0301}") == 1)
        #expect(CodeLayout.columns("é") == 1)
        #expect(CodeLayout.columns("👍🏽") == 2)
        // Accented latin is one cell, so a Spanish comment is not doubled.
        #expect(CodeLayout.columns("# año") == 5)
    }

    @Test func theWidestLineWinsAndEmptyLinesCountForNothing() {
        #expect(CodeLayout.widestLineColumns("a\nbbb\ncc") == 3)
        #expect(CodeLayout.widestLineColumns("\n\n\n") == 0)
        #expect(CodeLayout.widestLineColumns("") == 0)
        // The last line has no terminator and still counts.
        #expect(CodeLayout.widestLineColumns("a\nbbbbb") == 5)
        // Tabs and wide glyphs measure the same inside a file as on their own:
        // `short` is 5, `\tif x:` is the tab's full stop of 4 plus 5, and `日本`
        // is 4 — so the tabbed line wins at 9. This read 7 until the suite was
        // first executed by CI (#755); 7 contradicts the sentence above it and
        // `tabsAdvanceToTheNextStop`, which pins `columns("\t")` at 4.
        #expect(CodeLayout.widestLineColumns("short\n\tif x:\n日本") == 9)
        #expect(CodeLayout.widestLineColumns("\tif x:") == CodeLayout.columns("\tif x:"))
    }

    @Test func aSingleLineWithNoNewlineIsTheWholeMeasure() {
        #expect(CodeLayout.widestLineColumns("one long line") == 13)
    }

    /// THE MEASURE IS A FLOOR WITH ONE COLUMN OF SLACK, never a cut — the row
    /// keeps its own width, so the slack only buys the rounding case.
    @Test func contentWidthIsColumnsPlusSlackTimesTheAdvance() {
        #expect(CodeLayout.contentWidth(columns: 0, advance: 7) == 7)
        #expect(CodeLayout.contentWidth(columns: 10, advance: 7) == 77)
        // A negative count cannot come out of the measures above; it must not
        // turn into a negative width if one ever does.
        #expect(CodeLayout.contentWidth(columns: -5, advance: 7) == 7)
    }
}
