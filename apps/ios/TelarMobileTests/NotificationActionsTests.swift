import Foundation
import Testing
import UserNotifications
@testable import TelarMobile

/// APPROVE AND OPEN. The Mac decides which alerts offer Approve and names the
/// request; these pin that the phone offers it only under that category,
/// behind an unlock, and resolves only the request it was told about.
@Suite struct NotificationActionsTests {
    private let host = UUID(uuidString: "12345678-1234-1234-1234-123456789abc")!
    private var url: String { "telar://session?host=\(host.uuidString)&id=session_1" }

    @Test func approveNeedsAnUnlockAndIsOfferedOnlyForARequest() throws {
        let categories = Dictionary(uniqueKeysWithValues: NotificationActions.categories.map { ($0.identifier, $0) })
        // These ids are the wire contract with apps/web/lib/mobile/push.ts.
        #expect(Set(categories.keys) == ["TELAR_REQUEST", "TELAR_SESSION"])
        let request = try #require(categories["TELAR_REQUEST"])
        #expect(request.actions.map(\.identifier) == [NotificationActions.approve, NotificationActions.open])
        let approve = try #require(request.actions.first)
        #expect(approve.options.contains(.authenticationRequired))
        #expect(!approve.options.contains(.foreground), "approving happens without opening the app")
        #expect(categories["TELAR_SESSION"]?.actions.map(\.identifier) == [NotificationActions.open])
    }

    @Test func anApprovalNamesTheSessionAndTheOneRequest() {
        let approval = NotificationActions.approval(from: ["url": url, "request": "req_1"])
        #expect(approval == .init(ref: ScopedSessionID(hostId: host, sessionId: "session_1"), requestId: "req_1"))
    }

    @Test func anAlertThatNamedNoRequestApprovesNothing() {
        #expect(NotificationActions.approval(from: ["url": url]) == nil)
        #expect(NotificationActions.approval(from: ["url": url, "request": ""]) == nil)
        #expect(NotificationActions.approval(from: ["request": "req_1"]) == nil)
        #expect(NotificationActions.approval(from: ["url": "https://example.com", "request": "req_1"]) == nil)
    }
}
