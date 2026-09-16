import SwiftUI
import Testing
@testable import TelarMobile

/// THE AGENT SCREEN OPENS AT THE BOTTOM (#539, item 7).
///
/// It opened at the TOP: the old anchor fired only `onChange(of: rows.count)`,
/// and that misses both cases that matter — the first page lands in ONE
/// assignment before the view has a bottom to scroll to, and a re-open starts
/// with the rows already in hand, so the count never changes. A person opening
/// the Agent read the oldest thing it had ever said.
///
/// The issue names the test: a view model with 60 rows reports the
/// bottom-anchored position after the first load.
@Suite @MainActor struct AgentScrollTests {
    @Test func sixtyRowsLandAtTheBottomAfterTheFirstLoad() {
        let scroll = AgentTranscriptScroll()
        // The whole first page, in one assignment — which is exactly how it
        // arrives, and exactly what a count-delta anchor could not see.
        scroll.rowsChanged(to: 60)
        #expect(scroll.loaded)
        #expect(scroll.position.edge == .bottom)
    }

    @Test func anEmptyThreadIsPinnedTooSoTheFirstAnswerLandsInView() {
        let scroll = AgentTranscriptScroll()
        scroll.rowsChanged(to: 0)
        #expect(scroll.loaded)
        #expect(scroll.position.edge == .bottom)
    }

    @Test func newRowsFollowTheTail() {
        let scroll = AgentTranscriptScroll()
        scroll.rowsChanged(to: 60)
        scroll.rowsChanged(to: 63)
        #expect(scroll.seenRows == 63)
        #expect(scroll.position.edge == .bottom)
    }

    @Test func aPollThatBroughtNothingDoesNotYankTheViewport() {
        // A READER WHO SCROLLED UP KEEPS THEIR PLACE. The poll runs every three
        // seconds and most ticks bring nothing; re-pinning on each of them would
        // make re-reading the conversation impossible.
        let scroll = AgentTranscriptScroll()
        scroll.rowsChanged(to: 60)
        let before = scroll.position
        scroll.rowsChanged(to: 60)
        #expect(scroll.position == before)
    }

    @Test func sendingIsADeliberateReturnToTheTail() {
        // Unlike a poll: you wrote it, so you are going to it. This is what the
        // composer's `onSend` calls.
        let scroll = AgentTranscriptScroll()
        scroll.rowsChanged(to: 60)
        scroll.pinToTail()
        #expect(scroll.position.edge == .bottom)
    }
}
