import SwiftUI

/// WHERE THE AGENT'S TRANSCRIPT IS PARKED (#539, item 7).
///
/// ── THE BUG THIS REPLACES ───────────────────────────────────────────────────
/// The screen opened at the TOP of the conversation. It scrolled to a bottom
/// anchor only `onChange(of: rows.count)`, and that misses the two cases that
/// matter: the FIRST page arrives in one assignment before the view has a
/// bottom to scroll to, and every RE-OPEN starts with the rows already in hand,
/// so the count never changes and the anchor is never used. A person opening
/// the Agent read the oldest thing it had ever said.
///
/// ── WHY `.scrollPosition` AND NOT `.defaultScrollAnchor` ────────────────────
/// `SessionView` settled this already and the reasoning is the same here: a
/// position pinned to an EDGE stays on that edge as the content grows, which is
/// the whole behaviour; `.defaultScrollAnchor` is solved once, when the
/// ScrollView first appears, and this transcript is still EMPTY then (the first
/// page lands a poll later), so it anchors nothing.
///
/// ── AND THE READER STILL WINS ───────────────────────────────────────────────
/// `isPositionedByUser` flips the moment somebody scrolls, which is how "let
/// them go" is expressed: `follow` below pins on the first page and on new
/// rows, and a reader who has scrolled up to re-read keeps their place until
/// they send something, which is a deliberate return to the tail.
///
/// LIFTED OUT OF THE VIEW so the claim is a test's to hold rather than a
/// screenshot's — see `AgentScrollTests`.
@MainActor @Observable final class AgentTranscriptScroll {
    /// SETTABLE, because `.scrollPosition($scroll.position)` binds to it: the
    /// ScrollView writes back as the reader scrolls, which is what makes
    /// `isPositionedByUser` true and "let them go" work at all. Everything that
    /// MOVES it deliberately goes through the two methods below.
    var position = ScrollPosition(edge: .bottom)
    /// How many rows the last decision was made against. The first page is the
    /// one that used to be missed, so "have we seen any rows yet" is the state
    /// that decides, not a count delta.
    private(set) var seenRows = 0
    /// True once the first page has landed and been pinned.
    private(set) var loaded = false

    /// A page landed. Pins on the FIRST one whatever its size (including an
    /// empty thread, where the pin costs nothing), and on any page that brought
    /// new rows.
    func rowsChanged(to count: Int) {
        let first = !loaded
        defer {
            seenRows = count
            loaded = true
        }
        guard first || count != seenRows else { return }
        pinToTail()
    }

    /// Straight to the tail, with no animation: this runs on every new row, and
    /// an animation per delta is what made the session's transcript visibly
    /// pump. Setting the position also clears `isPositionedByUser`, which is how
    /// a reader who scrolled up earlier gets their follow back after sending.
    func pinToTail() {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            position.scrollTo(edge: .bottom)
        }
    }
}
