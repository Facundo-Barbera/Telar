import Foundation
import Testing
@testable import TelarMobile

@Suite struct ComposerTextEditTests {
    private func edit(_ old: String, _ new: String) -> (range: NSRange, text: String)? {
        ComposerTextEdit.replacement(from: old, to: new)
    }

    @Test func anUnchangedDraftIsNoEditAtAll() {
        #expect(edit("fix the failing test", "fix the failing test") == nil)
        #expect(edit("", "") == nil)
    }

    @Test func aWordAppendedIsAnInsertionAtTheTailAndNothingElse() {
        let change = edit("fix the failing", "fix the failing test")
        #expect(change?.range == NSRange(location: 15, length: 0))
        #expect(change?.text == " test")
    }

    @Test func aRevisedGuessIsJustTheWordThatMoved() {
        let change = edit("I said recur", "I said record")
        #expect(change?.range == NSRange(location: 10, length: 2))
        #expect(change?.text == "ord")
    }

    @Test func aDeletionIsAnEmptyReplacementOverTheRunThatWent() {
        let change = edit("fix the failing test", "fix the test")
        #expect(change?.range == NSRange(location: 8, length: 8))
        #expect(change?.text == "")
    }

    @Test func clearingTheBoxAfterSendIsTheWholeRange() {
        let change = edit("fix the failing test", "")
        #expect(change?.range == NSRange(location: 0, length: 20))
        #expect(change?.text == "")
    }

    @Test func typingIntoAnEmptyBoxIsAnInsertionAtZero() {
        let change = edit("", "f")
        #expect(change?.range == NSRange(location: 0, length: 0))
        #expect(change?.text == "f")
    }

    @Test func aChangeInTheMiddleLeavesBothEndsAlone() {
        let change = edit("the quick brown fox", "the slow brown fox")
        #expect(change?.range == NSRange(location: 4, length: 5))
        #expect(change?.text == "slow")
    }

    @Test func aRepeatedRunDoesNotProduceAnOverlappingRange() {
        for pair in [("aaa", "aa"), ("aa", "aaa"), ("aaaa", "aa"), ("", "aaa"), ("aaa", "")] {
            guard let change = edit(pair.0, pair.1) else {
                Issue.record("\(pair) should be an edit")
                continue
            }
            #expect(change.range.length >= 0)
            #expect(change.range.location >= 0)
            #expect(change.range.location + change.range.length <= (pair.0 as NSString).length)

            #expect((pair.0 as NSString).replacingCharacters(in: change.range, with: change.text) == pair.1)
        }
    }

    @Test func theRangeIsInUtf16BecauseThatIsWhatTheFieldCountsIn() {
        let change = edit("hi 🙂", "hi 🙂 there")
        #expect(change?.range == NSRange(location: 5, length: 0))
        #expect(change?.text == " there")
    }

    @Test func anEditNeverStartsHalfwayThroughASurrogatePair() {
        guard let change = edit("ok 👍", "ok 👎") else {
            Issue.record("the emoji differ, so there is an edit")
            return
        }
        let old = "ok 👍" as NSString
        #expect(old.rangeOfComposedCharacterSequence(at: change.range.location).location == change.range.location)
        #expect(old.replacingCharacters(in: change.range, with: change.text) == "ok 👎")
    }

    @Test func aCombiningMarkIsNotSplitOffItsLetter() {
        let decomposed = "cafe\u{301}"
        guard let change = edit(decomposed, "cafe\u{301}s") else {
            Issue.record("the drafts differ, so there is an edit")
            return
        }
        #expect((decomposed as NSString).replacingCharacters(in: change.range, with: change.text) == "cafe\u{301}s")
    }

    @Test func twoSpellingsOfTheSameLetterAreStillAnEdit() {
        #expect(edit("cafe\u{301}", "caf\u{e9}") != nil)
    }

    private func caret(_ at: Int, _ range: NSRange, _ text: String) -> NSRange? {
        ComposerTextEdit.selection(NSRange(location: at, length: 0), after: range, replacedBy: text)
    }

    @Test func aCaretBeforeTheEditDoesNotMove() {
        #expect(caret(3, NSRange(location: 15, length: 0), " test") == NSRange(location: 3, length: 0))
    }

    @Test func aCaretAfterTheEditMovesByWhatTheEditChangedTheLengthBy() {
        #expect(caret(20, NSRange(location: 4, length: 5), "slow") == NSRange(location: 19, length: 0))
        #expect(caret(20, NSRange(location: 4, length: 4), "slower") == NSRange(location: 22, length: 0))
    }

    @Test func aCaretWhereTextIsInsertedFollowsTheTextIn() {
        #expect(caret(15, NSRange(location: 15, length: 0), " test") == NSRange(location: 20, length: 0))
    }

    @Test func aCaretInsideTheEditIsTheFieldsOwnAnswer() {
        #expect(caret(10, NSRange(location: 8, length: 8), "") == nil)
    }

    @Test func aSelectionSpanningTheEditIsTheFieldsOwnAnswerToo() {
        let spanning = NSRange(location: 2, length: 16)
        #expect(ComposerTextEdit.selection(spanning, after: NSRange(location: 8, length: 8), replacedBy: "") == nil)
    }

    @Test func aSelectionEntirelyAfterTheEditKeepsItsLength() {
        let after = NSRange(location: 16, length: 3)
        let moved = ComposerTextEdit.selection(after, after: NSRange(location: 4, length: 5), replacedBy: "slow")
        #expect(moved == NSRange(location: 15, length: 3))
    }

    @Test func clearingTheBoxLeavesTheCaretToTheField() {
        #expect(caret(7, NSRange(location: 0, length: 20), "") == nil)
    }
}
