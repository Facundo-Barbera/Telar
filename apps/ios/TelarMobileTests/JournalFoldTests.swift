import Foundation
import Testing
@testable import TelarMobile

// Builders — decode from JSON rather than hand-constructing, so the tests
// exercise the same decode path production data takes.

func makeTurn(_ runId: String, state: String = "running", input: String = "hello", sequence: Int = 0) -> Turn {
    try! JSONDecoder().decode(Turn.self, from: Data("""
    {"runId":"\(runId)","sessionId":"s","sequence":\(sequence),"state":"\(state)",
     "input":"\(input)","acceptedAt":100,"updatedAt":100}
    """.utf8))
}

func makeItem(_ id: String, runId: String = "run_1", type: String = "assistant_message",
              text: String = "", status: String = "inProgress",
              startedAt: Int = 100, taskId: String? = nil) -> Item {
    let taskField = taskId.map { ",\"taskId\":\"\($0)\"" } ?? ""
    return try! JSONDecoder().decode(Item.self, from: Data("""
    {"id":"\(id)","runId":"\(runId)","sessionId":"s","status":"\(status)",
     "detail":{"type":"\(type)","text":"\(text)"},"startedAt":\(startedAt)\(taskField)}
    """.utf8))
}

func makeEvent(_ json: String) -> EngineEvent {
    try! JSONDecoder().decode(EngineEvent.self, from: Data(json.utf8))
}

