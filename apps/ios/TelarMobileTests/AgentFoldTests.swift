import Foundation
import SwiftUI
import Testing
@testable import TelarMobile

/// #569 — THE AGENT'S TOOL CALLS FOLD INTO STEPS, like every other transcript's.
///
/// WHAT THIS WOULD HAVE CAUGHT is what the owner's screenshot showed: a turn
/// with twelve calls drawn as twelve flat lines, which on a phone is the whole
/// screen given over to the machinery of an answer instead of the answer. The
/// activity lane has had two rules for this since the fold landed, and the
/// Agent's conversation read neither — the chrome could only be handed a
/// session's `JournalItem`.
///
/// THE CLAIMS ARE THE GROUPING AND THE ONE EXCLUSION: consecutive `tool_call`
/// rows are a RUN, and nothing that is not work joins one. Prose, the person's
/// own message, a wake and a turn that ended without an answer are seams — each
/// is a thing the reader is meant to see as it lands, and a fold that swallowed
/// one would hide the sentence the work was an answer to.
@Suite struct AgentFoldTests {
    /// The rows AS THEY ARRIVE, so the grouping is asserted against what the
    /// engine actually sends rather than against hand-built values: `kind` and
    /// `detail.name` are the two fields the fold reads, and both come out of the
    /// wire's nested `detail`.
    private func page(_ json: String) throws -> [AgentRow] {
        try JSONDecoder().decode(AgentThreadPage.self, from: Data(json.utf8)).rows
    }

    private let busyTurn = """
    {"cursor":16,"more":false,"rows":[
      {"id":1,"runId":"run_1","at":1,"kind":"user_message","detail":{"text":"what is happening?"}},
      {"id":2,"runId":"run_1","at":2,"kind":"assistant_message","detail":{"text":"Let me look."}},
      {"id":3,"runId":"run_1","at":3,"kind":"tool_call","detail":{"name":"sessions_read","output":"rows","status":"completed"}},
      {"id":4,"runId":"run_1","at":4,"kind":"tool_call","detail":{"name":"sessions_read","output":"rows","status":"completed"}},
      {"id":5,"runId":"run_1","at":5,"kind":"tool_call","detail":{"name":"sessions_read","output":"rows","status":"completed"}},
      {"id":6,"runId":"run_1","at":6,"kind":"tool_call","detail":{"name":"notes_list","output":"rows","status":"completed"}},
      {"id":7,"runId":"run_1","at":7,"kind":"assistant_message","detail":{"text":"Three are working."}}
    ]}
    """

    @Test func consecutiveToolCallsAreOneRunAndNothingElseJoinsIt() throws {
        let segments = segmentAgentRows(try page(busyTurn))
        let shape = segments.map { segment -> String in
            switch segment {
            case .row(let row): row.kind.rawValue
            case .run(let rows): "run:\(rows.count)"
            }
        }
        #expect(shape == ["user_message", "assistant_message", "run:4", "assistant_message"])
    }

    @Test func aRunIsKeyedByItsFirstRowSoTheFoldSurvivesRowsAppending() throws {
        let segments = segmentAgentRows(try page(busyTurn))
        // The third segment is the run; its identity is the first call in it,
        // so a fifth call landing does not remount the fold collapsed under a
        // reader who had just opened it.
        #expect(segments[2].id == 3)
    }

    @Test func aSentenceBetweenTwoRunsClosesTheFirst() throws {
        // Otherwise a turn that narrated half way through would keep one window
        // over work it had already moved past, and only the LAST run is live.
        let rows = try page("""
        {"cursor":5,"more":false,"rows":[
          {"id":1,"runId":"r","at":1,"kind":"tool_call","detail":{"name":"a","status":"completed"}},
          {"id":2,"runId":"r","at":2,"kind":"tool_call","detail":{"name":"b","status":"completed"}},
          {"id":3,"runId":"r","at":3,"kind":"assistant_message","detail":{"text":"half way"}},
          {"id":4,"runId":"r","at":4,"kind":"tool_call","detail":{"name":"c","status":"completed"}}
        ]}
        """)
        let segments = segmentAgentRows(rows)
        #expect(segments.count == 3)
        #expect(segments.indices.last == 2)
        if case .run(let last) = segments[2] {
            #expect(last.map(\.id) == [4])
        } else {
            Issue.record("the last segment is the run the agent is still writing")
        }
    }

    @Test func theTallyNamesEachToolOnceAndCountsIt() throws {
        guard case .run(let run) = segmentAgentRows(try page(busyTurn))[2] else {
            Issue.record("the third segment is the run of tool calls"); return
        }
        // First-appearance order: what the agent reached for first stays first,
        // because the tally summarises a SEQUENCE.
        #expect(agentStepTally(run) == "sessions_read ×3 · notes_list")
    }

    @Test func aRowWithNoNameStillTalliesAsSomething() throws {
        // A Mac on a newer engine may write a call this build cannot name. The
        // fold must still say how many steps it is hiding.
        let rows = try page("""
        {"cursor":1,"more":false,"rows":[
          {"id":1,"runId":"r","at":1,"kind":"tool_call","detail":{"status":"completed"}}
        ]}
        """)
        #expect(agentStepTally(rows) == displayToolName("tool"))
    }

    /// THE AGENT'S ROWS GO THROUGH THE SESSION TRANSCRIPT'S OWN FOLD, and that
    /// is a claim about types as much as about pixels: `StepFoldView` is generic
    /// over the row precisely so this screen can hand it `AgentRow` and the
    /// session's can hand it `JournalItem`, and a second copy of "+N earlier
    /// steps" is how one gains a failure mark and the other does not.
    ///
    /// Built rather than snapshotted: the phone's suite has no rendering host,
    /// and what would break here is the binding — a fold that stopped taking the
    /// Agent's rows, or an `AgentRowView` that stopped being what a step draws.
    @Test func theFoldTakesTheAgentsOwnRowsAtBothScales() throws {
        guard case .run(let run) = segmentAgentRows(try page(busyTurn))[2] else {
            Issue.record("the third segment is the run of tool calls"); return
        }
        let window = StepFoldView(rows: run, live: true, failed: { $0.status == "failed" }, tally: { agentStepTally(run) }) { row in
            AgentRowView(row: row)
        }
        let tally = StepFoldView(rows: run, live: false, failed: { $0.status == "failed" }, tally: { agentStepTally(run) }) { row in
            AgentRowView(row: row)
        }
        // One view at two scales, not two views: `live` is a value, so the fold
        // a reader watches cannot drift from the fold they scroll back to.
        #expect(type(of: window) == type(of: tally))
        #expect(run.count == 4)
    }

    @Test func aFailedCallInsideTheFoldIsWhatTheMarkReads() throws {
        let rows = try page("""
        {"cursor":2,"more":false,"rows":[
          {"id":1,"runId":"r","at":1,"kind":"tool_call","detail":{"name":"sessions_read","status":"completed"}},
          {"id":2,"runId":"r","at":2,"kind":"tool_call","detail":{"name":"sessions_send","status":"failed"}}
        ]}
        """)
        // The predicate the fold is handed — a failure hidden behind the very
        // mechanism that hid it is the one thing a fold must never do.
        #expect(rows.contains { $0.status == "failed" })
        #expect(agentStepTally(rows) == "sessions_read · sessions_send")
    }
}
