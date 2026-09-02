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
