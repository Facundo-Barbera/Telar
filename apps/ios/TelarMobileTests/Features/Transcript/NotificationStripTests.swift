import Foundation
import Testing
@testable import TelarMobile

/// CONSECUTIVE ARRIVALS ARE ONE STRIP — issue #577, on the phone.
///
/// ── THE BUG ─────────────────────────────────────────────────────────────────
/// A run of notification turns — two wakes and a peer's result, with nothing
/// between them — was drawn as N conversations: a 16pt turn gap around each
/// one-line row. Two wakes and a one-line reply took half the owner's viewport
/// on the Mac, and this screen draws the same shape at a smaller scale.
///
/// ── WHAT THESE PIN ──────────────────────────────────────────────────────────
/// The grouping rule, and what makes a turn bare — which on this screen is NOT
/// the same list as on the Mac, because here every pending turn carries a
/// `Queued` indicator under its row and a strip must not hide one.
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
        // The answered turn's ROW joins the strip — it is an arrival like the
        // others — and the run stops after it, so its reply hangs under the
        // block rather than inside it.
        #expect(ids(groupNotificationTurns([wakeTurn("run_1"), wakeTurn("run_2"), answered, wakeTurn("run_4")]))
                == [["run_1", "run_2", "run_3"], ["run_4"]])
    }

    @Test func aGroupOfOneIsOneLineAndEveryTurnComesBackExactlyOnceInOrder() {
        let typed = turn("run_typed", notification: nil, state: .completed, resultText: "Looking.", origin: "user", prompt: "look at the failing test")
        #expect(ids(groupNotificationTurns([typed, wakeTurn("run_1"), typed, wakeTurn("run_2")]))
                == [["run_typed"], ["run_1"], ["run_typed"], ["run_2"]])
    }

    @Test func aTurnWithSomethingUnderItsRowEndsTheRun() {
        // Each of these draws a line beneath the notification. A block that
        // swallowed one would be tightening the transcript by deleting from it.
        let detail = wake("child")
        let opening = [openingItem("run_1", detail)]
        #expect(bareNotificationTurn(wakeTurn("run_1")))
        #expect(!bareNotificationTurn(turn("run_1", notification: detail, items: opening, resultText: "Nothing to do.")))
        #expect(!bareNotificationTurn(turn("run_1", notification: detail, items: opening, failure: "the provider hung up")))
        #expect(!bareNotificationTurn(turn("run_1", notification: detail, items: opening, usage: UsageSnapshot(tokens: TokenUsage(input: 10, output: 2, cacheRead: 0, cacheCreate: 0)))))
        #expect(!bareNotificationTurn(turn("run_1", notification: detail, items: opening, state: .stopped)))
        #expect(!bareNotificationTurn(turn("run_1", notification: detail, items: opening + [row("cmd_1")])))
        // Not an arrival at all: a person's turn is never a strip's member.
        #expect(!bareNotificationTurn(turn("run_typed", notification: nil, origin: "user", prompt: "hi")))
    }

    @Test func aPendingTurnIsNeverAStripsMiddleBecauseItsQueuedIndicatorSitsUnderItsRow() {
        // The phone draws `Queued`/`Working` under EVERY active turn, not only
        // the one at the head of the queue as the Mac does. That line is content.
        #expect(!bareNotificationTurn(wakeTurn("run_1", state: .queued)))
        #expect(!bareNotificationTurn(wakeTurn("run_1", state: .running)))
        #expect(ids(groupNotificationTurns([wakeTurn("run_1", state: .queued), wakeTurn("run_2")]))
                == [["run_1"], ["run_2"]])
    }
}
