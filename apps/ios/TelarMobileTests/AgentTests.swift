import Foundation
import Testing
@testable import TelarMobile

/// THE BUILT-IN AGENT ON THE PHONE (#531) — what decodes, which Macs get a row,
/// and how the transcript pages.
///
/// ── WHAT THIS REPLACES, AND WHY IT IS A DIFFERENT TEST ──────────────────────
/// `MainSessionTests` held a designation against a Mac's rows: the band drew a
/// row only if the designated conversation was among the sessions that Mac had
/// sent. Half of that suite was about the ways that could fail — a designation
/// whose session had been deleted, one whose session was on another Mac, one
/// that arrived before the rows did.
///
/// None of those failures exist here, and that is the point rather than a gap in
/// coverage: the Agent is not a session, so there is no id to resolve and no row
/// to be missing. What is left to hold is the decoding, the per-Mac gate, and
/// the paging — and the paging is the one with a real bug in it, because a poll
/// that races a write hands back rows the phone already holds.
@Suite struct AgentTests {
    private let hostA = HostID()
    private let hostB = HostID()

    // ── DECODING ─────────────────────────────────────────────────────────────

    @Test func liveListCarriesTheFlag() throws {
        let on = #"{"sessions":[],"projects":[],"agent":{"enabled":true}}"#
        #expect(try JSONDecoder().decode(LiveSessions.self, from: Data(on.utf8)).agent == AgentFlag(enabled: true))

        let off = #"{"sessions":[],"projects":[],"agent":{"enabled":false}}"#
        #expect(try JSONDecoder().decode(LiveSessions.self, from: Data(off.utf8)).agent == AgentFlag(enabled: false))
    }

    @Test func anAbsentFlagIsOffRatherThanAFailure() throws {
        // A Mac whose engine predates the feature sends nothing, and that means
        // off — not "cannot say", and certainly not a list that fails to decode.
        let none = #"{"sessions":[],"projects":[]}"#
        let live = try JSONDecoder().decode(LiveSessions.self, from: Data(none.utf8))
        #expect(live.agent == nil)

        // And a flag this build cannot read costs the entry, never the list.
        let strange = #"{"sessions":[],"projects":[],"agent":"yes"}"#
        let tolerant = try JSONDecoder().decode(LiveSessions.self, from: Data(strange.utf8))
        #expect(tolerant.agent == nil)
    }

    @Test func stateDecodesWithItsParkedApproval() throws {
        let json = """
        {"agent":{"enabled":true,"threadId":"thread_1","model":"kimi-k3","running":false,"queued":0,
         "request":{"type":"approval","id":"req_1","runId":"run_1","tool":"sessions_send",
                    "args":{"intent":"task"},"toolCallId":"call_1","reason":"This hands work to another session.","openedAt":7}},
         "credential":{"source":"setting","set":true}}
        """
        let answer = try JSONDecoder().decode(AgentAnswer.self, from: Data(json.utf8))
        #expect(answer.agent.enabled)
        #expect(answer.agent.threadId == "thread_1")
        #expect(answer.agent.request?.tool == "sessions_send")
        #expect(answer.agent.request?.reason == "This hands work to another session.")
        #expect(answer.credential?.source == "setting")
        #expect(answer.credential?.set == true)
    }

    @Test func aRequestThisBuildCannotReadCostsTheCardNotTheScreen() throws {
        let json = #"{"agent":{"enabled":true,"running":true,"runId":"run_1","queued":1,"request":42}}"#
        let answer = try JSONDecoder().decode(AgentAnswer.self, from: Data(json.utf8))
        #expect(answer.agent.enabled)
        #expect(answer.agent.running)
        #expect(answer.agent.request == nil)
    }

    @Test func rowsDecodeTheirDetail() throws {
        let json = """
        {"rows":[
          {"id":1,"threadId":"t","runId":"r","at":10,"kind":"user_message","detail":{"text":"hello","origin":"user"}},
          {"id":2,"threadId":"t","runId":"r","at":11,"kind":"tool_call",
           "detail":{"name":"sessions_list","input":{},"output":"rows","status":"completed"}},
          {"id":3,"threadId":"t","runId":"r","at":12,"kind":"assistant_message","detail":{"text":"done","itemId":"msg_1"}},
          {"id":4,"threadId":"t","runId":"r","at":13,"kind":"turn_done","detail":{"status":"completed","text":"done"}}
        ],"cursor":4,"more":false,"threadId":"t"}
        """
        let page = try JSONDecoder().decode(AgentThreadPage.self, from: Data(json.utf8))
        #expect(page.rows.count == 4)
        #expect(page.rows[0].text == "hello")
        #expect(page.rows[1].name == "sessions_list")
        #expect(page.rows[1].status == "completed")
        #expect(page.rows[2].text == "done")
        // THE ID THE LIVE DELTAS ARE KEYED BY. This phone polls rather than
        // streams, so nothing uses it yet — it is decoded because the row
        // carries it, and a reader that starts streaming should not have to
        // change the model to find it.
        #expect(page.rows[2].itemId == "msg_1")
        #expect(page.cursor == 4)
        #expect(!page.more)
    }

