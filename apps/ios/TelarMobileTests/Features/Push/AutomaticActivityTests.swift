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

    @Test func thePhoneStartsACardOnlyForAWorkingMacWithoutOneThatCannotPushIt() {
        let (a, b, c, d) = (UUID(), UUID(), UUID(), UUID())
        #expect(AutomaticCard.hostsToStart(enabled: true, working: [a, b, c, d], carded: [b], dismissed: [c], engineStarts: [d]) == [a])
        #expect(AutomaticCard.hostsToStart(enabled: false, working: [a], carded: [], dismissed: [], engineStarts: []).isEmpty)
    }

    @Test func aMacStartsTheCardUnlessItReportsItCannot() {
        #expect(AutomaticCard.engineStarts(ActivityReport(card: false)))
        #expect(AutomaticCard.engineStarts(ActivityReport(card: false, lastStart: .init(at: 1, status: 200))))
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
