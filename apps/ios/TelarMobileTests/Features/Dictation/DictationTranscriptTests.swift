import Foundation
import Testing
@testable import TelarMobile

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
        #expect(DictationTranscript.read(results("   ", final: true)) == settled(""))
        #expect(DictationTranscript.read(results("", final: true)) == settled(""))
    }

    @Test func theFramesThatAreNotResultsSayNothingAboutTheWords() {
        for type in ["Metadata", "SpeechStarted", "UtteranceEnd"] {
            guard let frame = DictationFrame.read(#"{"type":"\#(type)"}"#) else { continue }
            #expect(DictationTranscript.read(frame) == nil)
        }
    }

    @Test func nothingOffTheSocketCanThrowBecauseSomebodyIsMidSentence() {
        #expect(DictationFrame.read("{not json") == nil)
        #expect(DictationFrame.read("") == nil)

        guard let bare = DictationFrame.read(#"{"type":"Results","is_final":true,"channel":{}}"#) else {
            Issue.record("the fixture did not decode")
            return
        }
        #expect(DictationTranscript.read(bare) == nil)
    }

    @Test func aPhraseLandsAloneInAnEmptyBox() {
        #expect(DictationTranscript.merge(draft: "", commit: "fix the failing test") == "fix the failing test")
    }

    @Test func dictationContinuesWhateverWasAlreadyTyped() {
        #expect(DictationTranscript.merge(draft: "fix", commit: "the failing test") == "fix the failing test")
    }

    @Test func aDraftThatAlreadyEndsInSpaceDoesNotGainASecond() {
        #expect(DictationTranscript.merge(draft: "fix ", commit: "it") == "fix it")
    }

    @Test func aDeliberateLineBreakIsLeftAlone() {
        #expect(DictationTranscript.merge(draft: "first line\n", commit: "second") == "first line\nsecond")
    }

    @Test func anEmptyPhraseChangesNothing() {
        #expect(DictationTranscript.merge(draft: "fix", commit: "") == "fix")
        #expect(DictationTranscript.merge(draft: "fix", commit: "   ") == "fix")
        #expect(DictationTranscript.merge(draft: "", commit: "  ") == "")
    }

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
        var draft = ""
        draft = writer.write(guess("fix the"), into: draft)
        draft = writer.write(settled("fix the failing test"), into: draft)
        #expect(draft == "fix the failing test")

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

        #expect(draft == afterTwo.replacingOccurrences(of: "two", with: "three"))
    }

    @Test func forgettingLeavesTheWordsAndOnlyDropsTheSpan() {
        var writer = DictationDraftWriter()
        var draft = writer.write(guess("said out loud"), into: "")

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

    private func query(_ url: URL) -> (String) -> String? {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return { name in items.first { $0.name == name }?.value }
    }

    @Test func theSocketDeclaresWhatTheseBuffersActuallyAre() {
        let value = query(DeepgramListen.url(language: DictationLanguages.automatic, keyterms: []))

        #expect(value("encoding") == "linear16")
        #expect(value("sample_rate") == "16000")
        #expect(value("channels") == "1")
        #expect(value("model") == "nova-3")
        #expect(value("interim_results") == "true")

        #expect(value("access_token") == nil)
        #expect(DeepgramListen.url(language: DictationLanguages.automatic, keyterms: []).scheme == "wss")
    }

    @Test func theSocketAsksForTheLanguageItWasGiven() {
        #expect(query(DeepgramListen.url(language: "es", keyterms: []))("language") == "es")
        #expect(query(DeepgramListen.url(language: "pt-BR", keyterms: []))("language") == "pt-BR")
    }

    @Test func automaticIsMultiAndRidesTheSocketLikeAnyOtherCode() {
        #expect(DictationLanguages.automatic == "multi")
        #expect(query(DeepgramListen.url(language: DictationLanguages.automatic, keyterms: []))("language") == "multi")
    }

    @Test func aTokenWithNoLanguageInItFallsBackToAutomatic() throws {
        let older = Data(#"{"provider":"deepgram","token":"jwt","expiresAt":1000}"#.utf8)
        let answer = try JSONDecoder().decode(DictationTokenAnswer.self, from: older)
        #expect(answer.language == nil)
        #expect(answer.listenLanguage == "multi")

        let newer = Data(#"{"provider":"deepgram","token":"jwt","expiresAt":1000,"language":"fr"}"#.utf8)
        #expect(try JSONDecoder().decode(DictationTokenAnswer.self, from: newer).listenLanguage == "fr")
    }

    @Test func theBadgeSaysTheLanguageCodeUpperCased() {
        #expect(DictationLanguages.badge("es") == "ES")

        #expect(DictationLanguages.badge("pt-BR") == "PT-BR")
        #expect(DictationLanguages.badge("es-419") == "ES-419")
    }

    @Test func automaticReadsAsAutoRatherThanAsTheVendorsWord() {
        #expect(DictationLanguages.badge(DictationLanguages.automatic) == "AUTO")
        #expect(DictationLanguages.badge(DictationLanguages.automatic) != "MULTI")

        #expect(DictationLanguages.badge(nil) == "AUTO")
        #expect(DictationLanguages.badge("  ") == "AUTO")
    }

    @Test func theBadgeSitsAboveTheCaretAndIsClampedIntoTheField() {
        let caret = CGRect(x: 120, y: 90, width: 2, height: 20)
        let origin = DictationCaretPill.origin(for: caret)
        #expect(origin.y < caret.minY)
        #expect(origin.x < caret.minX)

        let top = DictationCaretPill.origin(for: CGRect(x: 0, y: 0, width: 2, height: 20))
        #expect(top.x >= 0)
        #expect(top.y >= 0)
    }

    @Test func theUnconfirmedRunIsWhatTheWriterSaysItIs() {
        var writer = DictationDraftWriter()
        #expect(writer.unconfirmed == nil)

        let draft = writer.write(guess("fix the"), into: "")
        #expect(draft == "fix the")
        #expect(writer.unconfirmed == 0 ..< 7)

        let revised = writer.write(guess("fix the failing"), into: draft)
        #expect(writer.unconfirmed == 0 ..< 15)

        _ = writer.write(settled("fix the failing test"), into: revised)
        #expect(writer.unconfirmed == nil)
    }

    @Test func somebodyElseTypingClearsTheRunThatWouldBeDimmed() {
        var writer = DictationDraftWriter()
        let draft = writer.write(guess("recording"), into: "")
        #expect(writer.unconfirmed != nil)

        _ = writer.write(guess("recorded"), into: draft + " typed over it")

        #expect(writer.unconfirmed != 0 ..< 9)
    }

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
