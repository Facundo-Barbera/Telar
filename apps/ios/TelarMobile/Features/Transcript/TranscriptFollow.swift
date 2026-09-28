import Foundation

/// WHETHER THE TRANSCRIPT SHOULD BE FOLLOWING ITS OWN TAIL.
///
/// A rule rather than a line inside `followTail()`, because it is the whole
/// behaviour and there are no view tests to catch it going wrong.
///
/// WHAT WAS BROKEN. `ScrollPosition.isPositionedByUser` is STICKY: it goes true
/// the moment the reader scrolls and only goes false again when the app sets
/// the position itself. `followTail()` guarded on it and did nothing else, so
/// the one thing that could clear it was the one thing it refused to do —
/// following was off for the life of the view after a single scroll, including
/// a rubber-band bounce or a momentum overshoot the reader never meant as a
/// scroll at all. The jump button could not rescue it either: it is shown for
/// `isPositionedByUser && !isAtBottom`, so a reader sitting AT the tail with
/// the flag set saw no button and got no follow — the transcript simply
/// stopped moving.
///
/// THE MISSING HALF, then, is the one the web's `use-stick-to-bottom` has had
/// all along: coming back to the end re-arms it. Being at the tail IS the
/// statement that you want what arrives next, whoever put you there.
///
/// SENDING IS NOT A CASE FOR THIS RULE. It never consults it — you wrote the
/// message, so you are going to the end regardless of where you were reading.
/// `SessionView.pinToTail()` is that path; this one is for content arriving on
/// its own.
enum TranscriptFollow {
    /// - Parameters:
    ///   - takenByReader: `ScrollPosition.isPositionedByUser`.
    ///   - atBottom: geometry's answer — the tail is on screen, within slack.
    static func shouldFollow(takenByReader: Bool, atBottom: Bool) -> Bool {
        // Nobody has taken the scroll: the pin is still the truth, and content
        // arriving belongs under it.
        if !takenByReader { return true }
        // They took it and came back. Follow again.
        return atBottom
    }
}
