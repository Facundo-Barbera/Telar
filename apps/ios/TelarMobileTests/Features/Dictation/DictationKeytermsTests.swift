import Foundation
import Testing
@testable import TelarMobile

@Suite struct DictationKeytermsTests {
    private func query(language: String = "multi", keyterms: [String] = []) -> [URLQueryItem] {
        let url = DeepgramListen.url(language: language, keyterms: keyterms)
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    }

    private func values(_ name: String, in items: [URLQueryItem]) -> [String] {
        items.filter { $0.name == name }.compactMap(\.value)
    }

    @Test func oneRepeatedParameterPerTerm() {
        let items = query(keyterms: ["Telar", "Zarigüeya", "worktree"])
        #expect(values("keyterm", in: items) == ["Telar", "Zarigüeya", "worktree"])
    }

    @Test func theyRideAlongsideMulti() {
        let items = query(language: "multi", keyterms: ["Telar"])
        #expect(values("language", in: items) == ["multi"])
        #expect(values("keyterm", in: items) == ["Telar"])
    }

    @Test func phrasesAndAccentsSurviveTheQuery() {
        let items = query(keyterms: ["Nightly build triage", "Zarigüeya"])
        #expect(values("keyterm", in: items) == ["Nightly build triage", "Zarigüeya"])
    }

    @Test func noTermsMeansNoParameter() {
        #expect(values("keyterm", in: query()).isEmpty)
    }

    @Test func theRestOfTheQueryIsUnchanged() {
        let items = query(keyterms: ["Telar"])
        #expect(values("model", in: items) == ["nova-3"])
        #expect(values("numerals", in: items) == ["true"])
        #expect(values("encoding", in: items) == ["linear16"])
        #expect(values("sample_rate", in: items) == ["16000"])

        #expect(values("endpointing", in: items) == ["300"])
    }

    @Test func aTokenWithKeytermsCarriesThemThrough() throws {
        let json = #"{"provider":"deepgram","token":"jwt","expiresAt":1,"language":"es","keyterms":["Telar","Zarigüeya"]}"#
        let answer = try JSONDecoder().decode(DictationTokenAnswer.self, from: Data(json.utf8))
        #expect(answer.listenKeyterms == ["Telar", "Zarigüeya"])
    }

    @Test func aMacFromBeforeThisExistedStillMintsAUsableToken() throws {
        let json = #"{"provider":"deepgram","token":"jwt","expiresAt":1,"language":"es"}"#
        let answer = try JSONDecoder().decode(DictationTokenAnswer.self, from: Data(json.utf8))
        #expect(answer.listenKeyterms.isEmpty)
        #expect(values("keyterm", in: query(language: answer.listenLanguage, keyterms: answer.listenKeyterms)).isEmpty)
    }
}