    @Test func aCompletedTurnDoneDuplicatesTheFinalMessageOnPurpose() throws {
        // The engine sends BOTH: one `assistant_message` per finished segment,
        // and `turn_done.detail.text` carrying the final one again for a reader
        // that wants one answer per turn without folding the log. This screen
        // folds the log — `AgentView.drawn` drops the completed `turn_done`, or
        // every turn would print its closing sentence twice. What is asserted
        // here is that both really do arrive, so that rule has something to be
        // about.
        let json = """
        {"rows":[
          {"id":1,"threadId":"t","runId":"r","at":10,"kind":"assistant_message","detail":{"text":"done","itemId":"msg_1"}},
          {"id":2,"threadId":"t","runId":"r","at":11,"kind":"turn_done","detail":{"status":"completed","text":"done"}}
        ],"cursor":2,"more":false}
        """
        let page = try JSONDecoder().decode(AgentThreadPage.self, from: Data(json.utf8))
        #expect(page.rows.map(\.kind) == [.assistantMessage, .turnDone])
        #expect(page.rows[0].text == page.rows[1].text)
    }

    @Test func aRowKindThisBuildHasNeverHeardOfIsSkippedNotFatal() throws {
        // A Mac on a newer engine must not be able to blank this screen by
        // adding a row kind — the row is dropped and the page still arrives.
        let json = """
        {"rows":[
          {"id":1,"threadId":"t","runId":"r","at":10,"kind":"something_new","detail":{}},
          {"id":2,"threadId":"t","runId":"r","at":11,"kind":"user_message","detail":{"text":"hello"}}
        ],"cursor":2,"more":false}
        """
        let page = try JSONDecoder().decode(AgentThreadPage.self, from: Data(json.utf8))
        #expect(page.rows.map(\.id) == [2])
    }

    @Test func aWakeIsLabelledRatherThanAttributedToTheReader() {
        // A turn with no human behind it must say so: the Agent subscribes to
        // what it delegates, and drawing that notice as an ordinary user message
        // would attribute somebody else's machine to the person reading.
        #expect(AgentRow(id: 1, kind: .userMessage, text: "hi").wakeLabel == nil)
        #expect(AgentRow(id: 1, kind: .userMessage, text: "hi", origin: "user").wakeLabel == nil)
        #expect(AgentRow(id: 1, kind: .userMessage, origin: "wake").wakeLabel == "Woken by Telar")
        #expect(AgentRow(id: 1, kind: .userMessage, origin: "wake", wakeReason: "turn_completed").wakeLabel == "Woken — turn_completed")
    }

    // ── ONE ROW PER MAC ──────────────────────────────────────────────────────

    @Test func noRowUntilAMacSaysOtherwise() {
        // Nothing paired, and a Mac that has answered "off" — both draw the
        // sidebar this phone always drew.
        #expect(agentRows([], filter: nil).isEmpty)
        #expect(agentRows([(hostA, false)], filter: nil).isEmpty)
    }

    @Test func oneRowForEachMacThatHasOne() {
        #expect(agentRows([(hostA, true)], filter: nil).map(\.hostId) == [hostA])
        // TWO MACS, TWO ROWS. Each machine has its own Agent, so a phone paired
        // with both is owed both — this is where the band differs most from the
        // desktop rail, which shows only the Mac you are looking at.
        #expect(agentRows([(hostA, true), (hostB, true)], filter: nil).map(\.hostId) == [hostA, hostB])
        // And a Mac with it switched off contributes nothing beside one that has.
        #expect(agentRows([(hostA, false), (hostB, true)], filter: nil).map(\.hostId) == [hostB])
    }

    @Test func theMacFilterNarrowsTheBandToo() {
        // Filtering the sidebar to one Mac must not leave another Mac's Agent
        // pinned above a list it is not part of.
        let both: [(hostId: HostID, enabled: Bool)] = [(hostA, true), (hostB, true)]
        #expect(agentRows(both, filter: hostA).map(\.hostId) == [hostA])
        #expect(agentRows(both, filter: hostB).map(\.hostId) == [hostB])
    }

    @Test func rowsKeepTheMacsOwnOrder() {
        // A band that re-sorted itself as conversations were touched would move
        // under the thumb.
        #expect(agentRows([(hostB, true), (hostA, true)], filter: nil).map(\.hostId) == [hostB, hostA])
    }

    // ── PAGING ───────────────────────────────────────────────────────────────

