import Foundation
import Testing
@testable import TelarMobile

/// A MESSAGE THAT LANDED MID-TURN IS NOT AUTOMATICALLY THE PERSON'S.
///
/// `user_message` decoded its text alone, so every one of these was drawn by
/// `UserBubble`: a peer's 3 KB report sat on the right of the screen, unlabelled
/// and with nothing to collapse it, as though the reader had typed it. A busy
/// coordinator is steered far more often than it is messaged idle, so this was
/// the common case, not the edge.
///
/// These pin the three fields the row reads and the order it reads them in —
/// the web's `SteeredMessageRow`, 1:1.
@Suite struct SteeredMessageTests {
    private func decode(_ json: String) throws -> Item {
        try JSONDecoder().decode(Item.self, from: Data(json.utf8))
    }

    private func message(_ item: Item) throws -> UserMessageDetail {
        guard case .userMessage(let message) = item.detail else {
            Issue.record("expected a user_message, got \(item.detail)")
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not a user_message"))
        }
        return message
    }

    // MARK: decoding

    @Test func aPersonsSteeredMessageCarriesNeitherSenderNorWake() throws {
        let item = try decode(#"""
        {"id":"item_1","runId":"run_1","sessionId":"s","status":"completed",
         "detail":{"type":"user_message","text":"change direction"},"startedAt":1}
        """#)
        let message = try message(item)
        #expect(message.text == "change direction")
        #expect(message.sender == nil)
        #expect(message.notice == nil)
        #expect(message.wakeReason == nil)
        #expect(message.attachments == nil)
    }

    @Test func aPeersSteeredMessageCarriesItsSenderAndNotice() throws {
        let item = try decode(#"""
        {"id":"item_2","runId":"run_1","sessionId":"s","status":"completed",
         "detail":{"type":"user_message","text":"the whole 3 KB report",
          "sender":{"sessionId":"session_worker123456"},
          "notice":"[agent message · report] session session_worker123456 (run run_peer, 3,012 chars).\nThe message itself is not in this notice."},
         "startedAt":1}
        """#)
        let message = try message(item)
        #expect(message.sender?.sessionId == "session_worker123456")
        #expect(message.notice?.hasPrefix("[agent message · report]") == true)
        #expect(message.wakeReason == nil)
        // The BODY is still carried whole — it is what expanding the row shows.
        #expect(message.text == "the whole 3 KB report")
    }

    @Test func aSteeredWakeCarriesItsStructuredReason() throws {
        let item = try decode(#"""
        {"id":"item_3","runId":"run_1","sessionId":"s","status":"completed",
         "detail":{"type":"user_message","text":"[wake: completed] Session session_abc — turn run_def completed.",
          "wakeReason":{"kind":"turn_completed","sessionId":"session_abc","runId":"run_def"}},
         "startedAt":1}
        """#)
        let message = try message(item)
        #expect(message.wakeReason?.kind == "turn_completed")
        #expect(message.wakeReason?.sessionId == "session_abc")
        #expect(message.wakeReason?.runId == "run_def")
        // Nobody said it, so there is no sender to attribute it to.
        #expect(message.sender == nil)
    }

    @Test func steeredAttachmentsDecodeBesideTheText() throws {
        let item = try decode(#"""
        {"id":"item_4","runId":"run_1","sessionId":"s","status":"completed",
         "detail":{"type":"user_message","text":"look at this",
          "attachments":[{"id":"att_1","name":"shot.png","mediaType":"image/png","bytes":12}]},
         "startedAt":1}
        """#)
        let message = try message(item)
        #expect(message.attachments?.count == 1)
        #expect(message.attachments?.first?.name == "shot.png")
    }

    @Test func anUnreadableFieldDoesNotCostTheRowItsSender() throws {
        // Per-field leniency, not all-or-nothing: `attachments` arriving in a
        // shape this build cannot read must not take `sender` down with it —
        // that field is the whole difference between a peer's report and the
        // reader's own words.
        let item = try decode(#"""
        {"id":"item_5","runId":"run_1","sessionId":"s","status":"completed",
         "detail":{"type":"user_message","text":"report","attachments":"not an array",
          "sender":{"sessionId":"session_worker"}},
         "startedAt":1}
        """#)
        let message = try message(item)
        #expect(message.sender?.sessionId == "session_worker")
        #expect(message.attachments == nil)
    }

    @Test func anUnknownWakeKindIsKeptRatherThanDropped() throws {
        // A newer engine's vocabulary must still be a wake, or the row goes
        // back to rendering as somebody's bubble.
        let item = try decode(#"""
        {"id":"item_6","runId":"run_1","sessionId":"s","status":"completed",
         "detail":{"type":"user_message","text":"[wake: something] …",
          "wakeReason":{"kind":"turn_unparked","sessionId":"session_abc"}},
         "startedAt":1}
        """#)
        #expect(try message(item).wakeReason?.kind == "turn_unparked")
    }

    @Test func aUserMessageWithoutTextIsStillARowRatherThanAThrow() throws {
        // The file's rule for a payload it cannot read is RENDER, not skip.
        let item = try decode(#"""
        {"id":"item_7","runId":"run_1","sessionId":"s","status":"completed",
         "detail":{"type":"user_message"},"startedAt":1}
        """#)
        #expect(item.detail == .unknown(label: "user_message"))
    }

    // MARK: the fold carries them through

    @Test func theFoldKeepsAPeersStampOnTheRowTheTranscriptReads() throws {
        let item = try decode(#"""
        {"id":"item_8","runId":"run_1","sessionId":"s","status":"completed",
         "detail":{"type":"user_message","text":"peer body","notice":"[agent message · result] …",
          "sender":{"sessionId":"session_worker"}},
         "startedAt":1}
        """#)
        let turns = projectJournal(turns: [makeTurn("run_1")], items: [item], events: [])
        let folded = try #require(turns.first?.items.first)
        #expect(folded.text == "peer body")
        guard case .userMessage(let message) = folded.detail else {
            Issue.record("the fold dropped the message detail")
            return
        }
        #expect(message.sender?.sessionId == "session_worker")
        #expect(message.notice == "[agent message · result] …")
    }

    // MARK: what the row says

    @Test func aSteeredWakeSaysWhatItsQueuedTwinSays() {
        // THE VERB COMES FROM THE STRUCTURED REASON, NOT THE WORDS ON THE ROW
        // (#572). The notice used to BE the line, so a peer's result and the
        // completion behind it both read "Session finished a turn." — one
        // sentence printed twice for two different facts.
        let wake = UserMessageDetail(text: "[wake: completed] …", wakeReason: WakeReason(kind: "turn_completed"))
        #expect(WakeRow(message: wake).line == "Session finished a turn")
        // The engine's own words are the HEAD now, under the verb, and the
        // bracketed kind goes because the verb beside it already says it.
        var noticed = wake
        noticed.notice = "[wake: completed] Session session_a — turn run_a completed."
        let row = WakeRow(message: noticed)
        #expect(row.line == "Session finished a turn")
        #expect(row.head == "Session session_a — turn run_a completed.")
        // And a wake with nothing written on it still says what happened.
        let bare = WakeRow(message: UserMessageDetail(text: "", wakeReason: WakeReason(kind: "turn_failed")))
        #expect(bare.line == "Session failed a turn")
        #expect(bare.head == nil)
    }

    /// THE BUG, AS A TEST — issue #572.
    ///
    /// A worker sends its coordinator a result and its turn ends seconds later.
    /// #240 keeps those two facts on purpose; the screenshot that opened the
    /// issue had both rows titled "Session finished a turn", 24 seconds apart.
    @Test func aResultAndTheCompletionAfterItAreTwoDifferentLines() {
        let result = NotificationDetail(kind: "peer_message", intent: "result",
                                        summary: "[agent message · result] session session_a sent a result (run run_a, 5,793 chars)",
                                        body: "b")
        let completion = NotificationDetail(kind: "wake", wakeKind: "turn_completed",
                                            summary: "[wake: completed] Session session_a — turn run_a completed.", body: "b")
        #expect(describeNotification(result) == "A session sent a result")
        #expect(describeNotification(completion) == "Session finished a turn")
        #expect(describeNotification(result) != describeNotification(completion))
        // The head is the second difference, for a reader who does not read verbs.
        #expect(describeNotificationHead(result, message: "Three commits landed: the parser, its tests, the changelog.")
                == "Three commits landed: the parser, its tests, the changelog.")
        // Without the body on this side, the engine's summary line stands in.
        #expect(describeNotificationHead(result) == "session session_a sent a result (run run_a, 5,793 chars)")
        // A wake announces something in ANOTHER session's run and has none here.
        #expect(describeNotificationHead(completion, message: "not this turn's") == nil)
    }

    @Test func aPeersHeadIsCutAndMarkedWhereItWasCut() {
        #expect(notificationHead(nil) == nil)
        #expect(notificationHead("   \n  ") == nil)
        // A line that is ONLY the engine's kind has no head left once stripped.
        #expect(notificationHead("[wake: completed]") == nil)
        let long = notificationHead(String(repeating: "x", count: 500))
        #expect(long?.count == notificationHeadChars)
        #expect(long?.hasSuffix("…") == true)
        // Exactly the limit is not cut.
        let exact = String(repeating: "y", count: notificationHeadChars)
        #expect(notificationHead(exact) == exact)
    }

    @Test func theCollapsedRowShowsTheNoticesFirstLineOnly() {
        // The rest of the notice tells the MODEL how to fetch the body; a row
        // one line tall has no use for it.
        let notice = "[agent message · task] session session_x ASSIGNED work (run run_y, 2,158 chars).\n—\nIt opens: \"…\""
        #expect(noticeFirstLine(notice) == "[agent message · task] session session_x ASSIGNED work (run run_y, 2,158 chars).")
        #expect(noticeFirstLine("one line") == "one line")
        #expect(noticeFirstLine("") == "")
    }
}
