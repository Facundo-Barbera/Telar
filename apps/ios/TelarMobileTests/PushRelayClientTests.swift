import Foundation
import Testing
@testable import TelarMobile

/// RELAY v2 FROM THE PHONE'S SIDE. The relay's own suite pins what it
/// accepts; these pin that the phone asks in exactly that shape. That means
/// an attestation over the challenge it was given, an assertion over the exact
/// bytes it sends, one key per Mac, and starting over when the relay forgets it.
@MainActor @Suite struct PushRelayClientTests {
    final class FakeAttest: AppAttesting {
        var isSupported = true
        var attested: [(keyId: String, hash: Data)] = []
        var asserted: [(keyId: String, hash: Data)] = []
        private var minted = 0
        func generateKey() async throws -> String { minted += 1; return "attest-key-\(minted)" }
        func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data { attested.append((keyId, clientDataHash)); return Data("attestation".utf8) }
        func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data { asserted.append((keyId, clientDataHash)); return Data("assertion".utf8) }
    }
    final class FakeRelay {
        var replies: [(Int, String)] = []
        var requests: [URLRequest] = []
        func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let (status, body) = replies.isEmpty ? (500, "{}") : replies.removeFirst()
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
        var calls: [String] { requests.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" } }
    }

    let attest = FakeAttest()
    let relay = FakeRelay()
    var clock = Date(timeIntervalSince1970: 1_800_000_000)
    let tokens = RelayTokens(token: String(repeating: "a", count: 64), pushToStartToken: nil, activities: [.init(id: "session_1", token: String(repeating: "c", count: 64))])

    func client(bundle: String = "com.telar.mobile", state: PushRelayClient.State? = nil, now: @escaping () -> Date) -> PushRelayClient {
        PushRelayClient(url: URL(string: "https://relay.test")!, bundle: bundle, sandbox: false, attest: attest,
                        transport: relay.send, load: { state }, persist: { _ in }, now: now)
    }

