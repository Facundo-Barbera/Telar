import Foundation
import Testing
@testable import TelarMobile

/// WHAT THE COMPOSER TELLS THE KEYBOARD CHANGED (#624).
///
/// The bug was that it told it nothing: `UITextView.text = draft` hands UIKit a
/// new buffer, drops the marked range and the correction context, and never
/// travels through `UITextInputDelegate` — so the keyboard went on correcting
/// against a sentence that was no longer in the box. Dictation made it constant
/// rather than occasional, because an interim transcript rewrites the draft
/// several times a second.
///
/// The cure needs a RANGE, and the range is the only half of this that a test
/// can drive without a phone: everything below is two strings in and one edit
/// out. What the keyboard then does with that edit is a behaviour on hardware,
/// and this file deliberately does not pretend to cover it.
@Suite struct ComposerTextEditTests {
    private func edit(_ old: String, _ new: String) -> (range: NSRange, text: String)? {
        ComposerTextEdit.replacement(from: old, to: new)
    }

    // MARK: the run that differs

    @Test func anUnchangedDraftIsNoEditAtAll() {
        // The commonest update pass by far: SwiftUI re-renders the composer for
        // focus, for a queued turn, for a running one, and the text is the same
        // text. Touching the field on any of those was the bug's volume.
        #expect(edit("fix the failing test", "fix the failing test") == nil)
        #expect(edit("", "") == nil)
    }

    @Test func aWordAppendedIsAnInsertionAtTheTailAndNothingElse() {
        // THE DICTATION CASE. The keyboard's context for everything before the
        // insertion is untouched, which is the entire point.
        let change = edit("fix the failing", "fix the failing test")
        #expect(change?.range == NSRange(location: 15, length: 0))
        #expect(change?.text == " test")
    }

    @Test func aRevisedGuessIsJustTheWordThatMoved() {
        // "recur" → "record" → "recording": the service revising its own last
        // word, which is what an interim result is. Only the tail differs.
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

    /// A repeated run is where a naive prefix-and-suffix diff overlaps itself
    /// and reports a negative length.
    @Test func aRepeatedRunDoesNotProduceAnOverlappingRange() {
        for pair in [("aaa", "aa"), ("aa", "aaa"), ("aaaa", "aa"), ("", "aaa"), ("aaa", "")] {
            guard let change = edit(pair.0, pair.1) else {
                Issue.record("\(pair) should be an edit")
                continue
            }
            #expect(change.range.length >= 0)
            #expect(change.range.location >= 0)
            #expect(change.range.location + change.range.length <= (pair.0 as NSString).length)
            // The edit must actually produce the new draft, which is the only
            // property that matters and the one the arithmetic can break.
            #expect((pair.0 as NSString).replacingCharacters(in: change.range, with: change.text) == pair.1)
        }
    }

    // MARK: the offsets are the field's, not Swift's

    @Test func theRangeIsInUtf16BecauseThatIsWhatTheFieldCountsIn() {
        // "é" is one Character and one UTF-16 unit; "🙂" is one Character and
        // TWO. A `String.Index` diff would be right about the text and wrong
        // about the position the field can make.
        let change = edit("hi 🙂", "hi 🙂 there")
        #expect(change?.range == NSRange(location: 5, length: 0))
        #expect(change?.text == " there")
    }

    @Test func anEditNeverStartsHalfwayThroughASurrogatePair() {
        // These two emoji share their high surrogate, so a plain UTF-16 scan
        // finds a common prefix that ends INSIDE the pair. A range starting
        // there is not a position `UITextView` will make.
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

    /// Swift reads these two as the same string — canonical equivalence — and
    /// the field does not. Reporting "no edit" would leave the box and the
    /// draft permanently disagreeing about which one is in there.
    @Test func twoSpellingsOfTheSameLetterAreStillAnEdit() {
        #expect(edit("cafe\u{301}", "caf\u{e9}") != nil)
    }

    // MARK: where the caret ends up

    private func caret(_ at: Int, _ range: NSRange, _ text: String) -> NSRange? {
        ComposerTextEdit.selection(NSRange(location: at, length: 0), after: range, replacedBy: text)
    }

    @Test func aCaretBeforeTheEditDoesNotMove() {
        // Somebody fixing a typo at the front while a dictation writes at the
        // tail. The old assignment threw their caret to the end of the draft.
        #expect(caret(3, NSRange(location: 15, length: 0), " test") == NSRange(location: 3, length: 0))
    }

    @Test func aCaretAfterTheEditMovesByWhatTheEditChangedTheLengthBy() {
        #expect(caret(20, NSRange(location: 4, length: 5), "slow") == NSRange(location: 19, length: 0))
        #expect(caret(20, NSRange(location: 4, length: 4), "slower") == NSRange(location: 22, length: 0))
    }

    @Test func aCaretWhereTextIsInsertedFollowsTheTextIn() {
        // THE DICTATION CASE AGAIN, and the reason the two tests are ordered:
        // a caret at the end of the draft with a phrase landing there is both
        // "before the edit" and "after it", and the person expects to be left
        // behind the words they just said.
        #expect(caret(15, NSRange(location: 15, length: 0), " test") == NSRange(location: 20, length: 0))
    }

    @Test func aCaretInsideTheEditIsTheFieldsOwnAnswer() {
        // `nil` means "leave what `replace` chose" — there is no honest place to
        // put a caret that was standing in the text that just went.
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
        // Everything was selected or the caret was inside; either way there is
        // nothing left to be beside. The field puts it at zero.
        #expect(caret(7, NSRange(location: 0, length: 20), "") == nil)
    }
}
