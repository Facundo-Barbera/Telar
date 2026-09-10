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
