import Foundation
import Testing
@testable import TelarMobile

/// A turn another session sent is not a turn a person typed. These pin the
/// decoding of the fields that say so, and the fold carrying them through —
/// without both, the transcript draws a peer's report as the reader's own
/// words.
@Suite struct AgentTurnTests {
    private func decode(_ json: String) throws -> Turn {
        try JSONDecoder().decode(Turn.self, from: Data(json.utf8))
    }

    // MARK: decoding

    @Test func aTurnWithoutTheNewFieldsStillDecodes() throws {
        // An engine older than this build sends none of them, and the turn it
        // sends is exactly the turn this app already drew.
        let turn = try decode(#"{"runId":"r","sessionId":"s","sequence":0,"state":"completed","input":"hi","acceptedAt":1,"updatedAt":1}"#)
        #expect(turn.origin == nil)
        #expect(turn.sender == nil)
        #expect(turn.agentIntent == nil)
        #expect(turn.wakeReason == nil)
    }

    @Test func aPeersTaskCarriesItsSenderIntentAndScope() throws {
        let turn = try decode(#"""
        {"runId":"r","sessionId":"s","sequence":0,"state":"completed","input":"do the thing",
         "acceptedAt":1,"updatedAt":1,"origin":"session","sender":{"sessionId":"sess_abc123def456"},
         "agentIntent":"task","agentDelivery":"steer","assignmentScope":"apps/ios","agentSourceRunId":"run_x"}
        """#)
        #expect(turn.origin == "session")
        #expect(turn.sender?.sessionId == "sess_abc123def456")
        #expect(turn.agentIntent == "task")
        #expect(turn.agentDelivery == "steer")
        #expect(turn.assignmentScope == "apps/ios")
        #expect(turn.agentSourceRunId == "run_x")
    }

    @Test func aWakeCarriesItsReasonAndTheRunItIsAbout() throws {
        // THE LIVE SHAPE, copied from the journal: an OBJECT, with no `sender`
        // and no `agentIntent`. Declared as a `String?` this turn did not
        // merely render wrong — the snapshot decodes turns through
        // `Skippable`, so a type mismatch DROPPED it.
        let turn = try decode(#"""
        {"runId":"r","sessionId":"s","sequence":0,"state":"completed",
         "input":"[wake: completed] Session session_abc — turn run_def completed.",
         "acceptedAt":1,"updatedAt":1,"origin":"session",
         "wakeReason":{"kind":"turn_completed","sessionId":"session_abc","runId":"run_def"}}
        """#)
        #expect(turn.wakeReason?.kind == "turn_completed")
        #expect(turn.wakeReason?.sessionId == "session_abc")
        #expect(turn.wakeReason?.runId == "run_def")
        #expect(turn.sender == nil)
        #expect(turn.agentIntent == nil)
    }

    @Test func aRequestOpenedWakeCarriesTheRequestRatherThanARun() throws {
        let turn = try decode(#"""
        {"runId":"r","sessionId":"s","sequence":0,"state":"completed","input":"","acceptedAt":1,"updatedAt":1,
         "origin":"session","wakeReason":{"kind":"request_opened","sessionId":"session_abc","requestId":"req_1"}}
        """#)
        #expect(turn.wakeReason?.kind == "request_opened")
        #expect(turn.wakeReason?.requestId == "req_1")
        #expect(turn.wakeReason?.runId == nil)
    }

    @Test func anUnknownWakeKindIsKeptRatherThanDropped() {
        // A newer engine's vocabulary must still be a wake, or the turn goes
        // back to rendering as somebody's bubble.
        let reason = try? JSONDecoder().decode(WakeReason.self, from: Data(#"{"kind":"peer_settled","sessionId":"s"}"#.utf8))
        #expect(reason?.kind == "peer_settled")
    }

    @Test func aBareStringWakeReasonStillDecodes() {
        // An older engine, or a fixture written before the shape was
        // understood: losing the turn over it would be the same bug again.
        let reason = try? JSONDecoder().decode(WakeReason.self, from: Data("\"completed\"".utf8))
        #expect(reason?.kind == "completed")
        #expect(reason?.sessionId == nil)
    }

    @Test func aWakeRowSaysWhatHappenedWhenThePromptIsEmpty() {
        #expect(describeWake(WakeReason(kind: "turn_completed")) == "A turn finished in another session.")
        #expect(describeWake(WakeReason(kind: "turn_failed")) == "A turn failed in another session.")
        #expect(describeWake(WakeReason(kind: "turn_stopped")) == "A turn was stopped in another session.")
        #expect(describeWake(WakeReason(kind: "request_opened")) == "Another session is waiting on an answer.")
        #expect(describeWake(WakeReason(kind: "peer_settled")) == "Another session woke this one.")
        #expect(describeWake(nil) == "Another session woke this one.")
    }

    @Test func theEnginesOwnNoticeIsCarriedVerbatim() throws {
        let turn = try decode(#"""
        {"runId":"r","sessionId":"s","sequence":0,"state":"completed","input":"long body",
         "acceptedAt":1,"updatedAt":1,"origin":"session","agentIntent":"report","agentNotice":"Ported the rules."}
        """#)
        #expect(turn.agentNotice == "Ported the rules.")
    }

    // MARK: the sender label

    @Test func theLabelNamesTheLastSixOfTheSession() {
        // The full id is long and means nothing; six characters tell two peers
        // apart, which is all the label is for. (The desktop's rule, 1:1.)
        #expect(agentSenderLabel(MessageSender(sessionId: "sess_abc123def456")) == "agent · session …def456")
    }

    @Test func aSenderWithNoSessionSaysSo() {
        #expect(agentSenderLabel(nil) == "agent · outside any session")
        #expect(agentSenderLabel(MessageSender(sessionId: nil)) == "agent · outside any session")
        #expect(agentSenderLabel(MessageSender(sessionId: "")) == "agent · outside any session")
    }

    // MARK: the fold

    private func folded(_ json: String) -> JournalTurn? {
        guard let turn = try? decode(json) else { return nil }
        return projectJournal(turns: [turn], items: [], events: []).first
    }

    @Test func theFoldCarriesWhoSentTheTurn() throws {
        let turn = try #require(folded(#"""
        {"runId":"r","sessionId":"s","sequence":0,"state":"completed","input":"do it","acceptedAt":1,"updatedAt":1,
         "origin":"session","sender":{"sessionId":"sess_abc123def456"},"agentIntent":"task","assignmentScope":"apps/ios"}
        """#))
        #expect(turn.origin == "session")
        #expect(turn.sender?.sessionId == "sess_abc123def456")
        #expect(turn.assignmentScope == "apps/ios")
        #expect(turn.isFromAgent)
        #expect(turn.isAgentTask)
        #expect(!turn.isWake)
    }

    @Test func aPeersReportIsAnAgentMessageButNotATask() throws {
        let turn = try #require(folded(#"""
        {"runId":"r","sessionId":"s","sequence":0,"state":"completed","input":"done","acceptedAt":1,"updatedAt":1,
         "origin":"session","agentIntent":"report"}
        """#))
        #expect(turn.isFromAgent)
        // A peer TALKING stays collapsed; only a peer handing work over reads
        // as a message.
        #expect(!turn.isAgentTask)
    }

    @Test func aWakeIsNeitherABubbleNorAnAgentMessage() throws {
        let turn = try #require(folded(#"""
        {"runId":"r","sessionId":"s","sequence":0,"state":"completed","input":"[wake: completed] …",
         "acceptedAt":1,"updatedAt":1,"origin":"session",
         "wakeReason":{"kind":"turn_completed","sessionId":"session_abc","runId":"run_def"}}
        """#))
        #expect(turn.isWake)
        // Nobody said it, so it is not a message from anyone.
        #expect(!turn.isFromAgent)
        #expect(!turn.isAgentTask)
    }

    @Test func aPersonsTurnIsNoneOfThese() throws {
        let turn = try #require(folded(#"{"runId":"r","sessionId":"s","sequence":0,"state":"completed","input":"hello","acceptedAt":1,"updatedAt":1}"#))
        #expect(!turn.isFromAgent)
        #expect(!turn.isWake)
        #expect(!turn.isAgentTask)
    }

    @Test func aPersonSteeringIntoTheirOwnSessionIsNotAWake() throws {
        // `wakeReason` alone is not enough: the guard also asks who sent it.
        let turn = try #require(folded(#"""
        {"runId":"r","sessionId":"s","sequence":0,"state":"completed","input":"carry on","acceptedAt":1,"updatedAt":1,
         "origin":"user","wakeReason":{"kind":"turn_completed","sessionId":"session_abc"}}
        """#))
        #expect(!turn.isWake)
    }
}
