import Foundation
import Testing
@testable import TelarMobile

@Suite struct DictationDraftWriterTests {
    private func guess(_ text: String) -> DictationWords { DictationWords(text: text, final: false) }
    private func settled(_ text: String) -> DictationWords { DictationWords(text: text, final: true) }

    @Test func eachGuessReplacesTheLastInTheBox() {
        var writer = DictationDraftWriter()
        var draft = ""
        for word in ["recur", "record", "recording"] {
            draft = writer.write(guess(word), into: draft)
        }
        #expect(draft == "recording")
    }

    @Test func aFinalSettlesTheWordsAndTheNextUtteranceStartsAfterThem() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("fix the"), into: "")
        draft = writer.write(settled("fix the failing test"), into: draft)
        #expect(draft == "fix the failing test")
        #expect(writer.unconfirmed == nil)

        draft = writer.write(guess("and"), into: draft)
        draft = writer.write(settled("and push it"), into: draft)
        #expect(draft == "fix the failing test and push it")
    }

    @Test func aFinalisedSilenceTakesTheUnconfirmedGuessBackOut() {
        var writer = DictationDraftWriter()
        let draft = writer.write(guess("uh"), into: "")
        #expect(writer.write(settled(""), into: draft) == "")
    }

    @Test func withNoCaretDictationContinuesWhatWasTyped() {
        var writer = DictationDraftWriter()
        let draft = writer.write(guess("and"), into: "half typed")
        #expect(writer.write(settled("and spoken"), into: draft) == "half typed and spoken")
    }

    @Test func aCaretAtTheStartInsertsThereAndLeavesTheRestAlone() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("hello"), into: "world", caret: 0)
        #expect(draft == "hello world")
        #expect(writer.unconfirmed == 0 ..< 5)

        draft = writer.write(guess("hello there"), into: draft, caret: 5)
        #expect(draft == "hello there world")
    }

    @Test func aCaretInTheMiddleInsertsBetweenTheWords() {
        var writer = DictationDraftWriter()
        let draft = writer.write(guess("the failing"), into: "fix test", caret: 4)
        #expect(draft == "fix the failing test")
        #expect(writer.unconfirmed == 4 ..< 15)
    }

    @Test func aPartialAfterTypingBeforeTheSegmentKeepsTheTypingAndMovesTheSegment() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("spoken"), into: "a")
        #expect(draft == "a spoken")

        draft = "X" + draft
        draft = writer.write(guess("spoken words"), into: draft)
        #expect(draft == "Xa spoken words")
        #expect(writer.unconfirmed == 3 ..< 15)
    }

    @Test func aBackspaceInCommittedTextStaysDeleted() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("and"), into: "fix teh bug")
        #expect(draft == "fix teh bug and")

        draft = "fix te bug and"
        draft = writer.write(guess("and push"), into: draft)
        #expect(draft == "fix te bug and push")
        draft = writer.write(settled("and push it"), into: draft)
        #expect(draft == "fix te bug and push it")
    }

    @Test func aBackspaceInsideTheSegmentIsKeptAndTheWordsDoNotComeBack() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("fix the bug"), into: "")
        draft = "fix the "
        draft = writer.write(guess("fix the bug now"), into: draft)
        #expect(draft == "fix the now")
    }

    @Test func typingInsideTheSegmentCommitsItAndDictationContinuesAfterIt() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("recording"), into: "")
        draft = "recXXording"

        draft = writer.write(guess("recording now"), into: draft)
        #expect(draft == "recXXording now")
        #expect(writer.unconfirmed == 12 ..< 15)

        draft = writer.write(settled("recording now please"), into: draft)
        #expect(draft == "recXXording now please")
        #expect(writer.unconfirmed == nil)
    }

    @Test func typingRightAfterTheSegmentPutsTheNextWordsAfterTheTyping() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("fix the"), into: "")
        draft += " bug,"
        draft = writer.write(guess("fix the tests"), into: draft)
        #expect(draft == "fix the bug, tests")
    }

    @Test func aFinalAfterEditsLandsWithoutTouchingThem() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("fix the"), into: "")
        draft = "Please " + draft
        draft = writer.write(settled("fix the tests"), into: draft)
        #expect(draft == "Please fix the tests")
        #expect(writer.unconfirmed == nil)

        draft = writer.write(guess("and"), into: draft)
        #expect(draft == "Please fix the tests and")
    }

    @Test func anEditAfterTheSegmentLeavesItLive() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("hello"), into: "world", caret: 0)
        draft = "hello World"
        draft = writer.write(guess("hello there"), into: draft)
        #expect(draft == "hello there World")
    }

    @MainActor @Test func nothingIsWrittenBeforeADictationBegins() {
        let box = DictationDraftBox()
        #expect(box.write(guess("stray"), into: "typed", caret: 5) == nil)
        #expect(box.unconfirmed == nil)
    }

    @MainActor @Test func afterStopTheWordsStayAndLateResultsTouchNothing() {
        let box = DictationDraftBox()
        box.begin()
        var draft = box.write(guess("said out loud"), into: "", caret: 0) ?? ""
        box.end()
        #expect(draft == "said out loud")
        #expect(box.unconfirmed == nil)

        draft = "said out lou"
        #expect(box.write(guess("said out loud more"), into: draft, caret: 12) == nil)
        #expect(box.write(settled("said out loud"), into: draft, caret: 12) == nil)
        #expect(draft == "said out lou")
    }

    @MainActor @Test func aCancelBeforeAnyWordsLeavesTheDraftAlone() {
        let box = DictationDraftBox()
        box.begin()
        box.end()
        #expect(box.write(guess("late"), into: "typed", caret: 5) == nil)
    }

    @MainActor @Test func aSecondDictationStartsFreshAtTheNewCaret() {
        let box = DictationDraftBox()
        box.begin()
        var draft = box.write(guess("first"), into: "", caret: 0) ?? ""
        box.end()

        draft = "typed " + draft
        box.begin()
        draft = box.write(guess("second"), into: draft, caret: 0) ?? draft
        #expect(draft == "second typed first")
        #expect(box.unconfirmed == 0 ..< 6)
        draft = box.write(settled("second one"), into: draft, caret: 0) ?? draft
        #expect(draft == "second one typed first")
    }

    @Test func anEmptyGuessWithNoSpanOpenWritesNothingAtAll() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess(""), into: "untouched")
        draft = writer.write(settled(""), into: draft)
        #expect(draft == "untouched")
    }

    @Test func theUnconfirmedRunIsCountedInUtf16LikeTheField() {
        var writer = DictationDraftWriter()
        let draft = writer.write(guess("there"), into: "hi 🙂")
        #expect(draft == "hi 🙂 there")
        #expect(writer.unconfirmed == 6 ..< 11)
    }
}
