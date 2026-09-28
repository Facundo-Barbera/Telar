import Foundation
import Testing
@testable import TelarMobile

/// Fails every request to `deadHost` the way an unreachable address does, and
/// answers the rest. Its own class: a static handler shared across parallel
/// suites is a data race.
final class FailoverStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var deadHost = ""
    nonisolated(unsafe) static var seen: [String] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        Self.seen.append("\(request.httpMethod ?? "GET") \(url.host() ?? "")\(url.path())")
        if url.host() == Self.deadHost {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"ok":true}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private actor Calls {
    var count = 0
    func bump() { count += 1 }
}

@Suite(.serialized) struct HostAddressesTests {
    // MARK: migration

    /// The exact shape a pre-#832 build wrote to "telar.hosts": one address,
    /// no `addresses` key. It must decode as a one-address host.
    @Test func aBookWrittenBeforeAddressesDecodesAsOneAddressHosts() throws {
        let legacy = """
        [{"id":"11111111-1111-1111-1111-111111111111","name":"Studio Mac",
          "baseURLString":"http://192.168.1.5:3000","daemonId":"daemon_x",
          "addedAt":700000000,"migratedFromSingle":true},
         {"id":"22222222-2222-2222-2222-222222222222","name":"mini",
          "baseURLString":"http://100.70.1.2:3000","addedAt":700000100,"migratedFromSingle":false}]
        """
        let hosts = try JSONDecoder().decode([Host].self, from: Data(legacy.utf8))
        #expect(hosts.count == 2)
        #expect(hosts[0].baseURLString == "http://192.168.1.5:3000")
        #expect(hosts[0].addresses == ["http://192.168.1.5:3000"])
        #expect(hosts[0].daemonId == "daemon_x")
        #expect(hosts[0].migratedFromSingle)
        #expect(hosts[1].addresses == ["http://100.70.1.2:3000"])
    }

