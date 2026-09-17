import SwiftUI

/// THE MIC BADGE AT THE CARET, WHILE TELAR IS LISTENING (#561).
///
/// ── WHAT IT IS COPYING, AND WHY ─────────────────────────────────────────────
/// iOS puts a small floating badge at the insertion point while its own
/// dictation runs, and the owner asked for the same thing here — the reference
/// shot (`docs/design/dictation-caret-reference.png`) is iOS's own badge
/// sitting over this very composer. It is the right borrowing rather than a
/// cosmetic one: the mic button is in a toolbar the eye is not on, and the
/// place a person IS looking while they dictate is where the words are landing.
/// A recording nobody remembered starting is this feature's whole failure mode,
/// and this puts the indicator in the one spot already being watched.
///
/// ── IT IS AN OVERLAY, NOT A CHARACTER ───────────────────────────────────────
/// Nothing about it is in the text. The draft is a `String` that gets sent to
/// an agent, and a badge that was part of it — an attachment attribute, a
/// placeholder glyph — would be a thing to strip on the way out and a thing
/// somebody's cursor could land inside. It floats above the field, positioned
/// from `caretRect(for:)`, and the field never knows.
///
/// ── AND IT IS NOT A CONTROL ─────────────────────────────────────────────────
/// `allowsHitTesting(false)` and hidden from VoiceOver. It sits over the words
/// being typed, so a tap target there would eat a caret placement mid-sentence.
/// The mic BUTTON in the toolbar is the control and is what VoiceOver is told
/// about; this is a second drawing of a state that already has a name.
struct DictationCaretPill: View {
    /// The language code the Mac answered on the token — `nil` reads as AUTO.
    let language: String?

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "mic.fill")
                .font(.system(size: 9, weight: .semibold))
            Text(DictationLanguages.badge(language))
                .font(.system(size: 10, weight: .semibold))
                .monospacedDigit()
        }
        .foregroundStyle(Theme.primaryGlyph)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill(Theme.accent))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// The badge's own box, for the arithmetic that places it. STATED RATHER
    /// THAN MEASURED: a `GeometryReader` around it would be a layout pass per
    /// interim frame to size a thing whose size never changes.
    static let size = CGSize(width: 52, height: 20)
    /// How far above the caret's own line it floats, and how far left of the
    /// caret it starts. Both small — it is anchored to the caret, and a badge
    /// that drifted would read as belonging to some other line.
    static let lift: CGFloat = 4
    static let nudge: CGFloat = 2

    /// WHERE TO PUT IT for a caret at `rect`, in the same coordinate space.
    ///
    /// ABOVE THE CARET, NOT BESIDE IT: beside it is where the next word is
    /// about to be written, so a badge there covers the thing it is reporting
    /// on. Clamped at the leading and top edges so a caret on the first line of
    /// the box does not push it out of the field entirely.
    static func origin(for rect: CGRect) -> CGPoint {
        CGPoint(x: max(rect.minX - nudge, 0), y: max(rect.minY - lift - size.height, 0))
    }
}
