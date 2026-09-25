import CryptoKit
import DeviceCheck
import Foundation

/// What a Mac needs to send to this phone through relay v2: which
/// registration, and the key that signs its requests. Handed to each paired
/// Mac inside `PUT /api/mobile/push`. The Mac never learns an APNs token.
struct RelayCredential: Encodable, Equatable {
    var url: String
    var handle: String
    var keyId: String
    var sendKey: String
}

/// The tokens the relay holds for this phone. A Live Activity is named by its
/// session id, which is how a Mac refers to it when it sends.
struct RelayTokens: Codable, Equatable {
    struct Activity: Codable, Equatable {
        var id: String
        var token: String
    }
    var token: String
    var pushToStartToken: String?
    var activities: [Activity]
}

/// `DCAppAttestService`, behind a seam so the tests can stand in for it.
protocol AppAttesting {
    var isSupported: Bool { get }
    func generateKey() async throws -> String
    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data
    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data
}
extension DCAppAttestService: AppAttesting {}

/**
 REGISTERING THIS PHONE WITH THE PUSH RELAY — relay v2.

 v1 needed every Mac provisioned by hand. With v2 the phone registers itself,
 proving with App Attest that it is a genuine Telar build, and gives each
 paired Mac its own send key. After pairing, the only thing left for a person
 to do is allow notifications.

 - Register once: challenge → attest a fresh key → `POST /v2/devices` → handle.
 - Keep the relay's copy of the tokens current: `PUT` whenever they change.
 - Mint one key per paired Mac (`POST …/keys`), and revoke it on unpair.

 Every request after registration carries an App Attest assertion over
 `"<METHOD> <path>\n<body>"`. A registration the relay no longer knows is
 started over, which also rotates every Mac's key. Wherever App Attest is
 unavailable (the simulator, an unknown bundle) this answers nil, and the
 phone keeps using v1.
 */
@MainActor final class PushRelayClient {
    struct State: Codable, Equatable {
        var attestKeyId: String?
        var handle: String?
        var registered: RelayTokens?
        var refreshedAt: Date?
        var keys: [String: Key] = [:]
        struct Key: Codable, Equatable {
            var keyId: String
            var sendKey: String
        }
    }
    struct RelayError: Error { var status: Int }

    typealias Transport = (URLRequest) async throws -> (Data, URLResponse)
    nonisolated static let bundles: Set<String> = ["com.telar.mobile", "com.telar.mobile.dev"]
    /// Compiled in, and overridable through Info.plist (`TelarPushRelayURL`) so
    /// the relay can move to its own account or domain without a code change.
    nonisolated static var defaultURL: URL {
        (Bundle.main.object(forInfoDictionaryKey: "TelarPushRelayURL") as? String).flatMap(URL.init(string:))
            ?? URL(string: "https://telar-push-relay.facundo-barbera.workers.dev")!
    }
    static let shared = PushRelayClient()

    private(set) var state: State
    private let url: URL
    private let bundle: String
    private let sandbox: Bool
    private let attest: AppAttesting
    private let transport: Transport
    private let persist: (State) -> Void
    private let now: () -> Date

    init(url: URL = PushRelayClient.defaultURL,
         bundle: String = Bundle.main.bundleIdentifier ?? "com.telar.mobile",
         sandbox: Bool = PushRelayClient.debugBuild,
         attest: AppAttesting = DCAppAttestService.shared,
         transport: @escaping Transport = { try await URLSession.shared.data(for: $0) },
         load: () -> State? = PushRelayClient.loadState,
         persist: @escaping (State) -> Void = PushRelayClient.saveState,
         now: @escaping () -> Date = Date.init) {
        self.url = url
        self.now = now
        self.bundle = bundle
        self.sandbox = sandbox
        self.attest = attest
        self.transport = transport
        self.persist = persist
        self.state = load() ?? State()
    }

    nonisolated static var debugBuild: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    /// This Mac's credential, registering or refreshing first as needed. Nil
    /// when v2 is unavailable here, and the Mac falls back to v1.
    func credential(for host: String, tokens: RelayTokens) async -> RelayCredential? {
        guard attest.isSupported, Self.bundles.contains(bundle) else { return nil }
        do {
            try await synchronize(tokens)
            return try await key(for: host)
        } catch {
            return nil
        }
    }

    /// Unpairing: the Mac's key stops working at the relay, not just here.
    func revoke(host: String) async {
        guard let key = state.keys[host] else { return }
        state.keys[host] = nil
        persist(state)
        if let handle = state.handle {
            _ = try? await phoneRequest("DELETE", "/v2/devices/\(handle)/keys/\(key.keyId)")
        }
    }

