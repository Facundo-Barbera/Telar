import Foundation
import Testing
@testable import TelarMobile

/// The three-layer rule, exercised on the same cases the web's
/// session-settling.test.ts pins: blockers beat pins, pins beat the clock,
/// the clock only runs when the policy has one.
@Suite struct SettlingTests {
    private func session(_ overrides: String) -> Session {
        // Foundation keeps the FIRST of duplicate JSON keys, so the default
        // activity only appears when the override doesn't name one.
        let activity = overrides.contains("\"activity\"") ? "" : #","activity":"idle""#
        let base = """
        {"id":"s","projectId":"p","title":"T","state":"active",
         "createdAt":1,"updatedAt":1000,"driver":"claude",
         "workspace":{"mode":"local","path":"/x"},"runtimeMode":"auto","detached":false\(activity)\(overrides.isEmpty ? "" : "," + overrides)}
        """
        return try! JSONDecoder().decode(Session.self, from: Data(base.utf8))
    }

    let now: Timestamp = 1000 + 73 * 3_600_000  // 73h after updatedAt

    @Test func theClockSettlesQuietSessions() {
        #expect(Settling.isSettled(session(""), now: now, autoSettleAfterHours: 72))
        #expect(!Settling.isSettled(session(""), now: now, autoSettleAfterHours: 96))
        // No clock configured → nothing settles by neglect.
        #expect(!Settling.isSettled(session(""), now: now, autoSettleAfterHours: nil))
    }

    @Test func thePinWinsInBothDirections() {
        #expect(Settling.isSettled(session(#""settledOverride":"settled""#), now: 2000, autoSettleAfterHours: 72))
        #expect(!Settling.isSettled(session(#""settledOverride":"active""#), now: now, autoSettleAfterHours: 72))
    }

    @Test func blockersBeatEverything() {
        #expect(!Settling.isSettled(session(#""activity":"blocked","settledOverride":"settled""#), now: now, autoSettleAfterHours: 72))
        #expect(!Settling.isSettled(session(#""activity":"working""#), now: now, autoSettleAfterHours: 72))
        #expect(!Settling.isSettled(session(#""activity":"queued""#), now: now, autoSettleAfterHours: 72))
        // Monitoring does NOT count as working — matching the web's fold.
        #expect(Settling.isSettled(session(#""activity":"monitoring""#), now: now, autoSettleAfterHours: 72))
    }

    @Test func snoozeHidesUntilWokenOrRaisedHand() {
        #expect(Settling.isSnoozed(session(#""snoozedUntil":9000000000,"snoozedAt":900"#), now: 2000))
        // Expired snooze.
        #expect(!Settling.isSnoozed(session(#""snoozedUntil":1500,"snoozedAt":900"#), now: 2000))
        // A parked request wakes it.
        #expect(!Settling.isSnoozed(session(#""snoozedUntil":9000000000,"snoozedAt":900,"activity":"blocked""#), now: 2000))
        // A turn that ended BEFORE the snooze does not wake it; one that
        // finished after the snooze does.
        #expect(Settling.isSnoozed(session(#""snoozedUntil":9000000000,"snoozedAt":900,"lastTurnEndedAt":850"#), now: 2000))
        #expect(!Settling.isSnoozed(session(#""snoozedUntil":9000000000,"snoozedAt":900,"lastTurnEndedAt":1200"#), now: 2000))
        // A failure the reader snoozed ON stays snoozed; a fresh one wakes it.
        #expect(Settling.isSnoozed(session(#""snoozedUntil":9000000000,"snoozedAt":900,"lastTurnFailed":true,"lastTurnEndedAt":800"#), now: 2000))
        #expect(!Settling.isSnoozed(session(#""snoozedUntil":9000000000,"snoozedAt":900,"lastTurnFailed":true,"lastTurnEndedAt":1200"#), now: 2000))
    }

    @Test func groupingBandsSettledAndSnoozed() {
        let sections = groupInbox(
            [session(""), session(#""settledOverride":"settled""#), session(#""snoozedUntil":9000000000,"snoozedAt":900"#)],
            now: now, autoSettleAfterHours: nil
        )
        #expect(sections.quiet.count == 1)
        #expect(sections.settled.count == 1)
        #expect(sections.snoozed.count == 1)
    }
}
