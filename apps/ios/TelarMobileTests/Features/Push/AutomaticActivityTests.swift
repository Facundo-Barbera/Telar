import Foundation
import Testing
@testable import TelarMobile

struct AutomaticActivityTests {
    @Test func automaticContentDecodesAndLinksToTheAttentionSession() throws {
        let data = Data(#"{"title":"2 active sessions","status":"Needs you","updatedAt":800000000,"startedAt":799999900,"ended":false,"sessionId":"session-two","activeCount":2}"#.utf8)
        let state = try JSONDecoder().decode(SessionActivityAttributes.ContentState.self, from: data)
        #expect(state.activeCount == 2)
        let attributes = SessionActivityAttributes(hostId: "11111111-1111-1111-1111-111111111111", sessionId: "__automatic__", hostName: "Mac")
        #expect(ScopedSessionID(url: attributes.url(sessionId: state.sessionId))?.sessionId == "session-two")
        #expect(attributes.url(sessionId: nil).absoluteString == "telar://inbox")
    }
    @Test func existingSessionCardsStillDecodeWithoutAggregateFields() throws {
        let data = Data(#"{"title":"Telar session","status":"Working","updatedAt":800000000,"startedAt":799999900,"ended":false}"#.utf8)
        let state = try JSONDecoder().decode(SessionActivityAttributes.ContentState.self, from: data)
        #expect(state.sessionId == nil)
        #expect(state.activeCount == nil)
    }

    @Test func theCardDecodesItsSessionRows() throws {
        let data = Data(#"{"title":"2 active sessions","status":"Needs you","updatedAt":800000000,"startedAt":799999900,"ended":false,"sessionId":"a","activeCount":2,"rows":[{"id":"a","status":"Needs you","title":"Fix login","project":"web"},{"id":"b","status":"Done","project":"api"}]}"#.utf8)
        let state = try JSONDecoder().decode(SessionActivityAttributes.ContentState.self, from: data)
        let rows = try #require(state.rows)
        #expect(rows.map(\.id) == ["a", "b"])
        #expect(rows[0].needsYou && rows[0].title == "Fix login")
        #expect(rows[1].over && rows[1].title == nil && rows[1].project == "api")
    }

    @Test func thePhoneMapsSessionsToRowsInTheEnginesOrder() throws {
        func session(_ id: String, _ activity: String, at: Int, title: String? = nil) throws -> Session {
            try JSONDecoder().decode(Session.self, from: Data("""
            {"id":"\(id)","title":"\(title ?? "Title \(id)")","createdAt":1,"updatedAt":1,"activity":"\(activity)","activityAt":\(at),
             "driver":"claude","workspace":{"mode":"worktree","path":"/tmp/x"}}
            """.utf8))
        }
        let sessions = [try session("q", "queued", at: 9), try session("w1", "working", at: 1), try session("w2", "working", at: 5),
                        try session("b", "blocked", at: 1), try session("m", "monitoring", at: 9), try session("i", "idle", at: 9)]
        let carried = [SessionActivityRow(id: "old", status: "Failed")]
        let rows = AutomaticCard.rows(sessions, previews: true, projects: ["w1": "web"], carried: carried)
        #expect(rows.map(\.id) == ["b", "w2", "w1", "q"])
        #expect(rows.map(\.status) == ["Needs you", "Working", "Working", "Queued"])
        #expect(rows[2].project == "web")
        #expect(AutomaticCard.rows([try session("w", "working", at: 1)], previews: true, carried: carried).map(\.id) == ["w", "old"])
        #expect(AutomaticCard.rows(sessions, previews: false).allSatisfy { $0.title == nil })
        let long = AutomaticCard.rows([try session("l", "working", at: 1, title: String(repeating: "x", count: 80))], previews: true)
        #expect(long[0].title?.count == 60 && long[0].title?.hasSuffix("…") == true)
    }

    @Test func workersFoldIntoTheirOrchestratorsRow() throws {
        func session(_ id: String, _ activity: String, parent: String? = nil, title: String? = nil) throws -> Session {
            let from = parent.map { #","startedFrom":{"sessionId":"\#($0)"}"# } ?? ""
            return try JSONDecoder().decode(Session.self, from: Data("""
            {"id":"\(id)","title":"\(title ?? "Title \(id)")","createdAt":1,"updatedAt":1,"activity":"\(activity)","activityAt":1,
             "driver":"claude","workspace":{"mode":"worktree","path":"/tmp/x"}\(from)}
            """.utf8))
        }
        let sessions = [try session("orch", "idle", title: ""), try session("a", "working", parent: "orch"), try session("b", "blocked", parent: "orch"),
                        try session("c", "queued", parent: "orch"), try session("orphan", "working", parent: "gone")]
        let rows = AutomaticCard.rows(sessions, previews: true, projects: ["a": "ozom-gv"])
        #expect(rows.map(\.id) == ["orch", "orphan"])
        #expect(rows[0].status == "Needs you" && rows[0].workers == 3 && rows[0].workersLabel == "3 workers")
        #expect(rows[0].title == nil && rows[0].project == "ozom-gv" && rows[0].label == "ozom-gv · 3 workers")
        #expect(rows[1].workers == nil && rows[1].title == "Title orphan")
        let state = AutomaticCard.initialState(sessions, previews: true, now: Date(timeIntervalSince1970: 1_800_000_000))
        #expect(state.activeCount == 2 && state.sessionId == "orch")
    }

    @Test func aRowIsNamedByItsTitleOrItsProjectButNeverItsMac() {
        #expect(SessionActivityRow(id: "a", status: "Working", title: "Fix login", project: "Telar", workers: 2).label == "Fix login")
        #expect(SessionActivityRow(id: "a", status: "Working", title: "Fix login", project: "Telar", workers: 2).detail == "Telar · 2 workers")
        #expect(SessionActivityRow(id: "a", status: "Working", project: "Telar", workers: 6).label == "Telar · 6 workers")
        #expect(SessionActivityRow(id: "b", status: "Working", project: "Telar", workers: 3).label == "Telar · 3 workers")
        #expect(SessionActivityRow(id: "c", status: "Working", project: "Telar").detail == nil)
        #expect(SessionActivityRow(id: "d", status: "Working").label == "Session")
    }

    @Test func theCardNamesTheMacWithoutItsDomain() {
        #expect(HostLabel.short("mini-fbarbera.snakebird-cardassia.ts.net") == "mini-fbarbera")
        #expect(HostLabel.short("Studio") == "Studio")
        #expect(HostLabel.short(nil) == "Computer")
    }

    @Test func thePhoneStartsACardOnlyForAWorkingMacWithoutOneThatCannotPushIt() {
        let (a, b, c, d) = (UUID(), UUID(), UUID(), UUID())
        #expect(AutomaticCard.hostsToStart(enabled: true, working: [a, b, c, d], carded: [b], dismissed: [c], engineStarts: [d]) == [a])
        #expect(AutomaticCard.hostsToStart(enabled: false, working: [a], carded: [], dismissed: [], engineStarts: []).isEmpty)
    }

    @Test func aMacStartsTheCardUnlessItReportsItCannot() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(AutomaticCard.engineStarts(ActivityReport(card: false)))
        #expect(AutomaticCard.engineStarts(ActivityReport(card: false, lastStart: .init(at: 1_800_000_000 - 10, status: 200)), now: now))
        #expect(AutomaticCard.engineStarts(ActivityReport(card: true, lastStart: .init(at: 1, status: 200)), now: now))
        #expect(!AutomaticCard.engineStarts(ActivityReport(card: false, lastStart: .init(at: 1_800_000_000 - AutomaticCard.startGrace, status: 200)), now: now))
        #expect(!AutomaticCard.engineStarts(ActivityReport(card: false, blocker: "no-start-token")))
        #expect(!AutomaticCard.engineStarts(ActivityReport(card: false, lastStart: .init(at: 1, status: 400, reason: "BadDeviceToken"))))
    }

    @Test func aSwipedCardStaysAwayUntilThatMacGoesIdle() {
        let (a, b) = (UUID(), UUID())
        #expect(AutomaticCard.dismissedStillIdle([a, b], working: [a]) == [a])
        #expect(AutomaticCard.hostsToStart(enabled: true, working: [b], carded: [], dismissed: AutomaticCard.dismissedStillIdle([a, b], working: [a]), engineStarts: []) == [b])
    }

    @Test func eachMacKeepsOnlyItsNewestCard() {
        func card(_ id: String, host: String, session: String = AutomaticCard.sessionId, at: Double) -> AutomaticCard.Shown {
            .init(id: id, hostId: host, sessionId: session, startedAt: Date(timeIntervalSince1970: at))
        }
        let cards = [card("old", host: "mac", at: 1), card("new", host: "mac", at: 3), card("ended", host: "mac", at: 2),
                     card("other", host: "studio", at: 1), card("session", host: "studio", session: "session_1", at: 9)]
        #expect(AutomaticCard.duplicates(cards) == ["old", "ended", "session"])
        #expect(AutomaticCard.duplicates([card("only", host: "mac", at: 1)]).isEmpty)
    }

    @Test func theFirstContentLeadsWithTheSessionThatNeedsYou() throws {
        func session(_ id: String, _ activity: String) throws -> Session {
            try JSONDecoder().decode(Session.self, from: Data("""
            {"id":"\(id)","title":"Title \(id)","createdAt":1,"updatedAt":1,"activity":"\(activity)",
             "driver":"claude","workspace":{"mode":"worktree","path":"/tmp/x"}}
            """.utf8))
        }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let two = AutomaticCard.initialState([try session("b", "working"), try session("a", "blocked")], previews: true, now: now)
        #expect(two.title == "2 active sessions")
        #expect(two.status == "Needs you")
        #expect(two.sessionId == "a")
        #expect(two.activeCount == 2)
        let one = AutomaticCard.initialState([try session("b", "working")], previews: true, now: now)
        #expect(one.title == "Title b")
        #expect(AutomaticCard.initialState([try session("b", "queued")], previews: false, now: now).title == "Telar work")
    }

    @Test func aShowingCardFollowsTheInboxWithoutWaitingForThePush() throws {
        func session(_ id: String, _ activity: String) throws -> Session {
            try JSONDecoder().decode(Session.self, from: Data("""
            {"id":"\(id)","title":"Title \(id)","createdAt":1,"updatedAt":1,"activity":"\(activity)",
             "driver":"claude","workspace":{"mode":"worktree","path":"/tmp/x"}}
            """.utf8))
        }
        let started = Date(timeIntervalSince1970: 1_800_000_000), later = started.addingTimeInterval(60)
        let card = AutomaticCard.initialState([try session("a", "working")], previews: true, now: started)
        #expect(AutomaticCard.refreshed(card, [try session("a", "working")], previews: true, now: later) == nil)
        let blocked = try #require(AutomaticCard.refreshed(card, [try session("a", "blocked")], previews: true, now: later))
        #expect(blocked.status == "Needs you")
        #expect(blocked.startedAt == started)
        #expect(blocked.updatedAt == later)
    }
}
