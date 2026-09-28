import Foundation
import Testing
@testable import TelarMobile

/// Which delivered alerts a read takes down. Every case here is either an
/// alert left up after it was read, or — worse — another Mac's alert taken
/// down because it shared a session id.
@Suite struct ReadSyncTests {
    private let mac = UUID(uuidString: "12345678-1234-1234-1234-123456789ABC")!
    private let other = UUID(uuidString: "87654321-4321-4321-4321-CBA987654321")!

    /// Shaped exactly as `notification()` in apps/web/lib/mobile/push.ts sends
    /// it: `thread-id` is `"<hostId>:<sessionId>"` with the phone's upper-case
    /// `uuidString`, and `url` is `sessionURL`.
    private func alert(_ id: String, host: UUID, identifier: String? = nil) -> DeliveredAlert {
        DeliveredAlert(identifier: identifier ?? "\(host.uuidString)-\(id)", threadIdentifier: "\(host.uuidString):\(id)",
                       url: "telar://session?host=\(host.uuidString)&id=\(id)")
    }

    @Test func theSilentPushNamesAMacAndItsSessions() {
        let reads = ReadSync.reads(from: ["aps": ["content-available": 1], "read": ["host": mac.uuidString.lowercased(), "sessions": ["a", "b", ""]]])
        #expect(reads == [ScopedSessionID(hostId: mac, sessionId: "a"), ScopedSessionID(hostId: mac, sessionId: "b")])
        // An ordinary alert, or a payload with no Mac named, clears nothing.
        #expect(ReadSync.reads(from: ["aps": ["alert": "x"], "url": "telar://session?host=\(mac.uuidString)&id=a"]).isEmpty)
        #expect(ReadSync.reads(from: ["read": ["host": "not-a-uuid", "sessions": ["a"]]]).isEmpty)
    }

    @Test func anAlertIsMatchedByItsThreadScopedToTheMac() {
        #expect(ReadSync.session(of: alert("a", host: mac)) == ScopedSessionID(hostId: mac, sessionId: "a"))
        // Case does not matter: the Mac echoes whatever the phone registered.
        let lower = DeliveredAlert(identifier: "x", threadIdentifier: "\(mac.uuidString.lowercased()):a", url: nil)
        #expect(ReadSync.session(of: lower) == ScopedSessionID(hostId: mac, sessionId: "a"))
        // No thread: the url says the same thing.
        let urlOnly = DeliveredAlert(identifier: "x", threadIdentifier: "", url: "telar://session?host=\(mac.uuidString)&id=a")
        #expect(ReadSync.session(of: urlOnly) == ScopedSessionID(hostId: mac, sessionId: "a"))
        // The relay's test alert belongs to no session.
        #expect(ReadSync.session(of: DeliveredAlert(identifier: "t", threadIdentifier: "", url: nil)) == nil)
    }

    @Test func onlyTheReadSessionsAlertsComeDownAndNeverAnotherMacs() {
        let delivered = [
            alert("a", host: mac, identifier: "1"), alert("a", host: mac, identifier: "2"),
            alert("b", host: mac, identifier: "3"),
            // Same session id, minted by a different Mac.
            alert("a", host: other, identifier: "4"),
            DeliveredAlert(identifier: "5", threadIdentifier: "", url: nil),
        ]
        #expect(ReadSync.identifiersToRemove(delivered, clearing: [ScopedSessionID(hostId: mac, sessionId: "a")]) == ["1", "2"])
        #expect(ReadSync.identifiersToRemove(delivered, clearing: []) == [])
    }

    @Test func theReconcileAsksEachMacOnlyAboutItsOwnDeliveredSessionsOnce() {
        let delivered = [alert("a", host: mac), alert("a", host: mac), alert("b", host: mac), alert("a", host: other),
                         DeliveredAlert(identifier: "t", threadIdentifier: "", url: nil)]
        #expect(ReadSync.reconcileQueries(delivered) == [mac: ["a", "b"], other: ["a"]])
        #expect(ReadSync.reconcileQueries([]).isEmpty)
        // Bounded to one request's worth per Mac.
        let many = (0..<(ReadSync.reconcileBatch + 5)).map { alert("s\($0)", host: mac) }
        #expect(ReadSync.reconcileQueries(many)[mac]?.count == ReadSync.reconcileBatch)
    }
}
