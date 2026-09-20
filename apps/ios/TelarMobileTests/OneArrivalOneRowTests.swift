import Foundation
import Testing
@testable import TelarMobile

/// ONE ARRIVAL DRAWS ONE NOTIFICATION ROW — issue #590, on the phone.
///
/// ── THE BUG ─────────────────────────────────────────────────────────────────
/// An arrival that opens a turn is stored on the TURN and on the turn's first
/// ITEM on purpose, and this screen drew both: the header above, and the
/// `notification_<runId>` item again as the first response's boundary. For a
/// peer's message the two at least differed; for a WAKE, which has no message on
/// either side, they were the identical line, twice.
///
/// ── WHAT THESE PIN ──────────────────────────────────────────────────────────
/// That the header survives and the item goes, keyed on the id the engine mints
/// from the run — never on a matching summary, which would eventually eat a real
/// second arrival from the same session.
@Suite struct OneArrivalOneRowTests {
    private static let worker = "session_worker123456"

    private func wake(_ runId: String) -> NotificationDetail {
        NotificationDetail(
            kind: "wake",
            sessionId: Self.worker,
            runId: runId,
            wakeKind: "turn_completed",
            summary: "[wake: completed] Session \(Self.worker) — turn \(runId) completed.",
            body: "[wake: completed] Session \(Self.worker) — turn \(runId) completed."
        )
    }

    private func peer(_ runId: String) -> NotificationDetail {
        NotificationDetail(
            kind: "peer_message",
            sessionId: Self.worker,
            runId: runId,
            intent: "result",
            summary: "[agent message · result] session \(Self.worker) sent a result (run \(runId), 5,793 chars).",
            body: "[agent message · result] session \(Self.worker) sent a result (run \(runId), 5,793 chars)."
        )
    }

    /// The row the engine writes at accept, under the id it mints from the run.
    private func openingItem(_ runId: String, _ detail: NotificationDetail) -> JournalItem {
        var item = makeItem("notification_\(runId)", runId: runId, status: "completed")
        item.detail = .notification(detail)
        return JournalItem(item: item, streamedText: "", openedBy: 0)
    }

    private func row(_ id: String, runId: String = "run_1") -> JournalItem {
        JournalItem(item: makeItem(id, runId: runId, type: "command_execution"), streamedText: "", openedBy: 1)
    }

    private func turn(
        _ runId: String,
        notification: NotificationDetail?,
        items: [JournalItem] = [],
        state: TurnState = .completed,
        resultText: String = "",
        failure: String? = nil,
        usage: UsageSnapshot? = nil,
        origin: String? = "session",
        prompt: String = "[notification: wake · turn_completed]"
    ) -> JournalTurn {
        JournalTurn(
            runId: runId,
            prompt: prompt,
            state: state,
            items: items,
            tasks: [],
            resultText: resultText,
            failure: failure,
            usage: usage,
            origin: origin,
            notification: notification
        )
    }

    /// A wake the engine queued and a worker has since finished: a row, and
    /// nothing under it.
    private func wakeTurn(_ runId: String) -> JournalTurn {
        let detail = wake("child_\(runId)")
        return turn(runId, notification: detail, items: [openingItem(runId, detail)])
    }

    @Test func theOpeningArrivalIsDrawnOnceRatherThanAsTheHeaderAndAgainAsAnItem() {
        let subject = wakeTurn("run_1")
        #expect(subject.items.map(\.id) == ["notification_run_1"])
        #expect(withoutOpeningNotification(subject).isEmpty)
    }

    @Test func onlyTheItemTheEngineMintedFromTHISRunIsDropped() {
        // A SECOND arrival from the same session, word for word, is two errands.
        // The key is an id, never a matching summary.
        let detail = peer("run_1")
        var twin = makeItem("item_twin", runId: "run_1", status: "completed")
        twin.detail = .notification(detail)
        let subject = turn("run_1", notification: detail, items: [openingItem("run_1", detail), JournalItem(item: twin, streamedText: "", openedBy: 1)])
        #expect(withoutOpeningNotification(subject).map(\.id) == ["item_twin"])
    }

    @Test func aTurnWithNoArrivalOfItsOwnIsUntouched() {
        // Not even an item that happens to carry the minted id: with no header
        // drawing it, dropping it would lose the arrival entirely.
        let mid = wake("run_other")
        let subject = turn("run_1", notification: nil, items: [openingItem("run_1", mid), row("cmd_1")], origin: "user", prompt: "look at the failing test")
        #expect(withoutOpeningNotification(subject).map(\.id) == ["notification_run_1", "cmd_1"])
    }
}
