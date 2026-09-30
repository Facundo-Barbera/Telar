import Foundation

struct DictationFrame: Decodable, Sendable {
    var type: String?
    var isFinal: Bool?
    var channel: Channel?

    struct Channel: Decodable, Sendable {
        var alternatives: [Alternative]?
    }
    struct Alternative: Decodable, Sendable {
        var transcript: String?
    }

    enum CodingKeys: String, CodingKey {
        case type
        case isFinal = "is_final"
        case channel
    }

    static func read(_ text: String) -> DictationFrame? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(DictationFrame.self, from: data)
    }
}

struct DictationWords: Equatable, Sendable {
    var text: String

    var final: Bool
}

enum DictationTranscript {
    static func read(_ frame: DictationFrame) -> DictationWords? {
        if let type = frame.type, type != "Results" { return nil }
        guard let alternatives = frame.channel?.alternatives else { return nil }
        let said = (alternatives.first?.transcript ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return DictationWords(text: said, final: frame.isFinal == true)
    }
}
