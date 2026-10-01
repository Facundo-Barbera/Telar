import Foundation

struct DictationStrip: Equatable {
    private(set) var settled = ""
    private(set) var heard = ""
    private var spent = 0

    var shown: String { Self.joined(settled, heard) }

    init() {}

    mutating func hear(_ words: DictationWords) {
        let said = Self.dropping(spent, wordsOf: words.text)
        if words.final {
            settled = Self.joined(settled, said)
            heard = ""
            spent = 0
        } else {
            heard = said
        }
    }

    mutating func flush() {
        guard !heard.isEmpty else { return }
        spent += Self.words(in: heard).count
        settled = Self.joined(settled, heard)
        heard = ""
    }

    mutating func take() -> String? {
        guard !settled.isEmpty else { return nil }
        defer { settled = "" }
        return settled
    }

    mutating func hold(_ text: String) {
        settled = Self.joined(text, settled)
    }

    static func appending(_ phrase: String, to draft: String) -> String {
        guard let last = draft.last, !last.isWhitespace else { return draft + phrase }
        return draft + " " + phrase
    }

    private static func joined(_ a: String, _ b: String) -> String {
        a.isEmpty ? b : b.isEmpty ? a : a + " " + b
    }

    private static func words(in text: String) -> [Substring] {
        text.split(whereSeparator: \.isWhitespace)
    }

    private static func dropping(_ count: Int, wordsOf text: String) -> String {
        guard count > 0 else { return text }
        return words(in: text).dropFirst(count).joined(separator: " ")
    }
}
