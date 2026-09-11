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
        let turn = try decode(#"""
        {"runId":"r","sessionId":"s","sequence":0,"state":"completed","input":"[wake: completed] …",
         "acceptedAt":1,"updatedAt":1,"origin":"session","wakeReason":"completed","agentSourceRunId":"run_y"}
        """#)
        #expect(turn.wakeReason == "completed")
        #expect(turn.agentSourceRunId == "run_y")
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
         "acceptedAt":1,"updatedAt":1,"origin":"session","wakeReason":"completed"}
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
         "origin":"user","wakeReason":"completed"}
        """#))
        #expect(!turn.isWake)
    }
}
