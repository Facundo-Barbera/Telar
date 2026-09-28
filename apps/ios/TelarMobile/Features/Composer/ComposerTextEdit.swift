import Foundation

enum ComposerTextEdit {
    static func replacement(from old: String, to new: String) -> (range: NSRange, text: String)? {
        let a = old as NSString
        let b = new as NSString
        guard !a.isEqual(to: new) else { return nil }

        let shared = min(a.length, b.length)
        var prefix = 0
        while prefix < shared, a.character(at: prefix) == b.character(at: prefix) { prefix += 1 }
        var suffix = 0
        while suffix < shared - prefix,
              a.character(at: a.length - 1 - suffix) == b.character(at: b.length - 1 - suffix) { suffix += 1 }

        while prefix > 0, !isBoundary(a, prefix) || !isBoundary(b, prefix) { prefix -= 1 }
        while suffix > 0, !isBoundary(a, a.length - suffix) || !isBoundary(b, b.length - suffix) { suffix -= 1 }

        return (
            NSRange(location: prefix, length: a.length - suffix - prefix),
            b.substring(with: NSRange(location: prefix, length: b.length - suffix - prefix))
        )
    }

    private static func isBoundary(_ string: NSString, _ index: Int) -> Bool {
        guard index > 0, index < string.length else { return true }
        return string.rangeOfComposedCharacterSequence(at: index).location == index
    }

    static func selection(_ selection: NSRange, after range: NSRange, replacedBy text: String) -> NSRange? {
        if selection.location >= range.location + range.length {
            let delta = (text as NSString).length - range.length
            return NSRange(location: selection.location + delta, length: selection.length)
        }
        if range.location >= selection.location + selection.length { return selection }
        return nil
    }
}
