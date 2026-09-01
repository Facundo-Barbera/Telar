import Foundation

/// The cockpit's `/api/**` surface — a mirror of the browser client in
/// `apps/web/lib/engine/client.ts`. The app NEVER talks to the engine daemon
/// directly: it binds loopback with a per-boot token, by design. The Next
/// cockpit holds that token server-side and is what Tailscale reaches.
protocol EngineAPI: Sendable {
    func health() async throws -> EngineHealth
    func liveSessions() async throws -> LiveSessions
    func session(_ id: EngineID) async throws -> SessionSnapshot
    func events(_ id: EngineID, after: Int) async throws -> EventPage
    func submitTurn(_ id: EngineID, runId: String, input: String) async throws -> TurnSubmissionResult
    func stop(_ id: EngineID, runId: String?) async throws
    func resolveRequest(
        _ id: EngineID, requestId: EngineID,
        decision: RequestDecision, reason: String?, answers: [String: AnswerValue]?
    ) async throws
    func patchSession(_ id: EngineID, patch: SessionPatch) async throws
    /// SEND NOW: a queued turn is promoted into the RUNNING turn — the model
    /// hears it without stopping. The engine validates queued-into-running.
    func promoteTurn(_ id: EngineID, runId: String) async throws
    func createSession(projectId: EngineID, input: NewSessionInput) async throws -> Session
}

/// Mirror of `createSession`'s input in apps/web/lib/engine/client.ts. The
/// engine validates driver/envMode against the contract's own lists.
struct NewSessionInput: Encodable {
    var title: String?
    var driver: String?
    var envMode: String?
}

/// The only two shapes a `user_input` answer takes (`UserInputField.kind`
/// text/secret/choice all answer with a string; boolean with a bool).
enum AnswerValue: Encodable, Equatable {
    case text(String)
    case bool(Bool)

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .text(let s): try c.encode(s)
        case .bool(let b): try c.encode(b)
        }
    }
}

struct SessionPatch: Encodable {
    var title: String?
    var settledOverride: String?
    var snoozedUntil: Timestamp?
}

enum EngineAPIError: Error, LocalizedError {
    /// The cockpit answered with a typed engine error.
    case engine(code: String, message: String, status: Int)
    /// The cockpit answered, but not with the contract's error body.
    case badResponse(status: Int)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .engine(let code, let message, _):
            switch code {
            case "cockpit_unauthorized": "This phone is not paired with the cockpit — get a pairing code from Settings → Remote access."
            case "engine_unavailable": "The Mac's engine is down — the cockpit is up but can't reach it."
            case "worker_unavailable": "No worker is running on the Mac to take the turn."
            case "not_found": "That no longer exists on the engine."
            default: message
            }
        case .badResponse(let status): "Unexpected response (\(status)) — is the base URL a Telar cockpit?"
        case .transport(let error): error.localizedDescription
        }
    }

    var isNotFound: Bool {
        if case .engine(let code, _, _) = self { return code == "not_found" }
        return false
    }

    /// The cockpit's pairing gate said no — this phone holds no valid device
    /// token. The fix is a fresh pairing code, not a retry.
    var isUnauthorized: Bool {
        if case .engine(let code, _, _) = self { return code == "cockpit_unauthorized" }
        return false
    }
}

/// Idempotency keys, mirroring `newRunId` in apps/web/lib/engine/client.ts:
/// `run_` + uuid without dashes. The SAME id retried is what makes a resend
/// after a dropped response safe.
enum RunID {
    static func newRunId() -> String {
        "run_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}

struct HTTPEngineAPI: EngineAPI {
    let baseURL: URL
    /// The pairing credential, attached to every request when present. Lives
    /// in the Keychain (KeychainStore); nil against an open cockpit.
    let deviceToken: String?
    let session: URLSession

    init(baseURL: URL, deviceToken: String? = nil, session: URLSession? = nil) {
        self.baseURL = baseURL
        self.deviceToken = deviceToken
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 15
            // Fail fast when off the tailnet instead of queueing silently.
            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    func health() async throws -> EngineHealth {
        try await get("api/health")
    }

    func liveSessions() async throws -> LiveSessions {
        try await get("api/sessions/live")
    }

    func session(_ id: EngineID) async throws -> SessionSnapshot {
        try await get("api/sessions/\(escape(id))")
    }

    func events(_ id: EngineID, after: Int) async throws -> EventPage {
        try await get("api/sessions/\(escape(id))/events", query: [URLQueryItem(name: "after", value: String(after))])
    }

    func submitTurn(_ id: EngineID, runId: String, input: String) async throws -> TurnSubmissionResult {
        // 202 fresh and 200 replayed are BOTH success — the idempotent retry.
        try await post("api/sessions/\(escape(id))/turns", body: ["runId": AnyEncodable(runId), "input": AnyEncodable(input)])
    }

    func stop(_ id: EngineID, runId: String?) async throws {
        var body: [String: AnyEncodable] = [:]
        if let runId { body["runId"] = AnyEncodable(runId) }
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/stop", body: body)
    }

    func resolveRequest(
        _ id: EngineID, requestId: EngineID,
        decision: RequestDecision, reason: String?, answers: [String: AnswerValue]?
    ) async throws {
        var body: [String: AnyEncodable] = ["decision": AnyEncodable(decision.rawValue)]
        if let reason { body["reason"] = AnyEncodable(reason) }
        if let answers { body["answers"] = AnyEncodable(answers) }
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/requests/\(escape(requestId))", body: body)
    }

    func patchSession(_ id: EngineID, patch: SessionPatch) async throws {
        let _: IgnoredBody = try await send("PATCH", "api/sessions/\(escape(id))", body: patch)
    }

    func promoteTurn(_ id: EngineID, runId: String) async throws {
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/turns/\(escape(runId))/promote", body: [:])
    }

    func createSession(projectId: EngineID, input: NewSessionInput) async throws -> Session {
        struct Created: Decodable { var session: Session }
        let created: Created = try await send("POST", "api/projects/\(escape(projectId))/sessions", body: input)
        return created.session
    }

    // MARK: transport

    private func escape(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    }

    private func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        return components.url!
    }

    /// EVERY request funnels through here, so no endpoint can forget the
    /// pairing credential.
    private func makeRequest(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if let deviceToken {
            request.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await perform(makeRequest(url(path, query: query)))
    }

    /// Pre-pairing reachability: the one route that answers strangers.
    func ping() async throws -> Bool {
        struct Pong: Decodable { var ok: Bool }
        let pong: Pong = try await perform(makeRequest(url("api/ping")))
        return pong.ok
    }

    private func post<T: Decodable>(_ path: String, body: [String: AnyEncodable]) async throws -> T {
        try await send("POST", path, body: body)
    }

    private func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B) async throws -> T {
        var request = makeRequest(url(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await perform(request)
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw EngineAPIError.transport(error)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let body = try? JSONDecoder().decode(EngineErrorBody.self, from: data) {
                throw EngineAPIError.engine(code: body.error.code, message: body.error.message, status: status)
            }
            throw EngineAPIError.badResponse(status: status)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw EngineAPIError.badResponse(status: status)
        }
    }
}

/// Some calls only care that the server said yes.
struct IgnoredBody: Decodable {
    init(from decoder: Decoder) {}
}

/// Heterogeneous JSON bodies without a bespoke Encodable per endpoint.
struct AnyEncodable: Encodable {
    private let encodeFn: (Encoder) throws -> Void
    init<T: Encodable>(_ value: T) {
        encodeFn = { try value.encode(to: $0) }
    }
    func encode(to encoder: Encoder) throws {
        try encodeFn(encoder)
    }
}
