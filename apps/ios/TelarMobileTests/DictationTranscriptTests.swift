import Foundation
import Testing
@testable import TelarMobile

/// WHAT GOES IN THE COMPOSER AND WHAT ONLY GETS SHOWN (#544).
///
/// A live transcription REVISES itself: the service streams interim guesses —
/// "recur", "record", "recording" — and marks only some of them final. Writing
/// every guess into the box puts all three in somebody's message.
///
/// The rule is the web's, deliberately (`apps/web/lib/dictation/transcript.ts`):
/// interim text is shown, only a final is merged. There it is forced by
/// `window.telar.dictate`, which inserts and cannot retract; here the draft is a
/// `String` this app owns and could be rewritten freely, so it is a CHOICE — and
/// these are what hold it, because a person dictating the same sentence into the
/// phone and into the desktop must not watch their words behave differently.
@Suite struct DictationTranscriptTests {
    private func results(_ transcript: String, final: Bool) -> DictationFrame {
        let json = """
        {"type":"Results","is_final":\(final),"channel":{"alternatives":[{"transcript":"\(transcript)"}]}}
        """
        guard let frame = DictationFrame.read(json) else {
            Issue.record("the fixture did not decode")
            return DictationFrame()
        }
        return frame
    }

    // MARK: which words are committed

    @Test func anInterimGuessIsShownAndNeverCommitted() {
        #expect(DictationTranscript.step(results("recur", final: false)) == DictationStep(commit: "", interim: "recur"))
    }

    @Test func revisedGuessesReplaceEachOtherBecauseNoneWasEverCommitted() {
        let walk = ["recur", "record", "recording"].map { DictationTranscript.step(results($0, final: false)) }
        #expect(walk.allSatisfy { $0.commit.isEmpty })
        #expect(walk.last?.interim == "recording")
    }

    @Test func aFinalCommitsAndClearsThePreview() {
        #expect(DictationTranscript.step(results("fix the failing test", final: true))
            == DictationStep(commit: "fix the failing test", interim: ""))
    }

    @Test func aFinalCommitsOnlyWhatThatFrameFinalised() {
        // Not everything said so far: an accumulating reducer is how a
        // dictation ends up saying the whole utterance twice.
        #expect(DictationTranscript.step(results("fix the failing test", final: true)).commit == "fix the failing test")
        #expect(DictationTranscript.step(results("and push it", final: true)).commit == "and push it")
    }

    @Test func aFinalisedSilenceCommitsNothingRatherThanASpace() {
        #expect(DictationTranscript.step(results("   ", final: true)) == .nothing)
        #expect(DictationTranscript.step(results("", final: true)) == .nothing)
    }

    @Test func theFramesThatAreNotResultsAreNothingToThis() {
        // The service sends all three on an ordinary dictation.
        for type in ["Metadata", "SpeechStarted", "UtteranceEnd"] {
            guard let frame = DictationFrame.read(#"{"type":"\#(type)"}"#) else { continue }
            #expect(DictationTranscript.step(frame) == .nothing)
        }
    }

    @Test func nothingOffTheSocketCanThrowBecauseSomebodyIsMidSentence() {
        // A truncated frame, a shape from a future version of the API. Neither
        // is worth ending a recording over.
        #expect(DictationFrame.read("{not json") == nil)
        #expect(DictationFrame.read("") == nil)
        // A results frame with no alternatives is empty, not a crash.
        guard let bare = DictationFrame.read(#"{"type":"Results","is_final":true,"channel":{}}"#) else {
            Issue.record("the fixture did not decode")
            return
        }
        #expect(DictationTranscript.step(bare) == .nothing)
    }

    // MARK: how they land in the draft

    @Test func aPhraseLandsAloneInAnEmptyBox() {
        #expect(DictationTranscript.merge(draft: "", commit: "fix the failing test") == "fix the failing test")
    }

    @Test func dictationContinuesWhateverWasAlreadyTyped() {
        // The reason this is a merge and not an assignment: somebody reaches
        // for the mic halfway through typing, and what they typed must survive.
        #expect(DictationTranscript.merge(draft: "fix", commit: "the failing test") == "fix the failing test")
    }

    @Test func aDraftThatAlreadyEndsInSpaceDoesNotGainASecond() {
        #expect(DictationTranscript.merge(draft: "fix ", commit: "it") == "fix it")
    }

    @Test func aDeliberateLineBreakIsLeftAlone() {
        // Somebody who pressed return meant the break; closing it up would be
        // the app editing their message.
        #expect(DictationTranscript.merge(draft: "first line\n", commit: "second") == "first line\nsecond")
    }

    @Test func anEmptyPhraseChangesNothing() {
        // What makes `merge` safe to call on every frame without the caller
        // checking first.
        #expect(DictationTranscript.merge(draft: "fix", commit: "") == "fix")
        #expect(DictationTranscript.merge(draft: "fix", commit: "   ") == "fix")
        #expect(DictationTranscript.merge(draft: "", commit: "  ") == "")
    }

    @Test func twoUtterancesReadAsOneSentence() {
        // The whole loop, as a person experiences it: two finals, appended in
        // order, spaced once.
        var draft = ""
        for phrase in ["fix the failing test", "and push it"] {
            draft = DictationTranscript.merge(draft: draft, commit: DictationTranscript.step(results(phrase, final: true)).commit)
        }
        #expect(draft == "fix the failing test and push it")
    }

    // MARK: the socket's address

    @Test func theSocketDeclaresWhatTheseBuffersActuallyAre() {
        let query = URLComponents(url: DeepgramListen.url(), resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in query.first { $0.name == name }?.value }
        // Unlike the web's, this end sends raw PCM with no container header for
        // the service to read — so the format has to be declared, and it has to
        // match what `Dictation` converts to.
        #expect(value("encoding") == "linear16")
        #expect(value("sample_rate") == "16000")
        #expect(value("channels") == "1")
        #expect(value("model") == "nova-3")
        #expect(value("interim_results") == "true")
        // The token goes in a header here — the browser is the one that cannot
        // send one. Nothing credential-shaped belongs in this URL.
        #expect(value("access_token") == nil)
        #expect(DeepgramListen.url().scheme == "wss")
    }
}
