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
}