    @Test func pollingOverlapIsAbsorbedRatherThanAppended() {
        // THE BUG THIS PREVENTS. The phone follows the thread by asking again
        // from the cursor it holds, and a poll that raced a write hands back a
        // row it already has. Appending would duplicate it on screen.
        let held = [AgentRow(id: 1, kind: .userMessage, text: "hello"), AgentRow(id: 2, kind: .turnStarted)]
        let again = [AgentRow(id: 2, kind: .turnStarted), AgentRow(id: 3, kind: .assistantMessage, text: "hi", itemId: "msg_1")]
        #expect(mergeAgentRows(held, again).map(\.id) == [1, 2, 3])
    }

    @Test func rowsOrderByIdAndNotByTime() {
        // Ids are monotonic within a thread; timestamps are not guaranteed to
        // be. Two rows written in the same millisecond must not swap places
        // between polls.
        let same = [AgentRow(id: 7, at: 5_000, kind: .toolCall), AgentRow(id: 6, at: 5_000, kind: .userMessage)]
        #expect(mergeAgentRows([], same).map(\.id) == [6, 7])
    }

    @Test func anEmptyPageKeepsWhatIsHeld() {
        let held = [AgentRow(id: 1, kind: .userMessage, text: "hello")]
        #expect(mergeAgentRows(held, []).map(\.id) == [1])
    }

    @Test func aLaterPageReplacesARowRatherThanAddingASecond() {
        // The same id arriving twice is one row, not two — whichever answer
        // came last is the one the Mac stands behind.
        let first = [AgentRow(id: 1, kind: .assistantMessage, text: "draft", itemId: "msg_1")]
        let second = [AgentRow(id: 1, kind: .assistantMessage, text: "final", itemId: "msg_1")]
        let merged = mergeAgentRows(first, second)
        #expect(merged.count == 1)
        #expect(merged[0].text == "final")
    }
}

/// THE CONTEXT METER (#539) — the line under the Agent's header.
///
/// The Agent reported no context at all, and a coordinator whose history is
/// quietly being trimmed is one a person cannot reason about. What must not
/// drift:
///
///   - a Mac that reports no tokens draws a context percentage and NOT a zero
///     token count, because "nobody said" and "that turn was free" are
///     different facts;
///   - the percentage is of the Mac's TRIM budget, the ceiling that will
///     actually drop the oldest exchange;
///   - a prompt over budget reads full rather than overflowing;
///   - a Mac too old to send any of it costs the line, never the screen.
@Suite struct AgentContextMeterTests {
    @Test func bothNumbersRideTheState() throws {
        let json = #"""
        {"agent":{"enabled":true,"running":false,"queued":0,
         "lastUsage":{"runId":"run_a","at":1700,"usage":{"input":2600,"output":90,"total":2690},
                      "contextChars":30000,"budgetChars":120000}}}
        """#
        let answer = try JSONDecoder().decode(AgentAnswer.self, from: Data(json.utf8))
        let meter = try #require(answer.agent.lastUsage)
        #expect(meter.runId == "run_a")
        #expect(meter.usage == AgentUsage(input: 2600, output: 90, total: 2690))
        #expect(meter.percent == 25)
        #expect(meter.meterLine == "2,690 tokens · 25% context")
    }

    @Test func aMacThatReportedNoTokensKeepsTheContextHalf() throws {
        let json = #"""
        {"agent":{"enabled":true,"running":false,"queued":0,
         "lastUsage":{"runId":"run_b","contextChars":12000,"budgetChars":120000}}}
        """#
        let meter = try #require(try JSONDecoder().decode(AgentAnswer.self, from: Data(json.utf8)).agent.lastUsage)
        #expect(meter.usage == nil)
        // NOT "0 tokens": that would assert the turn was free.
        #expect(meter.meterLine == "10% context")
    }

    @Test func aPromptOverBudgetReadsFullRatherThanOverflowing() {
        // The Mac's trim keeps the newest exchange whatever it costs, so this
        // really happens.
        let over = AgentLastUsage(runId: "run_c", contextChars: 400_000, budgetChars: 120_000)
        #expect(over.percent == 100)
        #expect(over.meterLine == "100% context")
    }

    @Test func noCeilingMeansNoLineRatherThanADivisionByNothing() {
        let none = AgentLastUsage(runId: "run_d", contextChars: 10, budgetChars: 0)
        #expect(none.percent == 0)
        #expect(none.meterLine == nil)
    }

    @Test func aMacTooOldToSendAMeterCostsTheLineAndNotTheScreen() throws {
        // Every engine before #539 sends no `lastUsage` at all, and one sending
        // a shape this build cannot read is the same case.
        let absent = #"{"agent":{"enabled":true,"running":false,"queued":0}}"#
        #expect(try JSONDecoder().decode(AgentAnswer.self, from: Data(absent.utf8)).agent.lastUsage == nil)

        let strange = #"{"agent":{"enabled":true,"running":false,"queued":0,"lastUsage":"soon"}}"#
        let tolerant = try JSONDecoder().decode(AgentAnswer.self, from: Data(strange.utf8))
        #expect(tolerant.agent.lastUsage == nil)
        // The screen is still perfectly usable.
        #expect(tolerant.agent.enabled)
    }
}