    @Test func theAddressInUseIsStillWrittenForADowngrade() throws {
        let host = Host(name: "mini", baseURLString: "http://100.70.1.2:3000", addresses: ["http://192.168.1.5:3000"])
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(host)) as? [String: Any]
        #expect(object?["baseURLString"] as? String == "http://100.70.1.2:3000")
        #expect(object?["addresses"] as? [String] == ["http://100.70.1.2:3000", "http://192.168.1.5:3000"])
        #expect(try JSONDecoder().decode(Host.self, from: JSONEncoder().encode(host)) == host)
    }

    @Test func persistAndLoadKeepTheAddresses() {
        let defaults = UserDefaults(suiteName: "telar.test.addresses.\(UUID().uuidString)")!
        var book = HostBook()
        _ = book.upsert(baseURLString: "http://192.168.1.5:3000", addresses: ["http://100.70.1.2:3000"])
        HostMigration.persist(book, defaults: defaults)
        #expect(HostMigration.load(defaults: defaults) == book)
    }

    // MARK: merging

    @Test func mergeKeepsTheAddressInUseFirstThenTheReportThenTheRest() {
        let merged = HostAddresses.merge(
            preferred: "http://100.70.1.2:3000",
            known: ["http://192.168.1.9:3000", "http://100.70.1.2:3000"],
            learned: ["http://192.168.1.5:3000", "HTTP://100.70.1.2:3000/", "https://mac.tail.ts.net"]
        )
        #expect(merged == [
            "http://100.70.1.2:3000", "http://192.168.1.5:3000", "https://mac.tail.ts.net", "http://192.168.1.9:3000",
        ])
    }

    @Test func noLearnedLoopbackButAPairedOneStays() {
        #expect(HostAddresses.merge(preferred: "http://127.0.0.1:3000", known: [], learned: ["http://localhost:3000", "ftp://x"])
            == ["http://127.0.0.1:3000"])
        #expect(!HostAddresses.isDialable("http://[::1]:3000"))
        #expect(HostAddresses.isDialable("https://mac.tail.ts.net"))
    }

    @Test func mergeIsCapped() {
        let learned = (1...20).map { "http://10.0.0.\($0):3000" }
        let merged = HostAddresses.merge(preferred: "http://a:3000", known: [], learned: learned)
        #expect(merged.count == HostAddresses.limit)
        #expect(merged.first == "http://a:3000")
    }

    // MARK: the book

    @Test func repairingAtAnotherKnownAddressKeepsTheHost() {
        var book = HostBook()
        guard case .added(let id) = book.upsert(
            baseURLString: "http://192.168.1.5:3000", addresses: ["http://192.168.1.5:3000", "http://100.70.1.2:3000"]
        ) else { Issue.record("expected added"); return }
        // Same Mac, paired again from the tailnet: same id, so the same
        // Keychain account — the token stays per host, not per address.
        #expect(book.upsert(baseURLString: "http://100.70.1.2:3000") == .replaced(id))
        #expect(book.hosts.count == 1)
        #expect(book.host(id)?.baseURLString == "http://100.70.1.2:3000")
        #expect(book.host(id)?.addresses == ["http://100.70.1.2:3000", "http://192.168.1.5:3000"])
    }

    @Test func learningNeverMovesTheAddressInUse() {
        var book = HostBook()
        guard case .added(let id) = book.upsert(baseURLString: "http://192.168.1.5:3000") else { return }
        #expect(book.learnAddresses(["http://100.70.1.2:3000"], for: id) == true)
        #expect(book.host(id)?.baseURLString == "http://192.168.1.5:3000")
        #expect(book.host(id)?.addresses == ["http://192.168.1.5:3000", "http://100.70.1.2:3000"])
        // The same report again changes nothing, so nothing is persisted.
        #expect(book.learnAddresses(["http://100.70.1.2:3000"], for: id) == false)
    }

    @Test func onlyAKnownAddressCanBecomeTheOneInUse() {
        var book = HostBook()
        guard case .added(let id) = book.upsert(
            baseURLString: "http://192.168.1.5:3000", addresses: ["http://100.70.1.2:3000", "https://mac.tail.ts.net"]
        ) else { return }
        #expect(book.markReachable("http://evil.test:3000", for: id) == false)
        #expect(book.markReachable("https://mac.tail.ts.net", for: id) == true)
        #expect(book.host(id)?.baseURLString == "https://mac.tail.ts.net")
        // Tried first next time; the others keep their order.
        #expect(book.host(id)?.addresses == ["https://mac.tail.ts.net", "http://192.168.1.5:3000", "http://100.70.1.2:3000"])
        #expect(book.markReachable("https://mac.tail.ts.net", for: id) == false)
    }

    @Test func aDaemonMergeKeepsEveryAddress() {
        var book = HostBook()
        guard case .added(let older) = book.upsert(baseURLString: "http://192.168.1.5:3000", now: Date(timeIntervalSince1970: 1)),
              case .added(let newer) = book.upsert(baseURLString: "http://100.70.1.2:3000", now: Date(timeIntervalSince1970: 2))
        else { return }
        _ = book.recordDaemonId("daemon_x", for: older)
        #expect(book.recordDaemonId("daemon_x", for: newer) == true)
        #expect(book.host(older)?.baseURLString == "http://100.70.1.2:3000")
        #expect(book.host(older)?.addresses == ["http://100.70.1.2:3000", "http://192.168.1.5:3000"])
    }

    // MARK: failover choice

    @Test func failoverOrderSkipsTheDeadAddress() {
        let host = Host(name: "m", baseURLString: "http://192.168.1.5:3000", addresses: ["http://100.70.1.2:3000", "https://m.ts.net"])
        #expect(HostAddresses.failoverOrder(host, failed: "HTTP://192.168.1.5:3000/") == ["http://100.70.1.2:3000", "https://m.ts.net"])
    }

    @Test func onlyAFailureToReachMovesTheHost() {
        #expect(HostAddresses.isTransportFailure(URLError(.cannotConnectToHost)))
        #expect(HostAddresses.isTransportFailure(URLError(.timedOut)))
        #expect(HostAddresses.isTransportFailure(URLError(.networkConnectionLost)))
        #expect(!HostAddresses.isTransportFailure(URLError(.cancelled)))
        #expect(!HostAddresses.isTransportFailure(URLError(.notConnectedToInternet)))
        #expect(!HostAddresses.isTransportFailure(EngineAPIError.badResponse(status: 500)))
    }

    @Test func rebaseSwapsOnlyTheOrigin() {
        let lan = URL(string: "http://192.168.1.5:3000")!
        let tail = URL(string: "https://m.ts.net/")!
        #expect(HostAddresses.rebase(URL(string: "http://192.168.1.5:3000/api/sessions/live?all=1")!, from: lan, to: tail)
            == URL(string: "https://m.ts.net/api/sessions/live?all=1"))
        // A longer port is not this origin.
        #expect(HostAddresses.rebase(URL(string: "http://192.168.1.5:30001/api")!, from: lan, to: tail) == nil)
    }

    @Test func theEarliestAnsweringAddressWinsEvenIfALaterOneIsFaster() async {
        let a = URL(string: "http://a:3000")!, b = URL(string: "http://b:3000")!, c = URL(string: "http://c:3000")!
        #expect(await HostAddresses.firstReachable([a, b, c]) { $0 != a } == b)
        #expect(await HostAddresses.firstReachable([a, b, c]) { _ in true } == a)
        #expect(await HostAddresses.firstReachable([a, b]) { _ in false } == nil)
        #expect(await HostAddresses.firstReachable([]) { _ in true } == nil)
    }

    // MARK: the transport

    private func api(failover: @escaping @Sendable (URL) async -> URL?) -> HTTPEngineAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FailoverStubURLProtocol.self]
        return HTTPEngineAPI(
            baseURL: URL(string: "http://lan.test:3000")!, deviceToken: "tlr_device",
            session: URLSession(configuration: config), failover: failover
        )
    }

    @Test func aReadThatCannotReachTheMacIsReplayedOnTheNewAddress() async throws {
        FailoverStubURLProtocol.deadHost = "lan.test"
        FailoverStubURLProtocol.seen = []
        let pong = try await api { _ in URL(string: "http://tail.test:3000")! }.ping()
        #expect(pong.ok)
        #expect(FailoverStubURLProtocol.seen == ["GET lan.test/api/ping", "GET tail.test/api/ping"])
    }

    @Test func aWriteMovesTheHostButIsNotReplayed() async {
        FailoverStubURLProtocol.deadHost = "lan.test"
        FailoverStubURLProtocol.seen = []
        let calls = Calls()
        do {
            try await api { _ in await calls.bump(); return URL(string: "http://tail.test:3000")! }.revokeDevice("dev_1")
            Issue.record("expected throw")
        } catch {
            #expect((error as? EngineAPIError).map { if case .transport = $0 { true } else { false } } == true)
        }
        #expect(await calls.count == 1)
        #expect(FailoverStubURLProtocol.seen == ["DELETE lan.test/api/remote/devices/dev_1"])
    }

    @Test func noOtherAddressMeansTheOriginalError() async {
        FailoverStubURLProtocol.deadHost = "lan.test"
        FailoverStubURLProtocol.seen = []
        await #expect(throws: EngineAPIError.self) { _ = try await api { _ in nil }.ping() }
        #expect(FailoverStubURLProtocol.seen == ["GET lan.test/api/ping"])
    }

    // MARK: the settings

    @MainActor private func settings(_ book: HostBook) -> AppSettings {
        let defaults = UserDefaults(suiteName: "telar.test.failover.\(UUID().uuidString)")!
        // A written book means the single-host migration never runs, so no
        // test ever reaches for the legacy Keychain item.
        HostMigration.persist(book, defaults: defaults)
        let settings = AppSettings(defaults: defaults, vault: MemoryVault())
        settings.snapshots = nil
        return settings
    }

    @MainActor @Test func failoverMovesAndRemembersTheAddressThatAnswered() async {
        var book = HostBook()
        guard case .added(let id) = book.upsert(
            baseURLString: "http://lan.test:3000", addresses: ["http://tail.test:3000", "https://m.ts.net"]
        ) else { return }
        let settings = settings(book)
        let calls = Calls()
        settings.probe = { url in await calls.bump(); return url.host() != "lan.test" }
        let before = settings.apiFingerprint(id)

        let moved = await settings.failover(id, from: URL(string: "http://lan.test:3000")!)
        #expect(moved == URL(string: "http://tail.test:3000"))
        #expect(settings.host(id)?.baseURLString == "http://tail.test:3000")
        #expect(settings.host(id)?.addresses.first == "http://tail.test:3000")
        // The rebuild key moved, so every client bound to this Mac is rebuilt
        // on the address that answers.
        #expect(settings.apiFingerprint(id) != before)

        // A second request that failed on the old address is simply pointed at
        // the new one: no second probe pass.
        let probed = await calls.count
        #expect(await settings.failover(id, from: URL(string: "http://lan.test:3000")!) == URL(string: "http://tail.test:3000"))
        #expect(await calls.count == probed)
    }

    @MainActor @Test func nothingAnsweringLeavesTheHostWhereItWas() async {
        var book = HostBook()
        guard case .added(let id) = book.upsert(baseURLString: "http://lan.test:3000", addresses: ["http://tail.test:3000"])
        else { return }
        let settings = settings(book)
        settings.probe = { _ in false }
        #expect(await settings.failover(id, from: URL(string: "http://lan.test:3000")!) == nil)
        #expect(settings.host(id)?.baseURLString == "http://lan.test:3000")
    }
}
