import Foundation
import Testing
@testable import TelarMobile

/// Port of the web's "a live turn folds as it works" suite.
@Suite struct ActivitySegmentsTests {
    private func row(_ id: String, _ type: String) -> JournalItem {
        JournalItem(item: makeItem(id, type: type), streamedText: "", openedBy: 0)
    }

    @Test func runsAreCutAtProseSteersPlansAndCompactions() {
        // THE BUG THIS PINS: one window over everything before the last
        // narration, then every tool call after it stacked flat until the
        // turn ended. Each run is its own group; only the last is live.
        let segments = segmentActivity([
            row("a", "command_execution"), row("b", "file_read"),
            row("c", "assistant_message"), row("d", "command_execution"),
            row("e", "user_message"), row("f", "plan"),
            row("g", "context_compaction"), row("h", "file_change"),
        ])
        let shape = segments.map { segment -> String in
            switch segment {
            case .row(let item): item.id
            case .run(let items): items.map(\.id).joined()
            }
        }
        #expect(shape == ["ab", "c", "d", "e", "f", "g", "h"])
    }

    @Test func reasoningAndSpawnsStayInsideTheirRun() {
        let segments = segmentActivity([row("a", "reasoning"), row("b", "task"), row("c", "command_execution")])
        #expect(segments.count == 1)
        if case .run(let items) = segments[0] { #expect(items.count == 3) } else { Issue.record("expected a run") }
    }

    @Test func emptyTimelineHasNoSegments() {
        #expect(segmentActivity([]).isEmpty)
    }
}

/// A TURN IS CUT INTO RESPONSES AT ITS MESSAGES — the web's
/// `splitAtMessageBoundaries` / `turnRenderOrder` suite, ported.
///
/// What it pins: a steer used to fold into "N steps" with every other item, so
/// the person's own words vanished from a settled turn and the work they asked
/// for was drawn above them.
@Suite struct MessageBoundaryTests {
    private func row(_ id: String, _ type: String) -> JournalItem {
        JournalItem(item: makeItem(id, type: type), streamedText: "", openedBy: 0)
    }

    private func shape(_ order: [TurnRenderEntry]) -> [String] {
        order.map { entry in
            switch entry {
            case .boundary(let item): item.id
            case .work(let items): items.map(\.id).joined()
            }
        }
    }

    @Test func aTurnSplitsAtEachMessageWithTheWorkThatFollowedIt() {
        let responses = splitAtMessageBoundaries([
            row("w1", "command_execution"),
            row("a1", "assistant_message"),
            row("m1", "user_message"),
            row("w2", "command_execution"),
            row("w3", "file_change"),
            row("m2", "user_message"),
            row("w4", "command_execution"),
        ])
        #expect(responses.map(\.boundary?.id) == [nil, "m1", "m2"])
        #expect(responses.map { $0.items.map(\.id).joined() } == ["w1a1", "w2w3", "w4"])
    }

    @Test func aTurnNobodySteeredIsOneResponse() {
        let responses = splitAtMessageBoundaries([row("w1", "command_execution"), row("a1", "assistant_message")])
        #expect(responses.count == 1)
        #expect(responses[0].boundary == nil)
    }

    @Test func aTurnWhoseFirstItemIsTheMessageHasNoEmptyOpeningResponse() {
        // A steer that lands before the provider has emitted anything would
        // otherwise draw an empty assistant lane above the message.
        let responses = splitAtMessageBoundaries([row("m1", "user_message"), row("w1", "command_execution")])
        #expect(responses.map(\.boundary?.id) == ["m1"])
        #expect(responses[0].items.map(\.id) == ["w1"])
    }

