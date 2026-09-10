import Foundation

/// The settling rule, ported from `apps/web/lib/session-settling.ts` (itself
/// t3code's threadSettled). The phone previously honored only the explicit
/// pin (`settledOverride == "settled"`), so auto-settled sessions — the
/// common kind, shelved by the inactivity clock — sat in "Quiet" forever.
///
/// The three layers, in evaluation order:
///   1. Blockers beat everything — waiting-on-you or working never settles.
///   2. The explicit pin wins in both directions.
///   3. The clock decides the rest, and only if the engine's policy has one.
enum Settling {
    static let hourMs: Double = 3_600_000

    /// Working means a turn is queued or running — settling a session that is
    /// about to answer you is the same mistake as settling one mid-answer.
    /// (`monitoring` deliberately does NOT count, matching the web fold.)
    static func isWorking(_ session: Session) -> Bool {
        session.activity == .working || session.activity == .queued
    }

    static func isSettled(_ session: Session, now: Timestamp, autoSettleAfterHours: Double?) -> Bool {
        if session.activity == .blocked || isWorking(session) { return false }
        if session.state == .archived { return true }
        if session.settledOverride == "settled" { return true }
        if session.settledOverride == "active" { return false }
        guard let hours = autoSettleAfterHours else { return false }
        return Double(session.updatedAt) < Double(now) - hours * hourMs
    }

    /// Hidden until its wake time — unless it raised its hand: a parked
    /// request, a FRESH failure, or a turn that finished after the snooze.
    static func isSnoozed(_ session: Session, now: Timestamp) -> Bool {
        guard let until = session.snoozedUntil, until > now else { return false }
        if session.activity == .blocked { return false }
        if session.lastTurnFailed == true,
           session.snoozedAt == nil || (session.lastTurnEndedAt ?? 0) > (session.snoozedAt ?? 0) {
            return false
        }
        if let snoozedAt = session.snoozedAt, let ended = session.lastTurnEndedAt, ended > snoozedAt {
            return false
        }
        return true
    }
}

/// One choice in the snooze menu — the web's `SnoozePreset`.
struct SnoozePreset: Identifiable, Equatable {
    enum Kind: String { case hour, threeHours = "three-hours", evening, tomorrow, nextWeek = "next-week" }
    let kind: Kind
    let label: String
    /// The time column, which COMPLEMENTS the label rather than repeating
    /// it: "Tomorrow" pairs with "9:00 AM", not with "tomorrow 9:00 AM".
    let when: String
    let until: Timestamp
    var id: String { kind.rawValue }
}

/// The choices, resolved against the reader's own clock and calendar — the
/// web's `snoozePresets`, ported rule for rule.
///
/// ADVANCED BY CALENDAR DAY, NOT BY 86,400,000: a spring-forward day is 23
/// hours, so a fixed offset from 23:30 skips the next day entirely.
///
/// "THIS EVENING" DISAPPEARS ONCE IT IS NEARLY EVENING. A snooze that expires
/// in four minutes is not a snooze, and a row that sometimes means "an hour"
/// and sometimes "immediately" is worse than one that is not there.
func snoozePresets(now: Date, calendar: Calendar = .current) -> [SnoozePreset] {
    let eveningHour = 18, morningHour = 9
    let hour: TimeInterval = 3600
    func atHour(_ base: Date, _ h: Int) -> Date {
        calendar.date(bySettingHour: h, minute: 0, second: 0, of: base) ?? base
    }
    func addDays(_ base: Date, _ days: Int) -> Date {
        calendar.date(byAdding: .day, value: days, to: base) ?? base
    }
    func stamp(_ date: Date) -> Timestamp { Timestamp(date.timeIntervalSince1970 * 1000) }
    let time = Date.FormatStyle(date: .omitted, time: .shortened)

    var presets: [SnoozePreset] = []
    let inAnHour = now.addingTimeInterval(hour)
    presets.append(SnoozePreset(kind: .hour, label: "In 1 hour", when: inAnHour.formatted(time), until: stamp(inAnHour)))
    let inThree = now.addingTimeInterval(3 * hour)
    presets.append(SnoozePreset(kind: .threeHours, label: "In 3 hours", when: inThree.formatted(time), until: stamp(inThree)))

    let evening = atHour(now, eveningHour)
    if evening.timeIntervalSince(now) > hour {
        presets.append(SnoozePreset(kind: .evening, label: "This evening", when: evening.formatted(time), until: stamp(evening)))
    }

    let tomorrow = atHour(addDays(now, 1), morningHour)
    presets.append(SnoozePreset(kind: .tomorrow, label: "Tomorrow", when: tomorrow.formatted(time), until: stamp(tomorrow)))

    // Monday is weekday 2 in Foundation. `|| 7` so that on a Monday "next
    // week" means the NEXT Monday, not today.
    let weekday = calendar.component(.weekday, from: now)
    var daysUntilMonday = (2 - weekday + 7) % 7
    if daysUntilMonday == 0 { daysUntilMonday = 7 }
    let nextWeek = atHour(addDays(now, daysUntilMonday), morningHour)
    let weekdayName = nextWeek.formatted(Date.FormatStyle().weekday(.abbreviated))
    presets.append(SnoozePreset(kind: .nextWeek, label: "Next week", when: "\(weekdayName) \(nextWeek.formatted(time))", until: stamp(nextWeek)))
    return presets
}
