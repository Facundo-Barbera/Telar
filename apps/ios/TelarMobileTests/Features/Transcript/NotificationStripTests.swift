import Foundation
import Testing
@testable import TelarMobile

@Suite struct NotificationStripTests {
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

    private func wakeTurn(_ runId: String, state: TurnState = .completed) -> JournalTurn {
        let detail = wake("child_\(runId)")
        return turn(runId, notification: detail, items: [openingItem(runId, detail)], state: state)
    }

    private func ids(_ groups: [[JournalTurn]]) -> [[String]] {
        groups.map { $0.map(\.runId) }
    }

    @Test func twoConsecutiveArrivalsAreOneGroup() {
        let answered = turn(
            "run_3",
            notification: peer("run_3"),
            items: [openingItem("run_3", peer("run_3"))],
            resultText: "Noted.",
            prompt: "Three commits landed."
        )

        #expect(ids(groupNotificationTurns([wakeTurn("run_1"), wakeTurn("run_2"), answered, wakeTurn("run_4")]))
                == [["run_1", "run_2", "run_3"], ["run_4"]])
    }

    @Test func aGroupOfOneIsOneLineAndEveryTurnComesBackExactlyOnceInOrder() {
        let typed = turn("run_typed", notification: nil, state: .completed, resultText: "Looking.", origin: "user", prompt: "look at the failing test")
        #expect(ids(groupNotificationTurns([typed, wakeTurn("run_1"), typed, wakeTurn("run_2")]))
                == [["run_typed"], ["run_1"], ["run_typed"], ["run_2"]])
    }

    @Test func aTurnWithSomethingUnderItsRowEndsTheRun() {
        let detail = wake("child")
        let opening = [openingItem("run_1", detail)]
        #expect(bareNotificationTurn(wakeTurn("run_1")))
        #expect(!bareNotificationTurn(turn("run_1", notification: detail, items: opening, resultText: "Nothing to do.")))
        #expect(!bareNotificationTurn(turn("run_1", notification: detail, items: opening, failure: "the provider hung up")))
        #expect(!bareNotificationTurn(turn("run_1", notification: detail, items: opening, usage: UsageSnapshot(tokens: TokenUsage(input: 10, output: 2, cacheRead: 0, cacheCreate: 0)))))
        #expect(!bareNotificationTurn(turn("run_1", notification: detail, items: opening, state: .stopped)))
        #expect(!bareNotificationTurn(turn("run_1", notification: detail, items: opening + [row("cmd_1")])))

        #expect(!bareNotificationTurn(turn("run_typed", notification: nil, origin: "user", prompt: "hi")))
    }

    @Test func aPendingTurnIsNeverAStripsMiddleBecauseItsQueuedIndicatorSitsUnderItsRow() {
        #expect(!bareNotificationTurn(wakeTurn("run_1", state: .queued)))
        #expect(!bareNotificationTurn(wakeTurn("run_1", state: .running)))
        #expect(ids(groupNotificationTurns([wakeTurn("run_1", state: .queued), wakeTurn("run_2")]))
                == [["run_1"], ["run_2"]])
    }
}