    @Test func twoSteersEachIntroduceTheirOwnWork() {
        // THE ORDER, not merely the grouping: the splitter can group correctly
        // while the view still draws each response's work above its boundary.
        let order = turnRenderOrder([
            row("A", "command_execution"),
            row("s1", "user_message"),
            row("B", "command_execution"),
            row("s2", "user_message"),
            row("C", "command_execution"),
        ])
        #expect(shape(order) == ["A", "s1", "B", "s2", "C"])
        // Said as the invariant rather than the example: work is never emitted
        // before the boundary that introduced it.
        for (index, entry) in order.enumerated() where index > 0 {
            guard case .work = entry else { continue }
            if case .work = order[index - 1] { Issue.record("two work entries in a row at \(index)") }
        }
    }

    @Test func consecutiveSteersEachKeepTheirOwnPlace() {
        // Two messages in a row produce an empty response between them. It
        // must collapse to nothing rather than to a stray empty lane, and must
        // not reorder the pair.
        let order = turnRenderOrder([
            row("s1", "user_message"),
            row("s2", "user_message"),
            row("A", "command_execution"),
        ])
        #expect(shape(order) == ["s1", "s2", "A"])
        #expect(!order.contains { if case .work(let items) = $0 { return items.isEmpty } else { return false } })
    }

    @Test func aTrailingSteerWithNoWorkAfterItIsStillEmitted() {
        // The person got the last word and the turn ended. The message must
        // not vanish for want of anything to introduce.
        #expect(shape(turnRenderOrder([row("A", "command_execution"), row("s1", "user_message")])) == ["A", "s1"])
    }

    @Test func liveAndSettledCutInTheSamePlace() {
        // The sequence is a pure function of the item list, so it cannot
        // depend on whether the turn is still running: a reload cannot move a
        // message. The live path renders the ANSWERING response's items, and
        // those carry no message row of their own.
        let items = [row("w1", "command_execution"), row("m1", "user_message"), row("w2", "command_execution"), row("a1", "assistant_message")]
        let responses = splitAtMessageBoundaries(items)
        #expect(responses.map(\.boundary?.id) == [nil, "m1"])
        let answering = responses[responses.count - 1]
        #expect(!answering.items.contains { if case .userMessage = $0.detail { return true } else { return false } })
        let segments = segmentActivity(answering.items).map { segment -> String in
            switch segment {
            case .row(let item): item.id
            case .run(let items): items.map(\.id).joined()
            }
        }
        #expect(segments == ["w2", "a1"])
    }

    @Test func noMessageIsRenderedTwice() {
        let items = [row("m1", "user_message"), row("w1", "command_execution"), row("m2", "user_message")]
        let responses = splitAtMessageBoundaries(items)
        let asItems = responses.flatMap { $0.items.map(\.id) }
        let asBoundaries = responses.compactMap(\.boundary?.id)
        #expect(asItems.filter { asBoundaries.contains($0) }.isEmpty)
        #expect((asBoundaries + asItems).sorted() == ["m1", "m2", "w1"])
    }

    // `turnRenderOrder` describes the sequence, and that the VIEW follows it
    // is still pinned — by `ios-transcript-order` in
    // scripts/source-invariants.mjs (#675). It was a test here, reading this
    // view's source through `#filePath`: the COMPILING machine's path, so it
    // passed on a simulator and threw on a device, and the device is where
    // the nightly job runs this suite. A claim about source text needs no app
    // process, and in verify.yml it now gates every pull request instead.
}

/// A SPAWN IS A ROW WHERE IT HAPPENED — the web's `renderable` and
/// `cutAroundLiveAgents`, ported. The phone dropped the spawn item and hung
/// every chip off the tail of the turn, so a fan-out from the first minute was
/// drawn under twenty minutes of later work.
@Suite struct SpawnRowTests {
    private func row(_ id: String, _ type: String) -> JournalItem {
        JournalItem(item: makeItem(id, type: type), streamedText: "", openedBy: 0)
    }

