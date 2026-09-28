import Foundation
import Testing
@testable import TelarMobile

@Suite struct HostBookTests {
    @Test func normalizeCollapsesSpellings() {
        #expect(HostBook.normalize("HTTP://Mac.local:3000") == HostBook.normalize("http://mac.local:3000"))
        #expect(HostBook.normalize("http://mac.local") == HostBook.normalize("http://mac.local:80"))
        #expect(HostBook.normalize("http://mac.local:3000/") == HostBook.normalize("http://mac.local:3000"))
        #expect(HostBook.normalize("http://a:3000") != HostBook.normalize("http://b:3000"))
    }

    @Test func upsertAddsThenReplacesKeepingIdentity() {
        var book = HostBook()
        let first = book.upsert(baseURLString: "http://100.1.1.1:3000")
        guard case .added(let id) = first else { Issue.record("expected added"); return }
        // Re-pairing the same address: same identity, so its scoped keychain
        // account and pending sends stay reachable.
        let again = book.upsert(baseURLString: "HTTP://100.1.1.1:3000")
        #expect(again == .replaced(id))
        #expect(book.hosts.count == 1)
        // A different Mac is added, never evicting the first.
        guard case .added = book.upsert(baseURLString: "http://100.2.2.2:3000") else {
            Issue.record("expected added"); return
        }
        #expect(book.hosts.count == 2)
    }

    @Test func defaultNameCarriesANonStandardPort() {
        #expect(HostBook.defaultName(for: "http://127.0.0.1:3100") == "127.0.0.1:3100")
        #expect(HostBook.defaultName(for: "http://mini.tail:80") == "mini.tail")
        #expect(HostBook.defaultName(for: "https://mini.ts.net") == "mini.ts.net")
    }

    @Test func defaultNameIsTheHostAndRenameFloorsToIt() {
        var book = HostBook()
        guard case .added(let id) = book.upsert(baseURLString: "http://mini.tail:3000") else { return }
        #expect(book.host(id)?.name == "mini.tail:3000")
        book.rename(id, to: "  Office Mac  ")
        #expect(book.host(id)?.name == "Office Mac")
        book.rename(id, to: "   ")
        #expect(book.host(id)?.name == "mini.tail")
    }

    @Test func daemonIdCollapsesSameMacUnderTwoAddresses() {
        var book = HostBook()
        guard case .added(let older) = book.upsert(
            baseURLString: "http://192.168.1.5:3000", now: Date(timeIntervalSince1970: 100)
        ) else { return }
        guard case .added(let newer) = book.upsert(
            baseURLString: "http://100.1.1.1:3000", now: Date(timeIntervalSince1970: 200)
        ) else { return }
        #expect(book.recordDaemonId("daemon_x", for: older) == false)
        // The tailnet record turns out to be the same Mac: merge keeps the
        // OLDER id (it owns the scoped data) and the NEWER address.
        #expect(book.recordDaemonId("daemon_x", for: newer) == true)
        #expect(book.hosts.count == 1)
        #expect(book.hosts[0].id == older)
        #expect(book.hosts[0].baseURLString == "http://100.1.1.1:3000")
    }

    @Test func removalAndFingerprint() {
        var book = HostBook()
        guard case .added(let a) = book.upsert(baseURLString: "http://a:3000") else { return }
        guard case .added = book.upsert(baseURLString: "http://b:3000") else { return }
        let before = book.membershipFingerprint
        book.remove(a)
        #expect(book.hosts.count == 1)
        #expect(book.membershipFingerprint != before)
    }

    @Test func scopedSessionIdRoundTripsThroughCodable() throws {
        let ref = ScopedSessionID(hostId: HostID(), sessionId: "session_abc")
        let decoded = try JSONDecoder().decode(ScopedSessionID.self, from: JSONEncoder().encode(ref))
        #expect(decoded == ref)
    }
}
