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
        #expect(sections.active.count == 1)
        #expect(sections.settled.count == 1)
        #expect(sections.snoozed.count == 1)
    }

    /// WHY THE SHELF TOOK IT — issue #378. The Mac shelves a delegate once its
    /// coordinator has taken delivery, so the phone meets a settled row nobody
    /// on this device decided about, and it has to be able to say so.
    @Test func theEngineSettleDecodesAndExplainsItself() {
        let settled = session(#""settledOverride":"settled","settledBy":{"kind":"delegation","coordinatorSessionId":"session_coord","runId":"run_task","at":900}"#)
        #expect(settled.settledBy?.kind == "delegation")
        #expect(settled.settledBy?.coordinatorSessionId == "session_coord")
        #expect(settled.settledBy?.runId == "run_task")
        #expect(Settling.settledHint(settled, coordinatorTitle: "Ship the exports fix")
                == "Settled after its work for Ship the exports fix was delivered")
        // An archived coordinator is not on the list the rail resolves titles
        // from. The sentence stands without a name — printing a raw id at
        // somebody would be worse than naming nobody.
        #expect(Settling.settledHint(settled, coordinatorTitle: nil)
                == "Settled after its delegated work was delivered")
        #expect(Settling.settledHint(settled, coordinatorTitle: "")
                == "Settled after its delegated work was delivered")
    }

    @Test func aSettleAPersonMadeHasNothingToExplain() {
        #expect(Settling.settledHint(session(#""settledOverride":"settled""#), coordinatorTitle: "Anybody") == nil)
        #expect(Settling.settledHint(session(""), coordinatorTitle: nil) == nil)
    }

    @Test func aReasonThisBuildHasNeverHeardOF_doesNotDropTheRow() {
        // `kind` is a String for exactly this: a Mac newer than the phone can
        // stamp a reason nobody here knows, and losing a hint must not cost the
        // whole session record.
        let odd = session(#""settledOverride":"settled","settledBy":{"kind":"something-new","coordinatorSessionId":"session_x"}"#)
        #expect(odd.title == "T")
        #expect(odd.settledBy?.kind == "something-new")
        #expect(odd.settledBy?.runId == nil)
    }

    @Test func aMacTooOldToSendTheStampIsStillReadable() {
        #expect(session("").settledBy == nil)
    }
}

/// UNREAD, on the same cases the web's session-settling.test.ts pins.
///
/// The wire test is first and is not optional: `lastTurnSequence` is DERIVED
/// per read and never appears in the stored session document, so a fixture
/// written from the persisted record would have "proved" the decode while the
/// field the rule actually reads went missing. The JSON below is copied
/// verbatim out of a live `GET /v2/sessions/live`.
@Suite struct UnreadTests {
    /// `state` is left OUT of the base rather than defaulted in it: Foundation
    /// keeps the FIRST of duplicate JSON keys, so a `"state"` in the base would
    /// silently swallow an override naming the other one. The decoder already
    /// defaults an absent `state` to `active`.
    private func session(_ overrides: String) -> Session {
        let activity = overrides.contains("\"activity\"") ? "" : #","activity":"idle""#
        let base = """
        {"id":"s","projectId":"p","title":"T",
         "createdAt":1,"updatedAt":1000,"driver":"claude",
         "workspace":{"mode":"local","path":"/x"},"runtimeMode":"auto","detached":false\(activity)\(overrides.isEmpty ? "" : "," + overrides)}
        """
        return try! JSONDecoder().decode(Session.self, from: Data(base.utf8))
    }

