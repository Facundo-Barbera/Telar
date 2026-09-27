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

    @Test func thePhoneStartsACardOnlyForAWorkingMacWithoutOne() {
        let (a, b, c) = (UUID(), UUID(), UUID())
        #expect(AutomaticCard.hostsToStart(enabled: true, working: [a, b, c], carded: [b], dismissed: [c]) == [a])
        #expect(AutomaticCard.hostsToStart(enabled: false, working: [a], carded: [], dismissed: []).isEmpty)
    }

    @Test func aSwipedCardStaysAwayUntilThatMacGoesIdle() {
        let (a, b) = (UUID(), UUID())
        #expect(AutomaticCard.dismissedStillIdle([a, b], working: [a]) == [a])
        #expect(AutomaticCard.hostsToStart(enabled: true, working: [b], carded: [], dismissed: AutomaticCard.dismissedStillIdle([a, b], working: [a])) == [b])
    }

    /// The Mac's first update replaces it, so it reads the way `automaticActivityDelivery` would.
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
}
