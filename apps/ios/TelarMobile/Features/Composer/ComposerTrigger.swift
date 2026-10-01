import Foundation

struct ComposerTrigger: Equatable {
    enum Kind: Equatable { case command, skill }

    var kind: Kind
    var query: String
    var range: NSRange

    // `/` must open its line so "9/10" stays prose; `$` must start a word and not be `${`.
    static func detect(in text: String, caret: Int) -> ComposerTrigger? {
        let string = text as NSString
        let cursor = min(max(0, caret), string.length)
        let head = string.substring(to: cursor) as NSString
        let newline = head.range(of: "\n", options: .backwards)
        let lineStart = newline.location == NSNotFound ? 0 : newline.location + 1
        let line = head.substring(from: lineStart)
        if line.hasPrefix("/") {
            return ComposerTrigger(kind: .command, query: String(line.dropFirst()), range: NSRange(location: lineStart, length: cursor - lineStart))
        }

        let space = head.rangeOfCharacter(from: .whitespacesAndNewlines, options: .backwards)
        let tokenStart = space.location == NSNotFound ? 0 : space.location + space.length
        let token = head.substring(from: tokenStart)
        guard token.hasPrefix("$"), !token.hasPrefix("${") else { return nil }
        return ComposerTrigger(kind: .skill, query: String(token.dropFirst()), range: NSRange(location: tokenStart, length: cursor - tokenStart))
    }

    func replace(in text: String, with replacement: String) -> (text: String, caret: Int) {
        let string = text as NSString
        let location = min(range.location, string.length)
        let safe = NSRange(location: location, length: min(range.length, string.length - location))
        return (string.replacingCharacters(in: safe, with: replacement), location + (replacement as NSString).length)
    }

    static func opening(_ draft: String) -> String {
        if draft.isEmpty || draft.hasSuffix("\n") { return draft + "/" }
        return draft + "\n/"
    }
}
