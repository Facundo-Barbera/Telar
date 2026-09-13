import Foundation

/// WHAT A REFERENCE READS LIKE ONCE IT IS IN THE BOX — the phone's half of the
/// web's `drag-reference.ts`, kept pure so the spacing can be pinned without a
/// composer.
///
/// A FILE IS JUST ITS PATH, in backticks. Not a URL, not a line range, not a
/// copy of its contents: the agent is working in this checkout and a path is
/// the thing its Read tool takes. Backticks are what stop a model reading
/// `apps/web/src/auth.ts` as prose.
enum ComposerReference {
    static func file(_ path: String) -> String { "`\(path)`" }

    /// A DIRECTORY KEEPS ITS TRAILING SLASH, and that one character is the
    /// point: an agent handed `` `apps/engine` `` has to guess whether to Read
    /// it or Glob it, and handed `` `apps/engine/` `` it does not.
    static func directory(_ path: String) -> String {
        var trimmed = path
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        return "`\(trimmed)/`"
    }

    /// Splice a reference into a draft, spaced the way a person would have
    /// typed it: never welded to the word before it, never doubling a space
    /// that is already there, and always leaving one after so the next word
    /// does not run into it.
    ///
    /// THE PHONE HAS NO CARET TO SPLICE AT. The composer's field is a
    /// `UITextView` behind a plain `String` binding and SwiftUI never sees its
    /// selection, so a reference lands at the END of the draft — which is
    /// where the person was typing anyway. The web's `insertReference` takes a
    /// caret because a browser hands it one; this is that function with the
    /// caret pinned to the end.
    static func insert(_ text: String, into draft: String) -> String {
        let lead = draft.isEmpty || draft.last?.isWhitespace == true ? "" : " "
        return draft + lead + text + " "
    }
}
