import Foundation
import Testing
@testable import TelarMobile

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
        let detail = peer("run_1")
        var twin = makeItem("item_twin", runId: "run_1", status: "completed")
        twin.detail = .notification(detail)
        let subject = turn("run_1", notification: detail, items: [openingItem("run_1", detail), JournalItem(item: twin, streamedText: "", openedBy: 1)])
        #expect(withoutOpeningNotification(subject).map(\.id) == ["item_twin"])
    }

    @Test func aTurnWithNoArrivalOfItsOwnIsUntouched() {
        let mid = wake("run_other")
        let subject = turn("run_1", notification: nil, items: [openingItem("run_1", mid), row("cmd_1")], origin: "user", prompt: "look at the failing test")
        #expect(withoutOpeningNotification(subject).map(\.id) == ["notification_run_1", "cmd_1"])
    }
}
