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

    static func merge(draft: String, commit: String) -> String {
        let phrase = commit.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !phrase.isEmpty else { return draft }
        guard let last = draft.last else { return phrase }
        if last.isWhitespace { return draft + phrase }
        return draft + " " + phrase
    }
}

struct DictationDraftWriter {
    private var span: Range<Int>?

    var unconfirmed: Range<Int>? { span }

    private var committed: String?

    init() {}

    mutating func forget() {
        span = nil
        committed = nil
    }

    mutating func write(_ words: DictationWords, into draft: String) -> String {
        if span != nil, draft != committed { span = nil }

        if let live = span {
            let next = Self.replacing(draft, live, with: words.text)
            committed = next
            span = words.final ? nil : live.lowerBound ..< (live.lowerBound + words.text.count)
            return next
        }

        guard !words.text.isEmpty else { return draft }
        let next = merged(draft, words.text)
        committed = next

        span = words.final ? nil : (next.count - words.text.count) ..< next.count
        return next
    }

    private func merged(_ draft: String, _ text: String) -> String {
        DictationTranscript.merge(draft: draft, commit: text)
    }

    private static func replacing(_ text: String, _ range: Range<Int>, with replacement: String) -> String {
        let count = text.count
        let start = min(max(0, range.lowerBound), count)
        let end = min(max(start, range.upperBound), count)
        let lower = text.index(text.startIndex, offsetBy: start)
        let upper = text.index(text.startIndex, offsetBy: end)
        return text.replacingCharacters(in: lower ..< upper, with: replacement)
    }
}

@MainActor final class DictationDraftBox {
    private var writer = DictationDraftWriter()

    init() {}

    var unconfirmed: Range<Int>? { writer.unconfirmed }

    func write(_ words: DictationWords, into draft: String) -> String {
        writer.write(words, into: draft)
    }

    func forget() {
        writer.forget()
    }
}