    private func spawn(_ id: String, _ taskId: String) -> JournalItem {
        let item = try! JSONDecoder().decode(Item.self, from: Data("""
        {"id":"\(id)","runId":"run_1","sessionId":"s","status":"completed",
         "detail":{"type":"task","taskId":"\(taskId)"},"startedAt":100}
        """.utf8))
        return JournalItem(item: item, streamedText: "", openedBy: 0)
    }

    private func task(_ id: String, state: String = "completed", kind: String = "agent", warp: Bool = false) -> JournalTask {
        let warpField = warp ? #","warp":{"warpRunId":"w1","warpName":"fan-out"}"# : ""
        let agent = try! JSONDecoder().decode(AgentTask.self, from: Data("""
        {"id":"\(id)","sessionId":"s","runId":"run_1","kind":"\(kind)","state":"\(state)",
         "startedAt":5,"updatedAt":5\(warpField)}
        """.utf8))
        return JournalTask(task: agent, items: [])
    }

    @Test func aSpawnIsARowInTheRunAtThePlaceItHappened() {
        let items = [row("a", "command_execution"), spawn("s1", "t1"), row("b", "file_read")]
        #expect(renderable(items, tasks: [task("t1")]).map(\.id) == ["a", "s1", "b"])
    }

    @Test func aBackgroundedShellIsNotADelegateButAWarpRunIs() {
        // The tool call that backgrounded the shell is already a row in this
        // same turn; the chip would be a second, worse telling of it.
        #expect(renderable([spawn("s1", "t1")], tasks: [task("t1", kind: "background")]).isEmpty)
        #expect(renderable([spawn("s1", "t1")], tasks: [task("t1", kind: "background", warp: true)]).map(\.id) == ["s1"])
    }

    @Test func aSpawnWhoseTaskIsMissingIsStillARow() {
        // Nothing else in the transcript says it happened.
        #expect(renderable([spawn("s1", "gone")], tasks: []).map(\.id) == ["s1"])
    }

    @Test func anEmptyReasoningBlockNeverCountsAsAStep() {
        // Counting a block the provider opened and never filled made the tally
        // a visible lie: "6 steps" above five rows.
        #expect(renderable([row("a", "reasoning"), row("b", "command_execution")]).map(\.id) == ["b"])
    }

    @Test func aSettledRunIsCutAroundItsStillLiveAgents() {
        // A running fleet hidden behind "12 steps" is invisible exactly when
        // the reader most wants to see it.
        let items = [row("a", "command_execution"), spawn("s1", "t1"), row("b", "file_read"), spawn("s2", "t2"), row("c", "command_execution")]
        let cuts = cutAroundLiveAgents(items, tasks: [task("t1", state: "running"), task("t2", state: "completed")])
        let shape = cuts.map { cut -> String in
            switch cut {
            case .agent(let item): "<\(item.id)>"
            case .run(let run): run.map(\.id).joined()
            }
        }
        #expect(shape == ["a", "<s1>", "bs2c"])
    }

    @Test func aRunWithNoLiveAgentIsOneCut() {
        let items = [row("a", "command_execution"), spawn("s1", "t1")]
        let cuts = cutAroundLiveAgents(items, tasks: [task("t1")])
        #expect(cuts.count == 1)
        if case .run(let run) = cuts[0] { #expect(run.map(\.id) == ["a", "s1"]) } else { Issue.record("expected a run") }
    }

    @Test func aTaskWithNoSpawnRowIsNotLost() {
        // The fold parks it at the end rather than dropping the chip.
        let items = [row("a", "command_execution"), spawn("s1", "t1")]
        let tasks = [task("t1"), task("t2"), task("t3", kind: "background")]
        #expect(spawnlessTasks(items, tasks: tasks).map(\.id) == ["t2"])
    }

    @Test func transcriptTasksKeepsAgentsAndWarpRunsOnly() {
        let kept = transcriptTasks([task("a"), task("b", kind: "background"), task("c", kind: "background", warp: true)])
        #expect(kept.map(\.id) == ["a", "c"])
    }
}
