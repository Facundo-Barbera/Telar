import Foundation
import Testing
@testable import TelarMobile

@Suite struct ScopedRefTests {
    @Test func pendingSendKeysAreHostScoped() {
        let host = HostID()
        let key = "telar.pendingSend.\(host.uuidString).session_x"
        #expect(key.hasPrefix(HostMigration.pendingSendPrefix))
        #expect(key.contains(host.uuidString))
        let other = "telar.pendingSend.\(HostID().uuidString).session_x"
        #expect(key != other)
    }

    @Test func launchArgResolvesAgainstFirstHostOrHint() {
        var book = HostBook()
        guard case .added(let a) = book.upsert(baseURLString: "http://mini.tail:3000") else { return }
        guard case .added(let b) = book.upsert(baseURLString: "http://studio.tail:3000", name: "Studio") else { return }
        #expect(ScopedSessionID.resolveLaunchArg(sessionId: "s1", hostHint: nil, hosts: book.hosts)?.hostId == a)
        #expect(ScopedSessionID.resolveLaunchArg(sessionId: "s1", hostHint: "studio", hosts: book.hosts)?.hostId == b)
        #expect(ScopedSessionID.resolveLaunchArg(sessionId: "s1", hostHint: "MINI.TAIL", hosts: book.hosts)?.hostId == a)
        #expect(ScopedSessionID.resolveLaunchArg(sessionId: "s1", hostHint: "gone", hosts: book.hosts) == nil)
    }
}
