import Foundation
import Testing
@testable import TelarMobile

@Suite struct CodeLayoutTests {
    @Test func anAsciiLineIsItsCharacterCount() {
        #expect(CodeLayout.columns("") == 0)
        #expect(CodeLayout.columns("let x = 1") == 9)
    }

    @Test func tabsAdvanceToTheNextStop() {
        #expect(CodeLayout.columns("\t") == 4)
        #expect(CodeLayout.columns("\t\t") == 8)
        #expect(CodeLayout.columns("ab\tc") == 5)
        #expect(CodeLayout.columns("abcd\te") == 9)
        #expect(CodeLayout.columns("abcd\t") == 8)
    }

    @Test func wideScriptsAndEmojiTakeTwoCells() {
        #expect(CodeLayout.columns("日本語") == 6)
        #expect(CodeLayout.columns("한국") == 4)
        #expect(CodeLayout.columns("# 犬") == 4)
        #expect(CodeLayout.columns("🚀") == 2)
    }

    @Test func combinedGraphemesCountOnce() {
        #expect(CodeLayout.columns("e\u{0301}") == 1)
        #expect(CodeLayout.columns("é") == 1)
        #expect(CodeLayout.columns("👍🏽") == 2)
        #expect(CodeLayout.columns("# año") == 5)
    }

    @Test func theWidestLineWinsAndEmptyLinesCountForNothing() {
        #expect(CodeLayout.widestLineColumns("a\nbbb\ncc") == 3)
        #expect(CodeLayout.widestLineColumns("\n\n\n") == 0)
        #expect(CodeLayout.widestLineColumns("") == 0)
        #expect(CodeLayout.widestLineColumns("a\nbbbbb") == 5)
        #expect(CodeLayout.widestLineColumns("short\n\tif x:\n日本") == 9)
        #expect(CodeLayout.widestLineColumns("\tif x:") == CodeLayout.columns("\tif x:"))
    }

    @Test func aSingleLineWithNoNewlineIsTheWholeMeasure() {
        #expect(CodeLayout.widestLineColumns("one long line") == 13)
    }

    @Test func contentWidthIsColumnsPlusSlackTimesTheAdvance() {
        #expect(CodeLayout.contentWidth(columns: 0, advance: 7) == 7)
        #expect(CodeLayout.contentWidth(columns: 10, advance: 7) == 77)
        #expect(CodeLayout.contentWidth(columns: -5, advance: 7) == 7)
    }
}
