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
    /// (`monitoring` deliberately does NOT count, matching the web fold: it
    /// holds off the clock in `isSettled`, but not a person's settle.)
    static func isWorking(_ session: Session) -> Bool {
        session.activity == .working || session.activity == .queued
    }

    /// IS THERE AN ANSWER ON THIS SESSION NOBODY HAS READ?
    ///
    /// Two engine-owned numbers and a `>`, exactly as the web has it. Both come
    /// from the Mac, so the phone and the cockpit answer this identically and
    /// the answer survives a reload — which is the whole reason it is not a
    /// local flag.
    ///
    /// ABSENT `lastTurnSequence` MEANS "NOTHING TO READ", NOT "UNKNOWN". An
    /// engine that models receipts always sets it once a turn has produced a
    /// result, so the only session without one has never answered. Reading
    /// absence as unread would make every row from a Mac too old to send the
    /// field immortal in the list.
    static func hasUnreadResult(_ session: Session) -> Bool {
        guard let last = session.lastTurnSequence else { return false }
        return last > (session.lastReadTurnSequence ?? 0)
    }

    /// DOES THIS ROW WEAR THE UNREAD DOT? The web's `showsUnreadMark`.
    ///
    /// A ROW SHOWS ITS STATUS OR ITS DOT, NEVER BOTH: a session that is working,
    /// or parked on a question, has something louder and more current to say,
    /// and an "unread answer" mark beside it is a claim about the past arguing
    /// with a claim about the present. Monitoring keeps its dot — a background
    /// watcher is not producing an answer, and the one it produced before it
    /// started watching is still unread.
    static func showsUnreadMark(_ session: Session) -> Bool {
        if session.activity == .blocked || isWorking(session) { return false }
        return hasUnreadResult(session)
    }

    /// WHEN THE INACTIVITY CLOCK STARTS COUNTING — `updatedAt` alone is the
    /// wrong baseline twice over, and the web fixed both (`idleSince`):
    ///
    ///   - A SNOOZE MUST NOT EXPIRE INTO A SHELF. "Tomorrow at 9" on a Mac that
    ///     shelves after three hours used to mean the row came back already
    ///     shelved; counting from the wake gives it the full window.
    ///   - READING IS NOT NOTHING. A read never stamps `updatedAt` (that is the
    ///     session's work, and this clock is measured from it), so `readAt` is
    ///     picked up here instead.
    private static func idleSince(_ session: Session) -> Double {
        Double(max(session.updatedAt, session.readAt ?? 0, session.snoozedUntil ?? 0))
    }

    static func isSettled(_ session: Session, now: Timestamp, autoSettleAfterHours: Double?) -> Bool {
        if session.activity == .blocked || isWorking(session) { return false }
        if session.state == .archived { return true }
        if session.settledOverride == "settled" { return true }
        if session.settledOverride == "active" { return false }
        // The two things the clock has no business overruling. A LIVE SNOOZE
        // owns its whole interval — the row is hidden either way, so this only
        // decides which shelf it lands on when it wakes. AN UNREAD RESULT IS
        // NEVER SHELVED BY NEGLECT: the clock's premise is "nothing has
        // happened here for hours", and an answer waiting to be read is
        // something that happened. Both sit BELOW the pin, because a human
        // settling a session with an unread answer in front of them means it.
        if let until = session.snoozedUntil, until > now { return false }
        if hasUnreadResult(session) { return false }
        // LIVE BACKGROUND WORK IS SOMETHING HAPPENING — the protocol's
        // `backgroundWork` clause. Below the pin, so a hand settle still
        // shelves a monitoring row; above the clock, so neglect never does.
        if session.activity == .monitoring { return false }
        guard let hours = autoSettleAfterHours else { return false }
        return idleSince(session) < Double(now) - hours * hourMs
    }

    /// WHY THE SHELF TOOK IT — issue #378, and the web's `settledHint` word for
    /// word, so the phone and the Mac say the same sentence about the same row.
    ///
    /// ONLY EVER FOR AN ENGINE SETTLE. A row a person shelved needs no
    /// explanation: they were there. This is the one case where the reader did
    /// not make the decision.
    ///
    /// THE COORDINATOR IS NAMED WHEN IT CAN BE. Its id is meaningful only on
    /// its own Mac, and an archived one is not on the list the rail resolves
    /// titles from — so the sentence stands without a name rather than printing
    /// a raw id at somebody.
    static func settledHint(_ session: Session, coordinatorTitle: String?) -> String? {
        guard session.settledBy != nil else { return nil }
        guard let title = coordinatorTitle, !title.isEmpty else {
            return "Settled after its delegated work was delivered"
        }
        return "Settled after its work for \(title) was delivered"
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
