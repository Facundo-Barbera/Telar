import Foundation
import Testing
@testable import TelarMobile

/// THE AGENT'S WAKE INBOX ON THE PHONE — issue #541, section A.
///
/// A completion on a session the Agent subscribed to used to start an Agent
/// turn, which the phone saw as a row in the transcript. It writes an inbox row
/// now and starts nothing, so this page and the strip built on it are the only
/// way the phone can say anything happened.
///
/// WHAT MUST NOT DRIFT:
///
///   - the page decodes, and a row this build cannot read costs the ROW and
///     never the page — the tolerance every other list here has;
///   - `inboxUnread` is absent on an older Mac and that is NOT zero;
///   - the verbs are the Mac digest's own words, so the strip and the block the
///     model was shown cannot name one happening twice;
///   - the ranking is the digest's: waiting on you, failed, then newest first.
@Suite struct AgentInboxTests {

    // ── DECODING ─────────────────────────────────────────────────────────────

    @Test func thePageDecodes() throws {
        let json = """
        {"rows":[
          {"id":7,"at":1700,"sessionId":"session_abcdef12","runId":"run_9","kind":"turn_completed","summary":"[wake: completed] Session finished","read":false},
          {"id":8,"at":1800,"sessionId":"session_bbbbbb22","runId":"run_3","kind":"request_opened","summary":"[wake: waiting] is WAITING on a request","read":false}
        ],"cursor":8,"more":false,"unread":2}
        """
        let page = try JSONDecoder().decode(AgentInboxPage.self, from: Data(json.utf8))
        #expect(page.rows.count == 2)
        #expect(page.cursor == 8)
        #expect(page.more == false)
        #expect(page.unread == 2)
        #expect(page.rows[0].kind == .turnCompleted)
        #expect(page.rows[0].sessionId == "session_abcdef12")
        #expect(page.rows[0].runId == "run_9")
        #expect(page.rows[1].kind == .requestOpened)
    }

    @Test func aPeerMessageCarriesItsIntent() throws {
        let json = #"{"rows":[{"id":1,"at":1,"sessionId":"session_aaaaaa11","runId":"run_1","kind":"peer_message","intent":"blocker","summary":"a session reported a blocker","read":false}],"cursor":1,"more":false,"unread":1}"#
        let page = try JSONDecoder().decode(AgentInboxPage.self, from: Data(json.utf8))
        #expect(page.rows[0].intent == "blocker")
        #expect(page.rows[0].verb == "Reported a blocker")
        #expect(page.rows[0].needsYou)
    }

    @Test func aKindThisBuildCannotReadCostsTheRowAndNotThePage() throws {
        // A Mac on a newer engine may write a kind this build has never heard
        // of. The row is skipped; the page is not lost, and neither is the strip
        // above the composer.
        let json = """
        {"rows":[
          {"id":1,"at":1,"sessionId":"session_aaaaaa11","runId":"run_1","kind":"invented_by_a_newer_mac","summary":"?","read":false},
          {"id":2,"at":2,"sessionId":"session_bbbbbb22","runId":"run_2","kind":"turn_failed","summary":"[wake: failed] it fell over","read":false}
        ],"cursor":2,"more":false,"unread":2}
        """
        let page = try JSONDecoder().decode(AgentInboxPage.self, from: Data(json.utf8))
        #expect(page.rows.count == 1)
        #expect(page.rows[0].kind == .turnFailed)
        // AND THE TOTAL IS THE MAC'S, not the count of what decoded: the badge
        // must not shrink because this build could not draw one row.
        #expect(page.unread == 2)
    }

