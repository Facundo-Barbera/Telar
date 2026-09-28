import Foundation

/// THE SMALLEST EDIT THAT TURNS ONE DRAFT INTO THE OTHER (#624).
///
/// ── WHY A DIFF AT ALL ───────────────────────────────────────────────────────
/// `UITextView.text = string` is a REPLACEMENT, not an edit. It drops the
/// marked-text range, the inline prediction and the correction context the
/// keyboard is tracking, and it never goes through `UITextInputDelegate`, so
/// the keyboard is not told it happened — it keeps correcting against a buffer
/// that no longer exists. `ComposerTextView` used to do exactly that on every
/// SwiftUI update pass where the strings differed, which is why autocorrect
/// misbehaved while typing and misbehaved worst under dictation, where an
/// interim transcript rewrites the draft several times a second.
///
/// The cure is to tell UIKit WHAT CHANGED instead of handing it a new buffer,
/// and that needs a range. This is the arithmetic that finds one: the common
/// prefix and the common suffix are untouched, so everything between them is
/// the edit. For a dictation revising its last word that is a handful of
/// characters at the tail, and the keyboard's context for the rest of the
/// sentence survives.
///
/// ── UTF-16, BECAUSE THAT IS WHAT THE FIELD COUNTS IN ────────────────────────
/// `UITextPosition` offsets and `NSRange` are UTF-16 code units, so the answer
/// has to be too — a `String.Index` diff would be right about the text and
/// wrong about the field. Foundation-only and free of UIKit deliberately: every
/// rule below is a pure function over two strings, which is the half of this
/// fix a test can actually drive without a device.
enum ComposerTextEdit {
    /// The one run of `old` to replace, and what to put there — or `nil` when
    /// the two are already the same string.
    ///
    /// EXACT EQUALITY, NOT SWIFT'S. `String ==` compares canonical equivalence,
    /// so a precomposed "é" and a decomposed one are equal to it and different
    /// to the field. The field's opinion is the one that matters here.
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

        // NEVER HALFWAY THROUGH A CHARACTER. Two emoji that differ only in
        // their low surrogate share a high one, and a range starting between
        // the pair is not a position the field can make — it would refuse the
        // edit, or worse, take it and leave a lone surrogate in the draft.
        while prefix > 0, !isBoundary(a, prefix) || !isBoundary(b, prefix) { prefix -= 1 }
        while suffix > 0, !isBoundary(a, a.length - suffix) || !isBoundary(b, b.length - suffix) { suffix -= 1 }

        return (
            NSRange(location: prefix, length: a.length - suffix - prefix),
            b.substring(with: NSRange(location: prefix, length: b.length - suffix - prefix))
        )
    }

    /// Whether `index` falls between two characters rather than inside one.
    /// Both ends of a string always do.
    private static func isBoundary(_ string: NSString, _ index: Int) -> Bool {
        guard index > 0, index < string.length else { return true }
        return string.rangeOfComposedCharacterSequence(at: index).location == index
    }

    /// WHERE A SELECTION ENDS UP once that edit has been applied, or `nil` when
    /// the edit ran through it and the field's own answer — the caret after the
    /// inserted text — is the better one.
    ///
    /// A dictation writes at the tail while the person's caret may be anywhere;
    /// a send clears the whole box. Neither should move a caret the edit did
    /// not touch, and the wholesale assignment this replaces moved it every
    /// time.
    ///
    /// THE TWO TESTS ARE IN THIS ORDER ON PURPOSE. A caret sitting exactly
    /// where an insertion lands satisfies both readings — the text is after it
    /// and it is after the text — and the one that matters is the first: words
    /// appearing at the caret are words the person should end up behind, which
    /// is every dictated phrase landing at the end of a draft.
    static func selection(_ selection: NSRange, after range: NSRange, replacedBy text: String) -> NSRange? {
        if selection.location >= range.location + range.length {
            let delta = (text as NSString).length - range.length
            return NSRange(location: selection.location + delta, length: selection.length)
        }
        if range.location >= selection.location + selection.length { return selection }
        return nil
    }
}
