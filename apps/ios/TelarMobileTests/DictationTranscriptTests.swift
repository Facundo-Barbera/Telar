import Foundation
import Testing
@testable import TelarMobile

/// WHAT ONE FRAME SAYS, AND WHERE THE WORDS LAND (#544).
///
/// A live transcription REVISES itself: the service streams interim guesses —
/// "recur", "record", "recording" — and marks only some of them final. Those
/// guesses go INTO the composer and are rewritten in place until the service
/// settles them, which is the desktop's behaviour
/// (`apps/web/lib/dictation/interim.ts`) held here deliberately: a person
/// dictating the same sentence into the phone and into the Mac must not watch
/// their words behave differently.
///
/// The half that is worth testing is the SPAN — the run of the draft the
/// unconfirmed words occupy — because the person is typing into the same box
/// and an offset range does not survive that.
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

    private func guess(_ text: String) -> DictationWords { DictationWords(text: text, final: false) }
    private func settled(_ text: String) -> DictationWords { DictationWords(text: text, final: true) }

    // MARK: what one frame says

    @Test func anInterimGuessIsWordsThatAreNotSettledYet() {
        #expect(DictationTranscript.read(results("recur", final: false)) == guess("recur"))
    }

    @Test func eachGuessIsTheWholeUtteranceSoFarWhichIsWhatMakesItAReplacement() {
        let walk = ["recur", "record", "recording"].compactMap { DictationTranscript.read(results($0, final: false)) }
        #expect(walk.allSatisfy { !$0.final })
        #expect(walk.last?.text == "recording")
    }

    @Test func aFinalIsTheSameWordsSettled() {
        #expect(DictationTranscript.read(results("fix the failing test", final: true)) == settled("fix the failing test"))
    }

    @Test func aFinalisedSilenceIsStillAFinalAndEmpty() {
        // NOT `nil`: the writer has an unconfirmed guess in the box and this is
        // the frame that tells it to take the guess back out. Reported as
        // "nothing happened" it would sit there until the person deleted it.
        #expect(DictationTranscript.read(results("   ", final: true)) == settled(""))
        #expect(DictationTranscript.read(results("", final: true)) == settled(""))
    }

    @Test func theFramesThatAreNotResultsSayNothingAboutTheWords() {
        // The service sends all three on an ordinary dictation.
        for type in ["Metadata", "SpeechStarted", "UtteranceEnd"] {
            guard let frame = DictationFrame.read(#"{"type":"\#(type)"}"#) else { continue }
            #expect(DictationTranscript.read(frame) == nil)
        }
    }

    @Test func nothingOffTheSocketCanThrowBecauseSomebodyIsMidSentence() {
        // A truncated frame, a shape from a future version of the API. Neither
        // is worth ending a recording over.
        #expect(DictationFrame.read("{not json") == nil)
        #expect(DictationFrame.read("") == nil)
        // A results frame with no alternatives says nothing, rather than
        // crashing or claiming the utterance went empty.
        guard let bare = DictationFrame.read(#"{"type":"Results","is_final":true,"channel":{}}"#) else {
            Issue.record("the fixture did not decode")
            return
        }
        #expect(DictationTranscript.read(bare) == nil)
    }

    // MARK: how a phrase lands in a draft

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
        #expect(DictationTranscript.merge(draft: "fix", commit: "") == "fix")
        #expect(DictationTranscript.merge(draft: "fix", commit: "   ") == "fix")
        #expect(DictationTranscript.merge(draft: "", commit: "  ") == "")
    }

    // MARK: the span, and every way a person can invalidate it

    @Test func eachGuessReplacesTheLastInTheBox() {
        var writer = DictationDraftWriter()
        var draft = ""
        for word in ["recur", "record", "recording"] {
            draft = writer.write(guess(word), into: draft)
        }
        // Three guesses, one word in the box — which is the whole feature.
        #expect(draft == "recording")
    }

    @Test func aFinalSettlesTheWordsAndTheNextUtteranceStartsAfterThem() {
        var writer = DictationDraftWriter()
        var draft = ""
        draft = writer.write(guess("fix the"), into: draft)
        draft = writer.write(settled("fix the failing test"), into: draft)
        #expect(draft == "fix the failing test")

        // The span was forgotten at the final, so this opens a new one rather
        // than replacing the sentence that is already there.
        draft = writer.write(guess("and"), into: draft)
        draft = writer.write(settled("and push it"), into: draft)
        #expect(draft == "fix the failing test and push it")
    }

    @Test func aFinalisedSilenceTakesTheUnconfirmedGuessBackOut() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("uh"), into: "")
        #expect(draft == "uh")
        draft = writer.write(settled(""), into: draft)
        #expect(draft == "")
    }

    @Test func dictationStartsAtWhateverTheBoxAlreadyHolds() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("and"), into: "half typed")
        draft = writer.write(settled("and spoken"), into: draft)
        #expect(draft == "half typed and spoken")
    }

    @Test func somebodyTypingInsideTheSpanKeepsTheirKeystrokes() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("recording"), into: "")
        #expect(draft == "recording")

        // A keystroke in the middle of the unconfirmed word. The offsets now
        // mean something else, and writing through them would eat what they
        // typed.
        draft = "recXXording"
        draft = writer.write(guess("recording now"), into: draft)
        #expect(draft.contains("recXX"))
        #expect(draft.contains("recording now"))
    }

    @Test func somebodyTypingBeforeTheSpanDropsItRatherThanWritingAtAShiftedOffset() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("spoken"), into: "")
        draft = "typed " + draft
        draft = writer.write(settled("spoken words"), into: draft)
        // Every character of "typed " survives. A span applied at its old
        // offsets would have replaced "typed " itself.
        #expect(draft.hasPrefix("typed "))
        #expect(draft.contains("spoken words"))
    }

    @Test func theWordsKeepFlowingAfterAnInterruption() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("one"), into: "")
        draft = "!" + draft
        draft = writer.write(guess("two"), into: draft)
        let afterTwo = draft
        draft = writer.write(guess("three"), into: draft)
        // The new span is live again from the next frame on, so a revision
        // after the interruption still replaces in place rather than appending
        // forever.
        #expect(draft == afterTwo.replacingOccurrences(of: "two", with: "three"))
    }

    @Test func forgettingLeavesTheWordsAndOnlyDropsTheSpan() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("said out loud"), into: "")
        // The press ended mid-guess. What was heard is the person's draft now,
        // and the next press appends rather than overwriting it.
        writer.forget()
        #expect(draft == "said out loud")
        draft = writer.write(guess("more"), into: draft)
        #expect(draft == "said out loud more")
    }

    @Test func anEmptyGuessWithNoSpanOpenWritesNothingAtAll() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess(""), into: "untouched")
        draft = writer.write(settled(""), into: draft)
        #expect(draft == "untouched")
    }

    // MARK: the socket's address

    private func query(_ url: URL) -> (String) -> String? {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return { name in items.first { $0.name == name }?.value }
    }

    @Test func theSocketDeclaresWhatTheseBuffersActuallyAre() {
        let value = query(DeepgramListen.url(language: DictationLanguages.automatic, keyterms: []))
        // Unlike the web's, this end sends raw PCM with no container header for
        // the service to read — so the format has to be declared, and it has to
        // match what `Dictation` converts to.
        #expect(value("encoding") == "linear16")
        #expect(value("sample_rate") == "16000")
        #expect(value("channels") == "1")
        #expect(value("model") == "nova-3")
        #expect(value("interim_results") == "true")
        // The token goes in a header here. Nothing credential-shaped belongs in
        // this URL — and on the web it is refused outright, which is why that
        // end sends it as the `bearer` subprotocol.
        #expect(value("access_token") == nil)
        #expect(DeepgramListen.url(language: DictationLanguages.automatic, keyterms: []).scheme == "wss")
    }

    // MARK: which language (#560)

    /// THE BUG, AS A TEST. A socket opened with no `language` transcribes as
    /// English whatever it hears, so the parameter has to be on the URL — and
    /// it has to be the one that was passed, not a default this file invented.
    @Test func theSocketAsksForTheLanguageItWasGiven() {
        #expect(query(DeepgramListen.url(language: "es", keyterms: []))("language") == "es")
        #expect(query(DeepgramListen.url(language: "pt-BR", keyterms: []))("language") == "pt-BR")
    }

    @Test func automaticIsMultiAndRidesTheSocketLikeAnyOtherCode() {
        // `multi` is a value Nova-3 accepts on the wire rather than a local
        // word for "send nothing" — sending nothing is the bug.
        #expect(DictationLanguages.automatic == "multi")
        #expect(query(DeepgramListen.url(language: DictationLanguages.automatic, keyterms: []))("language") == "multi")
    }

    /// A MAC ON A BUILD FROM BEFORE #560 answers a token with no `language` in
    /// it. That must decode, and it must come out as code-switching rather than
    /// as English — which is the failure this whole change is about.
    @Test func aTokenWithNoLanguageInItFallsBackToAutomatic() throws {
        let older = Data(#"{"provider":"deepgram","token":"jwt","expiresAt":1000}"#.utf8)
        let answer = try JSONDecoder().decode(DictationTokenAnswer.self, from: older)
        #expect(answer.language == nil)
        #expect(answer.listenLanguage == "multi")

        let newer = Data(#"{"provider":"deepgram","token":"jwt","expiresAt":1000,"language":"fr"}"#.utf8)
        #expect(try JSONDecoder().decode(DictationTokenAnswer.self, from: newer).listenLanguage == "fr")
    }

    // MARK: the badge at the caret (#561)

    /// THE BADGE IS THE SIZE OF THE CARET, so it says the code and not the
    /// name — which is what iOS's own dictation badge does.
    @Test func theBadgeSaysTheLanguageCodeUpperCased() {
        #expect(DictationLanguages.badge("es") == "ES")
        // A regional variant keeps its region: PT and PT-BR are different rows
        // in the picker, and a badge that flattened them would say the wrong
        // one.
        #expect(DictationLanguages.badge("pt-BR") == "PT-BR")
        #expect(DictationLanguages.badge("es-419") == "ES-419")
    }

    /// `multi` READS AS AUTO — the picker calls it "Automatic", and "MULTI"
    /// would be a third name for one setting and the one a reader has never
    /// seen on a screen.
    @Test func automaticReadsAsAutoRatherThanAsTheVendorsWord() {
        #expect(DictationLanguages.badge(DictationLanguages.automatic) == "AUTO")
        #expect(DictationLanguages.badge(DictationLanguages.automatic) != "MULTI")
        // A Mac on a build from before #560 sends no language at all. The badge
        // says what will actually be transcribed rather than going blank.
        #expect(DictationLanguages.badge(nil) == "AUTO")
        #expect(DictationLanguages.badge("  ") == "AUTO")
    }

    /// ABOVE THE CARET AND A HAIR TO ITS LEFT — beside it is where the next
    /// word is about to be written, so a badge there covers the thing it is
    /// reporting on.
    @Test func theBadgeSitsAboveTheCaretAndIsClampedIntoTheField() {
        let caret = CGRect(x: 120, y: 90, width: 2, height: 20)
        let origin = DictationCaretPill.origin(for: caret)
        #expect(origin.y < caret.minY)
        #expect(origin.x < caret.minX)

        // A caret on the FIRST line has no room above it, and a badge placed at
        // a negative offset would be drawn outside the field entirely.
        let top = DictationCaretPill.origin(for: CGRect(x: 0, y: 0, width: 2, height: 20))
        #expect(top.x >= 0)
        #expect(top.y >= 0)
    }

    /// The writer's own span, which is what the field draws dimmer. Read from
    /// the writer rather than tracked beside it: two answers to one question is
    /// how a dim ends up over the wrong words.
    @Test func theUnconfirmedRunIsWhatTheWriterSaysItIs() {
        var writer = DictationDraftWriter()
        #expect(writer.unconfirmed == nil)

        let draft = writer.write(guess("fix the"), into: "")
        #expect(draft == "fix the")
        #expect(writer.unconfirmed == 0 ..< 7)

        let revised = writer.write(guess("fix the failing"), into: draft)
        #expect(writer.unconfirmed == 0 ..< 15)

        // A FINAL LEAVES NOTHING TO DIM: the words are the person's now.
        _ = writer.write(settled("fix the failing test"), into: revised)
        #expect(writer.unconfirmed == nil)
    }

    /// Somebody typing mid-guess drops the span, and the dim has to go with it
    /// — a greyed-out run over text the writer no longer owns would be marking
    /// the person's own words as unconfirmed.
    @Test func somebodyElseTypingClearsTheRunThatWouldBeDimmed() {
        var writer = DictationDraftWriter()
        let draft = writer.write(guess("recording"), into: "")
        #expect(writer.unconfirmed != nil)

        _ = writer.write(guess("recorded"), into: draft + " typed over it")
        // The span reopened at the end of what the person left, and it covers
        // the new guess only.
        #expect(writer.unconfirmed != 0 ..< 9)
    }

    /// The settings answer's two new fields, and the same tolerance: an older
    /// Mac sends neither, and the screen reads that as Automatic with nothing
    /// to pick from rather than failing to decode.
    @Test func theSettingsAnswerCarriesTheLanguageAndTheNamesToPickItBy() throws {
        let body = Data(
            #"{"dictation":{"provider":"deepgram","configured":true,"language":"ja","languages":[{"code":"multi","label":"Automatic (any supported language)"},{"code":"ja","label":"Japanese"}]}}"#
                .utf8
        )
        let answer = try JSONDecoder().decode(DictationAnswer.self, from: body)
        #expect(answer.dictation.language == "ja")
        #expect(answer.dictation.languages?.first?.code == "multi")
        #expect(answer.dictation.languages?.last?.label == "Japanese")

        let older = Data(#"{"dictation":{"provider":"deepgram","configured":true}}"#.utf8)
        let before = try JSONDecoder().decode(DictationAnswer.self, from: older)
        #expect(before.dictation.language == nil)
        #expect(before.dictation.languages == nil)
    }
}
