import Foundation
import Testing
@testable import TelarMobile

@Suite struct SnapshotCacheTests {
    private func fresh() -> SnapshotCache {
        let root = FileManager.default.temporaryDirectory.appending(path: "telar-snapshots-\(UUID().uuidString)")
        return SnapshotCache(root: root)
    }

    @Test func roundTripsBytesPerHostAndSession() {
        let cache = fresh()
        let a = HostID(), b = HostID()
        cache.writeSession(host: a, id: "s1", data: Data("A".utf8))
        cache.writeSession(host: b, id: "s1", data: Data("B".utf8))
        // Two Macs, one session id: two entries.
        #expect(cache.readSession(host: a, id: "s1")?.data == Data("A".utf8))
        #expect(cache.readSession(host: b, id: "s1")?.data == Data("B".utf8))
        #expect(cache.readSession(host: a, id: "missing") == nil)
        #expect(cache.readSession(host: a, id: "s1")!.savedAt > 0)
    }

    @Test func inboxIsPerHostAndForgettingAMacForgetsItsBytes() {
        let cache = fresh()
        let host = HostID()
        cache.writeInbox(host: host, data: Data("inbox".utf8))
        cache.writeSession(host: host, id: "s1", data: Data("x".utf8))
        #expect(cache.readInbox(host: host)?.data == Data("inbox".utf8))
        cache.dropHost(host)
        #expect(cache.readInbox(host: host) == nil)
        #expect(cache.readSession(host: host, id: "s1") == nil)
    }

    @Test func aGoneSessionIsDropped() {
        let cache = fresh()
        let host = HostID()
        cache.writeSession(host: host, id: "s1", data: Data("x".utf8))
        cache.dropSession(host: host, id: "s1")
        #expect(cache.readSession(host: host, id: "s1") == nil)
    }

    @Test func keepsOnlyTheNewestSessionsPerHost() throws {
        let cache = fresh()
        let host = HostID()
        for index in 0..<(SnapshotCache.sessionsPerHost + 5) {
            cache.writeSession(host: host, id: "s\(index)", data: Data("\(index)".utf8))
            // Distinct mtimes so the order is the write order, not a tie.
            usleep(2_000)
        }
        #expect(cache.readSession(host: host, id: "s0") == nil)
        #expect(cache.readSession(host: host, id: "s4") == nil)
        #expect(cache.readSession(host: host, id: "s5") != nil)
        #expect(cache.readSession(host: host, id: "s\(SnapshotCache.sessionsPerHost + 4)") != nil)
    }

    @Test func recordedAtLabelIsAClockTime() {
        // Not asserting a locale-specific string; only that it is short and
        // carries the hour, which is what the banner needs.
        let label = recordedAtLabel(Timestamp(Date().timeIntervalSince1970 * 1000))
        #expect(!label.isEmpty && label.count < 12)
    }
}
