import Foundation

struct DictationTokenAnswer: Decodable, Sendable {
    var provider: String
    var token: String

    var expiresAt: Double

    var language: String?

    var keyterms: [String]?

    var listenLanguage: String { language ?? DictationLanguages.automatic }
    var listenKeyterms: [String] { keyterms ?? [] }
}

struct DictationDiagnosisAnswer: Decodable, Sendable {
    var fault: String?

    var reason: String
}

struct DictationAnswer: Decodable, Sendable {
    struct State: Decodable, Sendable {
        var provider: String
        var configured: Bool

        var language: String?

        var languages: [DictationLanguageOption]?

        var vocabulary: [String]?
    }
    var dictation: State
}

struct DictationLanguageOption: Decodable, Sendable, Identifiable, Hashable {
    var code: String
    var label: String

    var id: String { code }
}

enum DictationLanguages {
    static let automatic = "multi"

    static let automaticBadge = "AUTO"

    static func badge(_ code: String?) -> String {
        let trimmed = (code ?? "").trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return automaticBadge }
        return trimmed == automatic ? automaticBadge : trimmed.uppercased()
    }
}

enum DictationProvider {
    static let off = "off"

    static let deepgram = "deepgram"

    static func canDictateHere(_ provider: String) -> Bool {
        provider == deepgram
    }
}
