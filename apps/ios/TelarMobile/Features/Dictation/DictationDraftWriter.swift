import Foundation

struct DictationDraftWriter {
    private var span: NSRange?
    private var anchor: Int?
    private var committed: String?
    private var spent = 0

    var unconfirmed: Range<Int>? { span.map { $0.location ..< NSMaxRange($0) } }

    init() {}

    mutating func forget() {
        span = nil
        anchor = nil
        committed = nil
        spent = 0
    }

    mutating func write(_ words: DictationWords, into draft: String, caret: Int? = nil) -> String {
        if let committed {
            if committed != draft { absorb(from: committed, to: draft) }
        } else {
            anchor = caret
        }
        let said = Self.dropping(spent, wordsOf: words.text)
        if words.final { spent = 0 }

        let text = draft as NSString
        var range: NSRange
        var insert = said
        var lead = 0
        if let live = span {
            range = live
        } else {
            guard !said.isEmpty else {
                committed = draft
                return draft
            }
            let at = min(max(0, anchor ?? text.length), text.length)
            range = NSRange(location: at, length: 0)
            if at > 0, !Self.isSpace(text.character(at: at - 1)) {
                insert = " " + insert
                lead = 1
            }
            if at < text.length, !Self.isSpace(text.character(at: at)) { insert += " " }
        }
        let next = text.replacingCharacters(in: range, with: insert)
        let start = range.location + lead
        let end = start + (said as NSString).length
        span = words.final ? nil : NSRange(location: start, length: end - start)
        anchor = end
        committed = next
        return next
    }

    private mutating func absorb(from old: String, to new: String) {
        guard let edit = ComposerTextEdit.replacement(from: old, to: new) else { return }
        let added = (edit.text as NSString).length
        let delta = added - edit.range.length
        let resume = edit.range.location + added

        if let live = span {
            if NSMaxRange(edit.range) < live.location {
                span = NSRange(location: live.location + delta, length: live.length)
            } else if edit.range.location <= NSMaxRange(live) {
                spent += Self.words(in: (old as NSString).substring(with: live)).count
                span = nil
            }
        }
        if let at = anchor, edit.range.location <= at {
            anchor = NSMaxRange(edit.range) < at ? at + delta : resume
        }
    }

    private static func words(in text: String) -> [Substring] {
        text.split(whereSeparator: \.isWhitespace)
    }

    private static func dropping(_ count: Int, wordsOf text: String) -> String {
        guard count > 0 else { return text }
        return words(in: text).dropFirst(count).joined(separator: " ")
    }

    private static func isSpace(_ unit: unichar) -> Bool {
        UnicodeScalar(unit).map { Character($0).isWhitespace } ?? false
    }
}

@MainActor final class DictationDraftBox {
    private var writer = DictationDraftWriter()

    init() {}

    var unconfirmed: Range<Int>? { writer.unconfirmed }

    func write(_ words: DictationWords, into draft: String, caret: Int?) -> String {
        writer.write(words, into: draft, caret: caret)
    }

    func forget() {
        writer.forget()
    }
}
