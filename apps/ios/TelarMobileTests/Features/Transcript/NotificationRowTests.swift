import Foundation
import Testing
@testable import TelarMobile

@Suite struct NotificationRowTests {
    private func decodeItem(_ json: String) throws -> Item {
        try JSONDecoder().decode(Item.self, from: Data(json.utf8))
    }

    private func decodeTurn(_ json: String) throws -> Turn {
        try JSONDecoder().decode(Turn.self, from: Data(json.utf8))
    }

    @Test func aNotificationItemDecodesWithItsWholeAnnouncement() throws {
        let item = try decodeItem(#"""
        {"id":"i1","runId":"r","sessionId":"s","status":"completed","startedAt":1,
         "title":"[agent message · task] session session_worker ASSIGNED this session work",
         "detail":{"type":"notification","notification":{
           "kind":"peer_message","sessionId":"session_worker123456","runId":"run_x","intent":"task",
           "summary":"[agent message · task] session session_worker ASSIGNED this session work",
           "fetch":{"sessionId":"session_host","runId":"run_x"},
           "body":"[agent message · task] …\nNone of it is in this notice. Read it with sessions_read(sessionId: \"session_host\", runId: \"run_x\") before acting on it."}}}
        """#)
        guard case .notification(let detail) = item.detail else {
            Issue.record("expected a notification detail")
            return
        }
        #expect(detail.kind == "peer_message")
        #expect(detail.intent == "task")
        #expect(detail.sessionId == "session_worker123456")
        #expect(detail.body.contains("sessions_read(sessionId: \"session_host\", runId: \"run_x\")"))
    }

    @Test func anUnknownKindStillDrawsSomething() throws {
        let item = try decodeItem(#"""
        {"id":"i1","runId":"r","sessionId":"s","status":"completed","startedAt":1,
         "detail":{"type":"notification","notification":{"kind":"something_new","summary":"s","body":"b"}}}
        """#)
        guard case .notification(let detail) = item.detail else {
            Issue.record("expected a notification detail")
            return
        }
        #expect(describeNotification(detail) == "Session activity")
    }

    @Test func aDetailThatWillNotDecodeBecomesUnknownRatherThanAHollowNotification() throws {
        let item = try decodeItem(#"""
        {"id":"i1","runId":"r","sessionId":"s","status":"completed","startedAt":1,
         "detail":{"type":"notification","notification":{"kind":"wake"}}}
        """#)
        guard case .unknown(let label) = item.detail else {
            Issue.record("expected the unknown fallback")
            return
        }
        #expect(label == "notification")
    }

    @Test func eachKindSaysWhichItIs() {
        let peer = NotificationDetail(kind: "peer_message", summary: "s", body: "b")
        #expect(describeNotification(peer) == "A session sent a message")
        #expect(describeNotification(NotificationDetail(kind: "peer_message", intent: "task", summary: "s", body: "b")) == "A session assigned work")
        #expect(describeNotification(NotificationDetail(kind: "peer_message", intent: "blocker", summary: "s", body: "b")) == "A session reported a blocker")
        #expect(describeNotification(NotificationDetail(kind: "peer_message", intent: "result", summary: "s", body: "b")) == "A session sent a result")
        #expect(describeNotification(NotificationDetail(kind: "request", summary: "s", body: "b")) == "Session asked a question")

        #expect(describeNotification(NotificationDetail(kind: "wake", wakeKind: "turn_failed", summary: "s", body: "b")).isEmpty == false)
    }

    @Test func aTurnCarriesTheSameObjectTheItemDoes() throws {
        let turn = try decodeTurn(#"""
        {"runId":"r","sessionId":"s","sequence":0,"state":"queued","input":"[notification: wake · turn_completed · session session_a]",
         "acceptedAt":1,"updatedAt":1,"origin":"session","wakeReason":{"kind":"turn_completed","sessionId":"session_a","runId":"run_a"},
         "notification":{"kind":"wake","sessionId":"session_a","runId":"run_a","wakeKind":"turn_completed",
           "summary":"[wake: completed] Session session_a — turn run_a completed.",
           "fetch":{"sessionId":"session_a","runId":"run_a"},
           "body":"[wake: completed] Session session_a — turn run_a completed.","deliveries":1}}
        """#)
        let detail = try #require(turn.notification)
        #expect(detail.kind == "wake")
        #expect(detail.wakeKind == "turn_completed")
        #expect(detail.deliveries == 1)

        #expect(turn.input.hasPrefix("[notification:"))
    }

    @Test func aTurnWithoutOneStillDecodes() throws {
        let turn = try decodeTurn(#"{"runId":"r","sessionId":"s","sequence":0,"state":"completed","input":"hi","acceptedAt":1,"updatedAt":1}"#)
        #expect(turn.notification == nil)
    }

    @Test func aCohortKeepsEveryEntryItMerged() throws {
        let item = try decodeItem(#"""
        {"id":"i1","runId":"r","sessionId":"s","status":"completed","startedAt":1,
         "detail":{"type":"notification","notification":{"kind":"wake","summary":"newest (and 2 more)","body":"b",
           "entries":[{"kind":"wake","runId":"run_a","summary":"a finished"},
                      {"kind":"wake","runId":"run_b","summary":"b finished"},
                      {"kind":"wake","runId":"run_c","summary":"c failed"}]}}}
        """#)
        guard case .notification(let detail) = item.detail else {
            Issue.record("expected a notification detail")
            return
        }
        #expect(detail.entries?.count == 3)
        #expect(detail.entries?.last?.summary == "c failed")
    }
}