    @Test func theUnreadPairDecodesOffTheLiveWire() throws {
        // Verbatim from the live sessions API — an idle session whose newest
        // result (25) is one ahead of the newest receipt (24).
        let live = #"""
        {
          "id": "session_d016f60f8e27488d9f832539fb90b9fd",
          "projectId": "project_c2011ca1ad3345eb8b0655138036a9cf",
          "environmentId": "local",
          "title": "I want to finish upgrading the voice engine of the project so that its responsiv",
          "state": "active",
          "createdAt": 1789073036516,
          "updatedAt": 1789089647766,
          "providerInstanceId": "claude",
          "driver": "claude",
          "model": { "instanceId": "claude", "effort": "medium" },
          "workspace": {
            "mode": "local",
            "path": "/Users/facundo/Projects/iaware/NuSkills-Coach-v2",
            "baseRef": "05a9ff2d67f1a0d16c9087d022514e51de234b3c"
          },
          "envMode": "local",
          "runtimeMode": "auto",
          "interactionMode": "default",
          "detached": true,
          "activity": "idle",
          "lastReadTurnSequence": 24,
          "readAt": 1789089090531,
          "settledOverride": "settled",
          "settledAt": 1789089647766,
          "resumeCursor": "726727a6-5b2b-4ebd-ac86-463f052d2f41",
          "lastTurnEndedAt": 1789089411275,
          "lastTurnSequence": 25
        }
        """#
        let session = try JSONDecoder().decode(Session.self, from: Data(live.utf8))
        #expect(session.lastTurnSequence == 25)
        #expect(session.lastReadTurnSequence == 24)
        #expect(session.readAt == 1_789_089_090_531)
        #expect(Settling.hasUnreadResult(session))
        #expect(Settling.showsUnreadMark(session))
        // And the pin still outranks it: a human settled this one.
        #expect(Settling.isSettled(session, now: 1_789_089_647_800, autoSettleAfterHours: 3))
    }

    @Test func unreadIsTheTwoSequencesNotAClock() {
        #expect(Settling.hasUnreadResult(session(#""lastTurnSequence":7"#)))
        #expect(!Settling.hasUnreadResult(session(#""lastTurnSequence":7,"lastReadTurnSequence":7"#)))
        #expect(Settling.hasUnreadResult(session(#""lastTurnSequence":8,"lastReadTurnSequence":7"#)))
    }

    @Test func aSessionWithNoResultAtAllHasNothingToRead() {
        // Absent means "never answered", not "unknown" — a Mac too old to send
        // the field must not have every one of its rows marked unread forever.
        #expect(!Settling.hasUnreadResult(session("")))
        #expect(!Settling.showsUnreadMark(session("")))
        #expect(!Settling.showsUnreadMark(session(#""lastReadTurnSequence":4"#)))
    }

    @Test func theRowShowsItsStatusOrItsDotNeverBoth() {
        #expect(Settling.showsUnreadMark(session(#""lastTurnSequence":7"#)))
        #expect(!Settling.showsUnreadMark(session(#""lastTurnSequence":7,"activity":"working""#)))
        #expect(!Settling.showsUnreadMark(session(#""lastTurnSequence":7,"activity":"queued""#)))
        #expect(!Settling.showsUnreadMark(session(#""lastTurnSequence":7,"activity":"blocked""#)))
        // Monitoring keeps its dot: a watcher is not producing an answer, and
        // the one it produced before it started watching is still unread.
        #expect(Settling.showsUnreadMark(session(#""lastTurnSequence":7,"activity":"monitoring""#)))
    }

    @Test func theInactivityWindowDoesNotHideAnUnreadAnswer() {
        let fourHoursOn: Timestamp = 1000 + 4 * 3_600_000
        #expect(!Settling.isSettled(session(#""lastTurnSequence":7"#), now: fourHoursOn, autoSettleAfterHours: 3))
        // …and reading it hands the session back to the clock.
        #expect(Settling.isSettled(session(#""lastTurnSequence":7,"lastReadTurnSequence":7"#), now: fourHoursOn, autoSettleAfterHours: 3))
        // Read a moment ago: the window runs from the READ, not from the work.
        #expect(!Settling.isSettled(
            session(#""lastTurnSequence":7,"lastReadTurnSequence":7,"readAt":\#(1000 + 3 * 3_600_000)"#),
            now: fourHoursOn, autoSettleAfterHours: 3
        ))
        // A NEWER answer makes a read session unread again.
        #expect(!Settling.isSettled(session(#""lastTurnSequence":8,"lastReadTurnSequence":7"#), now: fourHoursOn, autoSettleAfterHours: 3))
    }

    @Test func butAnExplicitSettleStillShelvesIt() {
        // A human settling a session with an unread answer in front of them
        // means it — the pin sits above both guards.
        let now: Timestamp = 1000 + 4 * 3_600_000
        #expect(Settling.isSettled(session(#""lastTurnSequence":7,"settledOverride":"settled""#), now: now, autoSettleAfterHours: 3))
        #expect(Settling.isSettled(session(#""lastTurnSequence":7,"settledOverride":"settled""#), now: now, autoSettleAfterHours: nil))
        // An archived session is over whether or not anyone read it.
        #expect(Settling.isSettled(session(#""lastTurnSequence":7,"state":"archived""#), now: now, autoSettleAfterHours: 3))
    }
}

/// The snooze choices, on the same cases the web's session-settling.test.ts
/// pins: calendar days not fixed offsets, "this evening" vanishing when it is
/// nearly evening, and "next week" meaning the NEXT Monday on a Monday.
@Suite struct SnoozePresetTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Mexico_City")!
        return calendar
    }
    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }
    private func components(_ stamp: Timestamp) -> DateComponents {
        calendar.dateComponents([.year, .month, .day, .hour, .minute, .weekday], from: Date(timeIntervalSince1970: TimeInterval(stamp) / 1000))
    }

    @Test func aMorningOffersAllFiveInOrder() {
        // Wednesday 2026-09-09, 10:00.
        let presets = snoozePresets(now: date(2026, 9, 9, 10), calendar: calendar)
        #expect(presets.map(\.kind) == [.hour, .threeHours, .evening, .tomorrow, .nextWeek])
        let evening = components(presets[2].until)
        #expect(evening.day == 9 && evening.hour == 18)
        let tomorrow = components(presets[3].until)
        #expect(tomorrow.day == 10 && tomorrow.hour == 9)
        let nextWeek = components(presets[4].until)
        #expect(nextWeek.weekday == 2 && nextWeek.day == 14 && nextWeek.hour == 9)
    }

    @Test func thisEveningDisappearsOnceItIsNearlyEvening() {
        let presets = snoozePresets(now: date(2026, 9, 9, 17, 30), calendar: calendar)
        #expect(!presets.contains { $0.kind == .evening })
        #expect(presets.count == 4)
    }

    @Test func nextWeekOnAMondayIsTheFollowingMonday() {
        // Monday 2026-09-14.
        let presets = snoozePresets(now: date(2026, 9, 14, 10), calendar: calendar)
        let nextWeek = components(presets.first { $0.kind == .nextWeek }!.until)
        #expect(nextWeek.weekday == 2 && nextWeek.day == 21)
    }

    @Test func everyPresetIsInTheFuture() {
        let now = date(2026, 9, 9, 23, 30)
        for preset in snoozePresets(now: now, calendar: calendar) {
            #expect(Double(preset.until) > now.timeIntervalSince1970 * 1000)
        }
    }
}