    @Test func anEmptyPageIsAnEmptyStrip() throws {
        let page = try JSONDecoder().decode(AgentInboxPage.self, from: Data(#"{"rows":[],"cursor":0,"more":false,"unread":0}"#.utf8))
        #expect(page.rows.isEmpty)
        #expect(page.unread == 0)
    }

    @Test func theUnreadCountIsAbsentOnAnOlderMacRatherThanZero() throws {
        let old = #"{"enabled":true,"running":false,"queued":0}"#
        #expect(try JSONDecoder().decode(AgentState.self, from: Data(old.utf8)).inboxUnread == nil)

        let new = #"{"enabled":true,"running":false,"queued":0,"inboxUnread":3}"#
        #expect(try JSONDecoder().decode(AgentState.self, from: Data(new.utf8)).inboxUnread == 3)
    }

    // ── THE ROW, AS THE STRIP DRAWS IT ───────────────────────────────────────

    @Test func theVerbsAreTheMacDigestsOwnWords() {
        #expect(AgentInboxRow(id: 1, kind: .requestOpened).verb == "Waiting on you")
        #expect(AgentInboxRow(id: 2, kind: .turnFailed).verb == "Failed")
        #expect(AgentInboxRow(id: 3, kind: .turnCompleted).verb == "Finished")
        #expect(AgentInboxRow(id: 4, kind: .turnStopped).verb == "Stopped")
        #expect(AgentInboxRow(id: 5, kind: .peerMessage, intent: "task").verb == "Assigned work")
        #expect(AgentInboxRow(id: 6, kind: .peerMessage).verb == "Sent a message")
    }

    @Test func onlyWhatSomebodyHasToMoveOnTakesTheWarningTone() {
        #expect(AgentInboxRow(id: 1, kind: .requestOpened).needsYou)
        #expect(AgentInboxRow(id: 2, kind: .turnFailed).needsYou)
        #expect(!AgentInboxRow(id: 3, kind: .turnCompleted).needsYou)
        #expect(!AgentInboxRow(id: 4, kind: .turnStopped).needsYou)
        #expect(!AgentInboxRow(id: 5, kind: .peerMessage, intent: "report").needsYou)
    }

    @Test func theEnginesOwnBracketedKindIsStripped() {
        // The verb is already on the row beside it, so the line reads as one
        // sentence rather than as a label inside a label — the Mac's digest does
        // exactly the same thing.
        let row = AgentInboxRow(id: 1, kind: .turnFailed, summary: "[wake: failed] Session session_a — turn run_2 FAILED")
        #expect(row.line == "Session session_a — turn run_2 FAILED")
        // A summary with no bracket is left alone rather than trimmed at a
        // character that happens to be there.
        #expect(AgentInboxRow(id: 2, kind: .peerMessage, summary: "a session sent a message").line == "a session sent a message")
    }

    @Test func theRankingIsTheDigests() {
        let rows = [
            AgentInboxRow(id: 1, kind: .turnStopped),
            AgentInboxRow(id: 2, kind: .turnCompleted),
            AgentInboxRow(id: 3, kind: .turnFailed),
            AgentInboxRow(id: 4, kind: .requestOpened),
        ]
        #expect(rankAgentInbox(rows).map(\.kind) == [.requestOpened, .turnFailed, .turnCompleted, .turnStopped])
    }

    /// A REQUEST THAT ANSWERED ITSELF — issue #541, section D.
    ///
    /// It is drawn rather than skipped (the decoder knows the kind), it ranks
    /// second, and it does NOT take the warning tone: it is already resolved,
    /// and badging it would send a person to a row they cannot act on.
    @Test func aRequestThatTookItsOwnDefaultIsNewsRatherThanAnAsk() throws {
        let json = #"{"id":7,"at":1,"sessionId":"session_a","runId":"run_a","kind":"request_timeout","summary":"[request: answered for you] took ACCEPT","read":false}"#
        let decoded = try JSONDecoder().decode(AgentInboxRow.self, from: Data(json.utf8))
        #expect(decoded.kind == .requestTimeout)
        #expect(decoded.verb == "Answered for you")
        #expect(!decoded.needsYou)
        #expect(decoded.line == "took ACCEPT")

        let rows = [
            AgentInboxRow(id: 1, kind: .turnFailed),
            AgentInboxRow(id: 2, kind: .requestTimeout),
            AgentInboxRow(id: 3, kind: .requestOpened),
        ]
        #expect(rankAgentInbox(rows).map(\.kind) == [.requestOpened, .requestTimeout, .turnFailed])
    }

    @Test func withinABandTheNewestLeads() {
        let rows = [AgentInboxRow(id: 1, kind: .turnCompleted), AgentInboxRow(id: 9, kind: .turnCompleted)]
        #expect(rankAgentInbox(rows).map(\.id) == [9, 1])
    }

    // ── THE SIDEBAR BADGE ────────────────────────────────────────────────────

    @Test func theBadgeIsAbsentUntilSomethingIsWaiting() {
        #expect(HostedAgent(hostId: HostID(), unread: 0).badge == nil)
        #expect(HostedAgent(hostId: HostID(), unread: 1).badge == "1")
        #expect(HostedAgent(hostId: HostID(), unread: 99).badge == "99")
        // The row has a fixed width, and 143 versus 208 waiting updates is not a
        // difference anybody acts on.
        #expect(HostedAgent(hostId: HostID(), unread: 100).badge == "99+")
    }

    @Test func theRailsRowTakesItsCountFromTheStateItAlreadyPolls() {
        let host = HostID()
        let state = AgentState(enabled: true, inboxUnread: 5)
        #expect(agentRows([(hostId: host, enabled: true, state: state)], filter: nil).first?.unread == 5)
        // A Mac too old to report one badges nothing rather than an invented
        // number.
        #expect(agentRows([(hostId: host, enabled: true, state: AgentState(enabled: true))], filter: nil).first?.badge == nil)
    }
}
