import Foundation
import Testing
@testable import TelarMobile

@Suite struct DictationStripTests {
    private func guess(_ text: String) -> DictationWords { DictationWords(text: text, final: false) }
    private func settled(_ text: String) -> DictationWords { DictationWords(text: text, final: true) }

    @Test func guessesOnlyShowAndNeverAskToCommit() {
        var strip = DictationStrip()
        for word in ["recur", "record", "recording"] { strip.hear(guess(word)) }
        #expect(strip.shown == "recording")
        #expect(strip.take() == nil)
    }

    @Test func aPauseCommitsTheSegmentOnce() {
        var strip = DictationStrip()
        strip.hear(guess("fix the"))
        strip.hear(settled("fix the failing test"))
        #expect(strip.take() == "fix the failing test")
        #expect(strip.take() == nil)
        #expect(strip.shown == "")
    }

    @Test func aSilentPauseCommitsNothing() {
        var strip = DictationStrip()
        strip.hear(guess("uh"))
        strip.hear(settled(""))
        #expect(strip.take() == nil)
    }

    @Test func stopCommitsWhatWasStillBeingHeard() {
        var strip = DictationStrip()
        strip.hear(guess("half a sentence"))
        strip.flush()
        #expect(strip.take() == "half a sentence")
    }

    @Test func stopWithNothingHeardCommitsNothing() {
        var strip = DictationStrip()
        strip.flush()
        #expect(strip.take() == nil)
    }

    @Test func aTapMidUtteranceCommitsAndTheRestOfThatUtteranceIsNotRepeated() {
        var strip = DictationStrip()
        strip.hear(guess("fix the"))
        strip.flush()
        #expect(strip.take() == "fix the")

        strip.hear(guess("fix the failing"))
        #expect(strip.shown == "failing")
        strip.hear(settled("fix the failing test"))
        #expect(strip.take() == "failing test")

        strip.hear(guess("and push"))
        #expect(strip.shown == "and push")
    }

    @Test func aCommitTheFieldRefusedIsHeldAheadOfLaterWords() {
        var strip = DictationStrip()
        strip.hear(settled("first"))
        let refused = strip.take() ?? ""
        strip.hold(refused)
        strip.hear(settled("second"))
        #expect(strip.take() == "first second")
    }

    @Test func aFreshStripForTheNextDictationRemembersNothing() {
        var strip = DictationStrip()
        strip.hear(guess("one two"))
        strip.flush()
        _ = strip.take()
        strip = DictationStrip()
        strip.hear(guess("one two three"))
        #expect(strip.shown == "one two three")
    }

    @Test func withNoFieldTheWordsAreAppendedToTheDraft() {
        #expect(DictationStrip.appending("spoken", to: "") == "spoken")
        #expect(DictationStrip.appending("spoken", to: "typed") == "typed spoken")
        #expect(DictationStrip.appending("spoken", to: "typed ") == "typed spoken")
        #expect(DictationStrip.appending("spoken", to: "line\n") == "line\nspoken")
    }
}