    /// The relay forgets a registration left unrefreshed for 60 days, so an
    /// unchanged one is still refreshed once a day.
    nonisolated static let refreshInterval: TimeInterval = 86400

    private func synchronize(_ tokens: RelayTokens) async throws {
        guard let handle = state.handle else { return try await register(tokens) }
        if state.registered == tokens, let at = state.refreshedAt, now().timeIntervalSince(at) < Self.refreshInterval { return }
        let (status, _) = try await phoneRequest("PUT", "/v2/devices/\(handle)", body: tokens)
        switch status {
        case 200:
            state.registered = tokens
            state.refreshedAt = now()
            persist(state)
        // Forgotten (404/410) or no longer accepting this key (401): start over.
        case 401, 404, 410:
            try await register(tokens)
        default:
            throw RelayError(status: status)
        }
    }

    private func register(_ tokens: RelayTokens) async throws {
        let (status, data) = try await request("GET", "/v2/challenge")
        guard status == 200, let challenge = try JSONDecoder().decode([String: String].self, from: data)["challenge"] else { throw RelayError(status: status) }
        let keyId = try await attest.generateKey()
        let attestation = try await attest.attestKey(keyId, clientDataHash: Self.sha256(challenge))
        struct Registration: Encodable {
            var keyId: String, attestation: String, challenge: String, bundle: String, sandbox: Bool
            var token: String, pushToStartToken: String?, activities: [RelayTokens.Activity]
        }
        let body = try JSONEncoder().encode(Registration(keyId: keyId, attestation: attestation.base64EncodedString(), challenge: challenge, bundle: bundle, sandbox: sandbox, token: tokens.token, pushToStartToken: tokens.pushToStartToken, activities: tokens.activities))
        let (created, answer) = try await request("POST", "/v2/devices", body: body)
        guard created == 201, let handle = try JSONDecoder().decode([String: String].self, from: answer)["handle"] else { throw RelayError(status: created) }
        // A new registration: every Mac's old key belonged to the old one.
        state = State(attestKeyId: keyId, handle: handle, registered: tokens, refreshedAt: now())
        persist(state)
    }

    private func key(for host: String) async throws -> RelayCredential {
        guard let handle = state.handle else { throw RelayError(status: 0) }
        if let key = state.keys[host] {
            return RelayCredential(url: url.absoluteString, handle: handle, keyId: key.keyId, sendKey: key.sendKey)
        }
        let (status, data) = try await phoneRequest("POST", "/v2/devices/\(handle)/keys", body: ["pairing": host])
        guard status == 201 else { throw RelayError(status: status) }
        let minted = try JSONDecoder().decode(State.Key.self, from: data)
        state.keys[host] = minted
        persist(state)
        return RelayCredential(url: url.absoluteString, handle: handle, keyId: minted.keyId, sendKey: minted.sendKey)
    }

    private func phoneRequest(_ method: String, _ path: String, body: some Encodable) async throws -> (Int, Data) {
        try await phoneRequest(method, path, data: JSONEncoder().encode(body))
    }
    private func phoneRequest(_ method: String, _ path: String, data: Data = Data()) async throws -> (Int, Data) {
        guard let keyId = state.attestKeyId else { throw RelayError(status: 0) }
        let signed = Self.clientData(method: method, path: path, body: data)
        let assertion = try await attest.generateAssertion(keyId, clientDataHash: Self.sha256(signed))
        return try await request(method, path, body: data.isEmpty ? nil : data, assertion: assertion.base64EncodedString())
    }

    private func request(_ method: String, _ path: String, body: Data? = nil, assertion: String? = nil) async throws -> (Int, Data) {
        var request = URLRequest(url: url.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 20
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        if let assertion { request.setValue(assertion, forHTTPHeaderField: "x-telar-assertion") }
        let (data, response) = try await transport(request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    /// Exactly what the relay recomputes: the method, the path and the body bytes sent.
    nonisolated static func clientData(method: String, path: String, body: Data) -> String {
        "\(method) \(path)\n\(String(decoding: body, as: UTF8.self))"
    }
    nonisolated static func sha256(_ text: String) -> Data { Data(SHA256.hash(data: Data(text.utf8))) }

    // The send keys are secrets, so the state lives in the Keychain.
    private nonisolated static let account = "pushRelay"
    nonisolated static func loadState() -> State? {
        KeychainStore.read(account: account).flatMap { try? JSONDecoder().decode(State.self, from: Data($0.utf8)) }
    }
    nonisolated static func saveState(_ state: State) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        KeychainStore.write(String(decoding: data, as: UTF8.self), account: account)
    }
}
