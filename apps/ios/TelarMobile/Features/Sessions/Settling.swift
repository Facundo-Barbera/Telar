import Foundation

enum Settling {
    static let hourMs: Double = 3_600_000

    static func isWorking(_ session: Session) -> Bool {
        session.activity == .working || session.activity == .queued
    }

    static func hasUnreadResult(_ session: Session) -> Bool {
        guard let last = session.lastTurnSequence else { return false }
        return last > (session.lastReadTurnSequence ?? 0)
    }

    static func showsUnreadMark(_ session: Session) -> Bool {
        if session.activity == .blocked || isWorking(session) { return false }
        return hasUnreadResult(session)
    }

    private static func idleSince(_ session: Session) -> Double {
        Double(max(session.updatedAt, session.readAt ?? 0, session.snoozedUntil ?? 0))
    }

    static func isSettled(_ session: Session, now: Timestamp, autoSettleAfterHours: Double?) -> Bool {
        if session.activity == .blocked || isWorking(session) { return false }
        if session.state == .archived { return true }
        if session.settledOverride == "settled" { return true }
        if session.settledOverride == "active" { return false }

        if let until = session.snoozedUntil, until > now { return false }
        if hasUnreadResult(session) { return false }

        if session.activity == .monitoring { return false }
        guard let hours = autoSettleAfterHours else { return false }
        return idleSince(session) < Double(now) - hours * hourMs
    }

    static func settledHint(_ session: Session, coordinatorTitle: String?) -> String? {
        guard session.settledBy != nil else { return nil }
        guard let title = coordinatorTitle, !title.isEmpty else {
            return "Settled after its delegated work was delivered"
        }
        return "Settled after its work for \(title) was delivered"
    }

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

struct SnoozePreset: Identifiable, Equatable {
    enum Kind: String { case hour, threeHours = "three-hours", evening, tomorrow, nextWeek = "next-week" }
    let kind: Kind
    let label: String

    let when: String
    let until: Timestamp
    var id: String { kind.rawValue }
}

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

    let weekday = calendar.component(.weekday, from: now)
    var daysUntilMonday = (2 - weekday + 7) % 7
    if daysUntilMonday == 0 { daysUntilMonday = 7 }
    let nextWeek = atHour(addDays(now, daysUntilMonday), morningHour)
    let weekdayName = nextWeek.formatted(Date.FormatStyle().weekday(.abbreviated))
    presets.append(SnoozePreset(kind: .nextWeek, label: "Next week", when: "\(weekdayName) \(nextWeek.formatted(time))", until: stamp(nextWeek)))
    return presets
}
