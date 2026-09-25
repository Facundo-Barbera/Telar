import Foundation
import Testing
@testable import TelarMobile

/// PRIMING THE RECOGNISER WITH THE APP'S OWN VOCABULARY (#581).
///
/// The headset has always put up to forty `keyterm=` parameters on its socket,
/// built from session titles and project names. This phone put NONE — model,
/// language, formatting, endpointing, encoding and nothing else — which is the
/// whole of why the VR client "understands the glossary much better". There is
/// no glossary matching anywhere in Telar; "the glossary" IS this parameter.
///
/// What this pins is the phone's half: the list arrives built and bounded from
/// the Mac (`apps/engine/src/dictation/keyterms.ts`), and this end appends it
/// without deciding anything about it. The decoder's half is here too, because
/// a Mac on an older build answers without the field and a phone that failed to
/// decode that token would refuse to dictate at all.
@Suite struct DictationKeytermsTests {
    private func query(language: String = "multi", keyterms: [String] = []) -> [URLQueryItem] {
        let url = DeepgramListen.url(language: language, keyterms: keyterms)
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    }

    private func values(_ name: String, in items: [URLQueryItem]) -> [String] {
        items.filter { $0.name == name }.compactMap(\.value)
    }

    @Test func oneRepeatedParameterPerTerm() {
        // MULTI-VALUED, which is why the builder appends rather than joins: a
        // comma-separated string would be one long term nobody ever says.
        let items = query(keyterms: ["Telar", "Zarigüeya", "worktree"])
        #expect(values("keyterm", in: items) == ["Telar", "Zarigüeya", "worktree"])
    }

    @Test func theyRideAlongsideMulti() {
        // Keyterm prompting is documented per model, and `multi` is what Telar
        // sends by default — confirmed working on the headset.
        let items = query(language: "multi", keyterms: ["Telar"])
        #expect(values("language", in: items) == ["multi"])
        #expect(values("keyterm", in: items) == ["Telar"])
    }

    @Test func phrasesAndAccentsSurviveTheQuery() {
        // Session titles are phrases and projects are named in whatever
        // language somebody named them in. A builder that mangled either would
        // prime the model with strings it will never hear.
        let items = query(keyterms: ["Nightly build triage", "Zarigüeya"])
        #expect(values("keyterm", in: items) == ["Nightly build triage", "Zarigüeya"])
    }

    @Test func noTermsMeansNoParameter() {
        #expect(values("keyterm", in: query()).isEmpty)
    }

    @Test func theRestOfTheQueryIsUnchanged() {
        // THE RAW-PCM DECLARATIONS STAY. This end sends 16 kHz linear16 with no
        // container header for the service to read, unlike the web's.
        let items = query(keyterms: ["Telar"])
        #expect(values("model", in: items) == ["nova-3"])
        #expect(values("numerals", in: items) == ["true"])
        #expect(values("encoding", in: items) == ["linear16"])
        #expect(values("sample_rate", in: items) == ["16000"])
        // 300 AND NOT 100: the headset saw monosyllables doubled at the lower
        // value, and "yes yes" in the box is worse than a final landing a fifth
        // of a second late.
        #expect(values("endpointing", in: items) == ["300"])
    }

    @Test func aTokenWithKeytermsCarriesThemThrough() throws {
        let json = #"{"provider":"deepgram","token":"jwt","expiresAt":1,"language":"es","keyterms":["Telar","Zarigüeya"]}"#
        let answer = try JSONDecoder().decode(DictationTokenAnswer.self, from: Data(json.utf8))
        #expect(answer.listenKeyterms == ["Telar", "Zarigüeya"])
    }

    @Test func aMacFromBeforeThisExistedStillMintsAUsableToken() throws {
        // ABSENT MEANS NONE, not a decode failure: dictating with no glossary
        // is exactly what every dictation did until this shipped, and refusing
        // to open the socket would be strictly worse than that.
        let json = #"{"provider":"deepgram","token":"jwt","expiresAt":1,"language":"es"}"#
        let answer = try JSONDecoder().decode(DictationTokenAnswer.self, from: Data(json.utf8))
        #expect(answer.listenKeyterms.isEmpty)
        #expect(values("keyterm", in: query(language: answer.listenLanguage, keyterms: answer.listenKeyterms)).isEmpty)
    }
}
