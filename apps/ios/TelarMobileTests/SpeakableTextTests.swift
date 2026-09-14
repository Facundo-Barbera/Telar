import Foundation
import Testing
@testable import TelarMobile

/// THE PASS BETWEEN A REPLY AND A VOICE. Every case here is something
/// `MarkdownContent.renderPlainText()` reads out loud today and should not:
/// fence bodies, pipe rows, raw TeX, bare URLs.
/// (`docs/investigations/ios-talkback-2026-09-11.md`, §1.)
@Suite struct SpeakableTextTests {
    @Test func aFencedCodeBlockIsNeverRead() {
        let spoken = speakableText("""
        Here is the fix:

        ```swift
        func hello() {
            print("secret internals")
        }
        ```

        Run it.
        """)
        #expect(spoken == "Here is the fix:\ncode block omitted.\nRun it.")
    }

    @Test func aTildeFenceCountsTooAndTakesTheWholeBodyWithIt() {
        let spoken = speakableText("~~~\nnot prose\n~~~")
        #expect(spoken == "code block omitted.")
    }

    @Test func aLinkIsItsLabelAndTheUrlIsNotSpeech() {
        #expect(speakableText("See [the docs](https://example.com/a_b) for more.")
            == "See the docs for more.")
        // Reference style, and a bare autolink nobody would want spelled out.
        #expect(speakableText("See [the docs][1] and <https://example.com>.")
            == "See the docs and a link.")
    }

    @Test func anImageSpeaksItsAltText() {
        #expect(speakableText("![a red square](/img.png) sits here.") == "a red square sits here.")
        #expect(speakableText("![](/img.png)") == "an image.")
    }

    @Test func aListBecomesSentences() {
        let spoken = speakableText("""
        Steps:

        - install the thing
        - run it
        - read the output.
        """)
        #expect(spoken == "Steps:\ninstall the thing. run it. read the output.")
    }

    @Test func anOrderedListKeepsItsOrdinalsAndACheckboxIsRead() {
        #expect(speakableText("1. first\n2. second") == "1. first. 2. second.")
        #expect(speakableText("- [x] shipped\n- [ ] not yet")
            == "done, shipped. to do, not yet.")
    }

    @Test func inlineMathIsAnEquationAndDisplayMathIsItsOwnSentence() {
        #expect(speakableText("And $$E = mc^2$$ closes it.") == "And an equation closes it.")
        #expect(speakableText("Before\n\n$$\nR_t = \\frac{P_t}{P_{t-1}}\n$$\n\nAfter")
            == "Before.\nan equation.\nAfter.")
        // The web's rule, and the renderer's: single dollars are money.
        #expect(speakableText("It costs $5 to $10.") == "It costs $5 to $10.")
    }

    @Test func aCodeSpanIsReadAsWrittenAndEmphasisIsNot() {
        // An identifier is one word; its underscores are part of it, and the
        // emphasis around it is tone the voice cannot wear.
        #expect(speakableText("Call **`read_file`** on it, *twice*.")
            == "Call read_file on it, twice.")
        #expect(speakableText("A _stressed_ word and a snake_case one.")
            == "A stressed word and a snake_case one.")
    }

    @Test func aTableIsAnnouncedRatherThanRecited() {
        let spoken = speakableText("""
        Results:

        | Name | Count |
        | --- | --- |
        | alpha | 1 |
        | beta | 2 |
        """)
        #expect(spoken == "Results:\na table, 3 rows.")
    }

    @Test func headingsQuotesAndRulesReadAsProse() {
        let spoken = speakableText("""
        ## A heading ##

        > a quote
        > continued

        ---

        The end
        """)
        #expect(spoken == "A heading.\na quote continued.\nThe end.")
    }

    @Test func anUnclosedMarkerIsPlainText() {
        #expect(speakableText("A stray ` tick and a lone $$ sign.") == "A stray ` tick and a lone $$ sign.")
        #expect(speakableText("An open [bracket here.") == "An open [bracket here.")
    }

    @Test func nothingToSayComesBackEmpty() {
        #expect(speakableText("") == "")
        #expect(speakableText("\n\n---\n\n") == "")
    }
}

/// WHICH reply gets read: the newest SETTLED turn's closing prose, chosen by
/// the same `newestResultTurn` the read receipt confirms against.
@Suite struct LastReplySourceTests {
    private func turn(
        _ sequence: Int, _ state: TurnState = .completed,
        prose: String = "", result: String = ""
    ) -> SpeakableTurn {
        SpeakableTurn(
            runId: "run_\(sequence)", state: state, sequence: sequence,
            closingProse: prose, resultText: result
        )
    }

    @Test func theNewestAnswerBySequenceWins() {
        let turns = [turn(7, prose: "newest"), turn(3, prose: "older")]
        #expect(lastReplySource(turns) == "newest")
    }

    @Test func aRunningTurnIsNotAnAnswerYet() {
        // Speak the SETTLED reply only: a half-arrived one can still be
        // replaced, and audio cannot be un-said.
        #expect(lastReplySource([turn(2, .running, prose: "still going")]) == nil)
        #expect(lastReplySource([turn(2, .completed, prose: "done"), turn(3, .running, prose: "next")])
            == "done")
    }

    @Test func aStoppedOrFailedTurnStillLeftSomethingToRead() {
        #expect(lastReplySource([turn(4, .stopped, prose: "got this far")]) == "got this far")
        #expect(lastReplySource([turn(4, .failed, result: "Turn failed")]) == "Turn failed")
    }

    @Test func resultTextIsTheFallbackWhenTheTurnCarriesNoProse() {
        #expect(lastReplySource([turn(1, prose: "", result: "the engine's own text")])
            == "the engine's own text")
    }

    @Test func aSessionWithNothingSaidHasNothingToSpeak() {
        #expect(lastReplySource([]) == nil)
        #expect(lastReplySource([turn(1, prose: "   \n ")]) == nil)
    }
}
