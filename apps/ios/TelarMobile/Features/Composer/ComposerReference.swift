import Foundation

enum ComposerReference {
    static func file(_ path: String) -> String { "`\(path)`" }

    static func directory(_ path: String) -> String {
        var trimmed = path
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        return "`\(trimmed)/`"
    }

    static func insert(_ text: String, into draft: String) -> String {
        let lead = draft.isEmpty || draft.last?.isWhitespace == true ? "" : " "
        return draft + lead + text + " "
    }
}