@Suite struct JournalFoldTests {
    @Test func itemsSortByOpeningEventIdNeverTimestamp() {
        // Item B opened LATER (higher event id) but carries an EARLIER
        // startedAt — id must win.
        let events = [
            makeEvent(#"{"id":10,"at":999,"sessionId":"s","runId":"run_1","type":"item.started","item":{"id":"item_a","runId":"run_1","sessionId":"s","status":"completed","detail":{"type":"assistant_message","text":"first"},"startedAt":500}}"#),
            makeEvent(#"{"id":20,"at":999,"sessionId":"s","runId":"run_1","type":"item.started","item":{"id":"item_b","runId":"run_1","sessionId":"s","status":"completed","detail":{"type":"assistant_message","text":"second"},"startedAt":1}}"#),
        ]
        let turns = projectJournal(turns: [makeTurn("run_1")], items: [], events: events)
        #expect(turns[0].items.map(\.id) == ["item_a", "item_b"])
    }

    @Test func snapshotItemsSortBeforeTailItems() {
        // openedBy 0 for snapshot rows — they precede anything the tail opens.
        let snapshotItem = makeItem("item_old", startedAt: 900)
        let events = [
            makeEvent(#"{"id":5,"at":10,"sessionId":"s","runId":"run_1","type":"item.started","item":{"id":"item_new","runId":"run_1","sessionId":"s","status":"inProgress","detail":{"type":"assistant_message","text":""},"startedAt":1}}"#),
        ]
        let turns = projectJournal(turns: [makeTurn("run_1")], items: [snapshotItem], events: events)
        #expect(turns[0].items.map(\.id) == ["item_old", "item_new"])
    }

    @Test func deltasAccumulateInOrderAndSurviveItemUpdated() {
        let events = [
            makeEvent(#"{"id":1,"at":10,"sessionId":"s","runId":"run_1","type":"item.started","item":{"id":"item_a","runId":"run_1","sessionId":"s","status":"inProgress","detail":{"type":"assistant_message","text":""},"startedAt":10}}"#),
            makeEvent(#"{"id":2,"at":11,"sessionId":"s","runId":"run_1","type":"content.delta","itemId":"item_a","stream":"assistant_text","text":"Hel"}"#),
            makeEvent(#"{"id":3,"at":12,"sessionId":"s","runId":"run_1","type":"content.delta","itemId":"item_a","stream":"assistant_text","text":"lo"}"#),
            // A whole-item update must not wipe accumulated streamed text.
            makeEvent(#"{"id":4,"at":13,"sessionId":"s","runId":"run_1","type":"item.updated","item":{"id":"item_a","runId":"run_1","sessionId":"s","status":"inProgress","detail":{"type":"assistant_message","text":""},"startedAt":10}}"#),
        ]
        let turns = projectJournal(turns: [makeTurn("run_1")], items: [], events: events)
        #expect(turns[0].items[0].streamedText == "Hello")
        #expect(turns[0].items[0].text == "Hello")
    }

    @Test func itemUpdatedIsIdempotent() {
        let update = #"{"id":7,"at":10,"sessionId":"s","runId":"run_1","type":"item.updated","item":{"id":"item_a","runId":"run_1","sessionId":"s","status":"completed","detail":{"type":"assistant_message","text":"done"},"startedAt":10}}"#
        let once = projectJournal(turns: [makeTurn("run_1")], items: [], events: [makeEvent(update)])
        let twice = projectJournal(turns: [makeTurn("run_1")], items: [], events: [makeEvent(update), makeEvent(update)])
        #expect(once == twice)
    }

    @Test func deltaForUnseenItemIsDroppedNotBuffered() {
        let events = [
            makeEvent(#"{"id":1,"at":10,"sessionId":"s","runId":"run_1","type":"content.delta","itemId":"item_ghost","stream":"assistant_text","text":"lost"}"#),
        ]
        let turns = projectJournal(turns: [makeTurn("run_1")], items: [], events: events)
        #expect(turns[0].items.isEmpty)
    }

    @Test func itemWithUnseenTaskStaysOnMainTimelineThenNests() {
        // Item names a task the fold has not met → main timeline (an invisible
        // row is worse than a misplaced one).
        let orphan = [
            makeEvent(#"{"id":1,"at":10,"sessionId":"s","runId":"run_1","type":"item.started","item":{"id":"item_a","runId":"run_1","sessionId":"s","status":"inProgress","detail":{"type":"command_execution","command":{"command":"ls"}},"startedAt":10,"taskId":"task_1"}}"#),
        ]
        let before = projectJournal(turns: [makeTurn("run_1")], items: [], events: orphan)
        #expect(before[0].items.count == 1)
        #expect(before[0].tasks.isEmpty)

        // Once the task exists and the item is seen again, it moves home.
        let after = projectJournal(turns: [makeTurn("run_1")], items: [], events: orphan + [
            makeEvent(#"{"id":2,"at":11,"sessionId":"s","runId":"run_1","type":"task.started","task":{"id":"task_1","sessionId":"s","runId":"run_1","kind":"agent","state":"running","startedAt":11,"updatedAt":11}}"#),
            makeEvent(#"{"id":3,"at":12,"sessionId":"s","runId":"run_1","type":"item.updated","item":{"id":"item_a","runId":"run_1","sessionId":"s","status":"inProgress","detail":{"type":"command_execution","command":{"command":"ls"}},"startedAt":10,"taskId":"task_1"}}"#),
        ])
        #expect(after[0].items.isEmpty)
        #expect(after[0].tasks.first?.items.map(\.id) == ["item_a"])
    }

    @Test func snapshotTasksAreSeededBeforeItems() {
        let task = try! JSONDecoder().decode(AgentTask.self, from: Data(#"{"id":"task_1","sessionId":"s","runId":"run_1","kind":"agent","state":"running","startedAt":5,"updatedAt":5}"#.utf8))
        let item = makeItem("item_sub", taskId: "task_1")
        let turns = projectJournal(turns: [makeTurn("run_1")], items: [item], events: [], tasks: [task])
        #expect(turns[0].items.isEmpty)
        #expect(turns[0].tasks.first?.items.map(\.id) == ["item_sub"])
    }

    @Test func taskEventsPreserveCollectedItems() {
        // Every task event repeats the whole task; a replace would empty the
        // item list each time one arrives.
        let events = [
            makeEvent(#"{"id":1,"at":10,"sessionId":"s","runId":"run_1","type":"task.started","task":{"id":"task_1","sessionId":"s","runId":"run_1","kind":"agent","state":"running","startedAt":10,"updatedAt":10}}"#),
            makeEvent(#"{"id":2,"at":11,"sessionId":"s","runId":"run_1","type":"item.started","item":{"id":"item_sub","runId":"run_1","sessionId":"s","status":"inProgress","detail":{"type":"reasoning","text":"hm"},"startedAt":11,"taskId":"task_1"}}"#),
            makeEvent(#"{"id":3,"at":12,"sessionId":"s","runId":"run_1","type":"task.progress","task":{"id":"task_1","sessionId":"s","runId":"run_1","kind":"agent","state":"running","startedAt":10,"updatedAt":12}}"#),
        ]
        let turns = projectJournal(turns: [makeTurn("run_1")], items: [], events: events)
        #expect(turns[0].tasks.first?.items.count == 1)
        #expect(turns[0].tasks.first?.task.updatedAt == 12)
    }

    @Test func turnAcceptedInsertsUnknownTurn() {
        let events = [
            makeEvent(#"{"id":1,"at":10,"sessionId":"s","runId":"run_new","type":"turn.accepted","replayed":false,"turn":{"runId":"run_new","sessionId":"s","sequence":1,"state":"queued","input":"fresh","acceptedAt":10,"updatedAt":10}}"#),
        ]
        let turns = projectJournal(turns: [], items: [], events: events)
        #expect(turns.count == 1)
        #expect(turns[0].prompt == "fresh")
        #expect(turns[0].state == .queued)
    }

    @Test func stateTransitionsRideTheTypeString() {
        let base = [
            makeEvent(#"{"id":1,"at":10,"sessionId":"s","runId":"run_1","type":"turn.claimed","workerId":"w"}"#),
            makeEvent(#"{"id":2,"at":11,"sessionId":"s","runId":"run_1","type":"turn.started"}"#),
        ]
        var turns = projectJournal(turns: [makeTurn("run_1", state: "queued")], items: [], events: base)
        #expect(turns[0].state == .running)
        #expect(turns[0].startedAt == 11)

        turns = projectJournal(turns: [makeTurn("run_1", state: "queued")], items: [], events: base + [
            makeEvent(#"{"id":3,"at":12,"sessionId":"s","runId":"run_1","type":"turn.completed","resultText":"done"}"#),
        ])
        #expect(turns[0].state == .completed)
        #expect(turns[0].resultText == "done")
    }

    @Test func lastActivityMovesOnDeltas() {
        let events = [
            makeEvent(#"{"id":1,"at":10,"sessionId":"s","runId":"run_1","type":"item.started","item":{"id":"item_a","runId":"run_1","sessionId":"s","status":"inProgress","detail":{"type":"assistant_message","text":""},"startedAt":10}}"#),
            makeEvent(#"{"id":2,"at":500,"sessionId":"s","runId":"run_1","type":"content.delta","itemId":"item_a","stream":"assistant_text","text":"x"}"#),
        ]
        let turns = projectJournal(turns: [makeTurn("run_1")], items: [], events: events)
        // Item timestamps did not move; the delta's `at` is the activity.
        #expect(turns[0].lastActivityAt == 500)
    }

    @Test func compactionDetection() {
        let open = makeEvent(#"{"id":1,"at":10,"sessionId":"s","runId":"run_1","type":"item.started","item":{"id":"item_c","runId":"run_1","sessionId":"s","status":"inProgress","detail":{"type":"context_compaction","reason":"auto"},"startedAt":10}}"#)
        let close = makeEvent(#"{"id":2,"at":11,"sessionId":"s","runId":"run_1","type":"item.completed","item":{"id":"item_c","runId":"run_1","sessionId":"s","status":"completed","detail":{"type":"context_compaction","reason":"auto"},"startedAt":10,"completedAt":11}}"#)
        #expect(projectJournal(turns: [makeTurn("run_1")], items: [], events: [open])[0].isCompacting)
        #expect(!projectJournal(turns: [makeTurn("run_1")], items: [], events: [open, close])[0].isCompacting)
    }

    @Test func appendJournalEventsDedupesAndSorts() {
        let a = makeEvent(#"{"id":3,"at":1,"sessionId":"s","type":"turn.started"}"#)
        let b = makeEvent(#"{"id":1,"at":1,"sessionId":"s","type":"turn.started"}"#)
        let merged = appendJournalEvents([a], [b, a])
        #expect(merged.map(\.id) == [1, 3])
        #expect(journalCursor(merged) == 3)
    }

    @Test func displayToolNameStripsAddressing() {
        #expect(displayToolName("mcp__telar__browser_click") == "browser_click")
        // The rest-join: a tool name may itself contain `__`.
        #expect(displayToolName("mcp__github__fetch__pr") == "fetch__pr")
        #expect(displayToolName("Bash") == "Bash")
        #expect(displayToolName("mcp__") == "mcp__")
    }

    @Test func foldRunsOverRealFixtures() throws {
        let snapshot = try JSONDecoder().decode(SessionSnapshot.self, from: fixture("snapshot"))
        let page = try JSONDecoder().decode(EventPage.self, from: fixture("events-page"))
        let turns = projectJournal(
            turns: snapshot.turns, items: snapshot.items,
            events: page.events, tasks: snapshot.tasks
        )
        #expect(!turns.isEmpty)
        // The captured session streamed text — the fold must have carried it.
        let streamed = turns.flatMap(\.items).contains { !$0.streamedText.isEmpty || !$0.text.isEmpty }
        #expect(streamed)
    }
}

@Suite struct StreamingPrefixTests {
    @Test func remountedPrefixSkipsOverlapAndKeepsTheNextDelta() throws {
        let snapshot = try JSONDecoder().decode(SessionSnapshot.self, from: fixture("engine-revision"))
        let item = snapshot.items[0]
        let through = item.streamedThrough!
        let overlap = makeEvent("""
        {"id":\(through),"at":1000,"sessionId":"session_fixture","runId":"run_fixture","type":"content.delta","itemId":"item_fixture","stream":"assistant_text","text":"lo"}
        """)
        let next = makeEvent("""
        {"id":\(snapshot.cursor! + 1),"at":1001,"sessionId":"session_fixture","runId":"run_fixture","type":"content.delta","itemId":"item_fixture","stream":"assistant_text","text":" world"}
        """)
        let result = projectJournal(turns: snapshot.turns, items: snapshot.items, events: [overlap, next])
        #expect(result[0].items[0].text == "Hello world")
    }

    /// #912: the engine opens a `background_task` turn so a sub-agent that
    /// outlived its turn can have a call decided. It is not a transcript row —
    /// two person's turns with a claim between them draw two rows, not three.
    @Test func aBackgroundClaimIsNotATranscriptRow() throws {
        let claim = try JSONDecoder().decode(Turn.self, from: Data("""
        {"runId":"run_claim","sessionId":"s","sequence":2,"state":"completed","input":"",
         "origin":"provider","providerReason":{"kind":"background_task","taskId":"task_toolu_agent"},
         "acceptedAt":100,"updatedAt":100}
        """.utf8))
        let turns = projectJournal(
            turns: [makeTurn("run_ask", state: "completed", sequence: 1), claim, makeTurn("run_next", state: "completed", sequence: 3)],
            items: [],
            events: []
        )
        #expect(turns.map(\.runId) == ["run_ask", "run_claim", "run_next"])
        #expect(turns[1].isBackgroundClaim)
        #expect(transcriptTurns(turns).map(\.runId) == ["run_ask", "run_next"])
    }
}