    @Test func registersOnceThenMintsOneKeyPerMac() async throws {
        let now = clock
        let subject = client { now }
        relay.replies = [(200, #"{"challenge":"issued-challenge"}"#), (201, #"{"handle":"h1"}"#), (201, #"{"keyId":"k1","sendKey":"s1"}"#)]
        let credential = await subject.credential(for: "mac-a", tokens: tokens)
        #expect(credential == RelayCredential(url: "https://relay.test", handle: "h1", keyId: "k1", sendKey: "s1"))
        #expect(relay.calls == ["GET /v2/challenge", "POST /v2/devices", "POST /v2/devices/h1/keys"])
        // The attestation binds the challenge the relay issued, nothing else.
        #expect(attest.attested.map(\.hash) == [PushRelayClient.sha256("issued-challenge")])
        let registration = try JSONSerialization.jsonObject(with: relay.requests[1].httpBody!) as! [String: Any]
        #expect(registration["challenge"] as? String == "issued-challenge")
        #expect(registration["bundle"] as? String == "com.telar.mobile")
        #expect(registration["keyId"] as? String == "attest-key-1")
        #expect(registration["token"] as? String == tokens.token)
        // The assertion covers exactly the bytes sent.
        let keyRequest = relay.requests[2]
        #expect(keyRequest.value(forHTTPHeaderField: "x-telar-assertion") == Data("assertion".utf8).base64EncodedString())
        #expect(attest.asserted.map(\.hash) == [PushRelayClient.sha256(PushRelayClient.clientData(method: "POST", path: "/v2/devices/h1/keys", body: keyRequest.httpBody!))])
        #expect(String(decoding: keyRequest.httpBody!, as: UTF8.self) == #"{"pairing":"mac-a"}"#)

        #expect(await subject.credential(for: "mac-a", tokens: tokens) == credential)
        #expect(relay.requests.count == 3, "a known Mac costs no request")
    }

    @Test func refreshesWhenTokensChangeAndOnceADay() async throws {
        var now = clock
        let registered = PushRelayClient.State(attestKeyId: "attest-key-1", handle: "h1", registered: tokens, refreshedAt: now, keys: ["mac-a": .init(keyId: "k1", sendKey: "s1")])
        let subject = client(state: registered) { now }
        _ = await subject.credential(for: "mac-a", tokens: tokens)
        #expect(relay.requests.isEmpty)

        var moved = tokens
        moved.token = String(repeating: "b", count: 64)
        relay.replies = [(200, "{}")]
        _ = await subject.credential(for: "mac-a", tokens: moved)
        #expect(relay.calls == ["PUT /v2/devices/h1"])
        let clientData = PushRelayClient.clientData(method: "PUT", path: "/v2/devices/h1", body: relay.requests[0].httpBody!)
        #expect(attest.asserted.last?.hash == PushRelayClient.sha256(clientData))

        now = now.addingTimeInterval(PushRelayClient.refreshInterval + 1)
        relay.replies = [(200, "{}")]
        _ = await subject.credential(for: "mac-a", tokens: moved)
        #expect(relay.calls == ["PUT /v2/devices/h1", "PUT /v2/devices/h1"])
    }

    @Test func aForcedRefreshResendsTokensThatLookUnchanged() async throws {
        let now = clock
        let registered = PushRelayClient.State(attestKeyId: "attest-key-1", handle: "h1", registered: tokens, refreshedAt: now, keys: ["mac-a": .init(keyId: "k1", sendKey: "s1")])
        let subject = client(state: registered) { now }
        _ = await subject.credential(for: "mac-a", tokens: tokens)
        #expect(relay.requests.isEmpty, "unchanged and fresh: nothing to send")
        // A Mac's start came back `not_registered`: the relay lost the start token.
        subject.forceRefresh()
        relay.replies = [(200, "{}")]
        _ = await subject.credential(for: "mac-a", tokens: tokens)
        #expect(relay.calls == ["PUT /v2/devices/h1"])
        _ = await subject.credential(for: "mac-a", tokens: tokens)
        #expect(relay.calls == ["PUT /v2/devices/h1"], "one forced re-send, not a loop")
    }

    @Test func startsOverWhenTheRelayHasForgottenIt() async throws {
        let now = clock
        let registered = PushRelayClient.State(attestKeyId: "attest-key-0", handle: "old", registered: tokens, refreshedAt: now, keys: ["mac-a": .init(keyId: "k-old", sendKey: "s-old")])
        let subject = client(state: registered) { now }
        var moved = tokens
        moved.pushToStartToken = String(repeating: "f", count: 64)
        relay.replies = [(410, "{}"), (200, #"{"challenge":"c2"}"#), (201, #"{"handle":"new"}"#), (201, #"{"keyId":"k-new","sendKey":"s-new"}"#)]
        let credential = await subject.credential(for: "mac-a", tokens: moved)
        #expect(relay.calls == ["PUT /v2/devices/old", "GET /v2/challenge", "POST /v2/devices", "POST /v2/devices/new/keys"])
        // A new registration never reuses a key minted for the old one.
        #expect(credential == RelayCredential(url: "https://relay.test", handle: "new", keyId: "k-new", sendKey: "s-new"))
    }

    @Test func unpairingRevokesTheMacsKeyAtTheRelay() async throws {
        let now = clock
        let registered = PushRelayClient.State(attestKeyId: "attest-key-1", handle: "h1", registered: tokens, refreshedAt: now, keys: ["mac-a": .init(keyId: "k1", sendKey: "s1"), "mac-b": .init(keyId: "k2", sendKey: "s2")])
        let subject = client(state: registered) { now }
        relay.replies = [(200, "{}")]
        await subject.revoke(host: "mac-a")
        #expect(relay.calls == ["DELETE /v2/devices/h1/keys/k1"])
        #expect(attest.asserted.map(\.hash) == [PushRelayClient.sha256("DELETE /v2/devices/h1/keys/k1\n")])
        #expect(subject.state.keys.keys.sorted() == ["mac-b"])
    }

    @Test func withoutAppAttestOrOnAnUnknownBundleThePhoneStaysOnV1() async throws {
        let now = clock
        attest.isSupported = false
        #expect(await client { now }.credential(for: "mac-a", tokens: tokens) == nil)
        attest.isSupported = true
        #expect(await client(bundle: "com.example.other") { now }.credential(for: "mac-a", tokens: tokens) == nil)
        #expect(relay.requests.isEmpty)
    }
}
