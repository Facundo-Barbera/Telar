import Foundation

/// The cockpit's `/api/**` surface — a mirror of the browser client in
/// `apps/web/lib/engine/client.ts`. The app NEVER talks to the engine daemon
/// directly: it binds loopback with a per-boot token, by design. The Next
/// cockpit holds that token server-side and is what Tailscale reaches.
protocol EngineAPI: Sendable {
    func health() async throws -> EngineHealth
    func liveSessions() async throws -> LiveSessions
    func session(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionSnapshot
    func events(_ id: EngineID, after: Int) async throws -> EventPage
    /// THE SAME TWO READS, AS BYTES — what the phone keeps for when the Mac is
    /// away (SnapshotCache). The wire types decode only, so the durable form
    /// is the cockpit's own JSON; these hand it over unparsed.
    func sessionData(_ id: EngineID) async throws -> Data
    func liveSessionsData() async throws -> Data
    func submitTurn(_ id: EngineID, runId: String, input: String, attachments: [EngineID]?) async throws -> TurnSubmissionResult
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
    /// The auto-settle window — engine-scoped, one answer per machine, so the
    /// phone bands its inbox the same way the Mac's sidebar does.
    func inboxPolicy() async throws -> InboxPolicy
    /// One file's bytes, uploaded BEFORE the message that refers to it.
    func uploadAttachment(_ id: EngineID, name: String, mediaType: String, data: Data) async throws -> TurnAttachment
    /// The provider's own model list for a driver.
    func models(driver: String) async throws -> ModelCatalogue
    /// Provider instances — a model change must name the instance that runs it.
    func providerInstances() async throws -> [ProviderInstance]
    /// What the session has done to the repository since it started.
    func sessionDiff(_ id: EngineID) async throws -> SessionDiff
    /// One file's patch, opened on demand.
    func filePatch(_ id: EngineID, path: String, untracked: Bool) async throws -> FilePatch
    /// Directories on the Mac — the phone's folder picker.
    func listDirectories(path: String?) async throws -> DirectoryListing
    func registerProject(name: String, root: String) async throws -> ProjectRef
    /// Branches for the draft's base-ref picker.
    func projectGit(_ projectId: EngineID) async throws -> GitOverview
    /// The cockpit's paired-device panel — who may reach the Mac, from here.
    func remoteStatus() async throws -> RemoteStatus
    func renameDevice(_ id: String, name: String) async throws -> RemoteDevice
    func setDeviceRole(_ id: String, role: String) async throws -> RemoteDevice
    func revokeDevice(_ id: String) async throws
    /// Revoke every device except this one (the server keeps the caller).
    func revokeOtherDevices() async throws -> Int
}

/// Mirror of `SnapshotWindow` in packages/engine-client: how much of a
/// session to read. Nil = the whole thing.
struct SnapshotWindow: Sendable {
    /// Newest N settled turns (unsettled ones always ride along).
    var turns: Int
    /// Page cursor from a previous read's `page.before`.
    var before: EngineID?

    init(turns: Int, before: EngineID? = nil) {
        self.turns = turns
        self.before = before
    }
}

extension EngineAPI {
    /// The unwindowed read older call sites mean.
    func session(_ id: EngineID) async throws -> SessionSnapshot {
        try await session(id, window: nil)
    }
}

struct InboxPolicy: Decodable, Equatable {
    /// `nil` = the clock is off: nothing settles by neglect, only by decision.
    var autoSettleAfterHours: Double?
}

/// Mirror of `createSession`'s input in apps/web/lib/engine/client.ts. The
/// engine validates driver/envMode against the contract's own lists.
struct NewSessionInput: Encodable {
    var title: String?
    var driver: String?
    var envMode: String?
    /// Worktree base — any name from `GitOverview.refs`. Absent = HEAD.
    var baseRef: String?
    /// The worktree's own branch name. Absent = the engine invents one.
    var branchName: String?
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
    /// "approval-required" | "auto-accept-edits" | "auto" | "full-access" —
    /// engine-validated; the composer's Configuration pill.
    var runtimeMode: String?
    /// Must belong to the session's provider instance — the engine rejects
    /// anything else. The composer's Model pill.
    var model: ModelSelection?
    var clearSettledOverride = false
    var clearSnooze = false
    private enum CodingKeys: String, CodingKey { case title, settledOverride, snoozedUntil, runtimeMode, model }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(title, forKey: .title)
        if clearSettledOverride { try c.encodeNil(forKey: .settledOverride) }
        else { try c.encodeIfPresent(settledOverride, forKey: .settledOverride) }
        if clearSnooze { try c.encodeNil(forKey: .snoozedUntil) }
        else { try c.encodeIfPresent(snoozedUntil, forKey: .snoozedUntil) }
        try c.encodeIfPresent(runtimeMode, forKey: .runtimeMode)
        try c.encodeIfPresent(model, forKey: .model)
    }
}

enum EngineAPIError: Error, LocalizedError {
    /// The cockpit answered with a typed engine error.
    case engine(code: String, message: String, status: Int)
    /// The cockpit answered, but not with the contract's error body.
    case badResponse(status: Int)
    /// A 2xx whose body didn't decode: the URL IS a cockpit — the two ends
    /// are just on very different versions. Distinct from badResponse so
    /// skew is never misdiagnosed as a wrong address.
    case incompatible(status: Int)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .engine(let code, let message, _):
            switch code {
            case "cockpit_unauthorized": "This phone is not paired with the cockpit — get a pairing code from Settings → Remote access."
            case "cockpit_forbidden": "This phone is paired for viewing only — give it full access from Remote access on the Mac."
            case "engine_unavailable": "The Mac's engine is down — the cockpit is up but can't reach it."
            case "worker_unavailable": "No worker is running on the Mac to take the turn."
            case "not_found": "That no longer exists on the engine."
            default: message
            }
        case .badResponse(let status): "Unexpected response (\(status)) — is the base URL a Telar cockpit?"
        case .incompatible: "The Mac and this app are on very different versions — update whichever is older."
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

    /// Paired, but view-only: the gate admits reads and refuses writes.
    var isForbidden: Bool {
        if case .engine(let code, _, _) = self { return code == "cockpit_forbidden" }
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
            // 30, not 15: creating a worktree session checks out the whole
            // repo, and a big one blows a 15s window — the create "fails" on
            // the phone while succeeding on the Mac.
            config.timeoutIntervalForRequest = 30
            // Fail fast when off the tailnet instead of queueing silently.
            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    func sidebarLayout() async throws -> [String] {
        struct Layout: Decodable { var projectOrder: [String] }
        struct Reply: Decodable { var layout: Layout }
        let reply: Reply = try await get("api/sidebar-layout")
        return reply.layout.projectOrder
    }

    func setSidebarLayout(_ order: [String]) async throws {
        let _: IgnoredBody = try await send("PATCH", "api/sidebar-layout", body: ["projectOrder": order])
    }

    func registerPush(_ registration: PushRegistration) async throws -> PushStatus {
        try await send("PUT", "api/mobile/push", body: registration)
    }

    func pushStatus() async throws -> PushStatus { try await get("api/mobile/push") }

    func health() async throws -> EngineHealth {
        try await get("api/health")
    }

    func liveSessions() async throws -> LiveSessions {
        try await get("api/sessions/live")
    }

    func session(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionSnapshot {
        var query: [URLQueryItem] = []
        if let window {
            query.append(URLQueryItem(name: "turns", value: String(window.turns)))
            if let before = window.before {
                query.append(URLQueryItem(name: "before", value: before))
            }
        }
        return try await get("api/sessions/\(escape(id))", query: query)
    }

    func events(_ id: EngineID, after: Int) async throws -> EventPage {
        try await get("api/sessions/\(escape(id))/events", query: [URLQueryItem(name: "after", value: String(after))])
    }

    func sessionData(_ id: EngineID) async throws -> Data {
        try await raw(makeRequest(url("api/sessions/\(escape(id))")))
    }

    func liveSessionsData() async throws -> Data {
        try await raw(makeRequest(url("api/sessions/live")))
    }

    func submitTurn(_ id: EngineID, runId: String, input: String, attachments: [EngineID]? = nil) async throws -> TurnSubmissionResult {
        // 202 fresh and 200 replayed are BOTH success — the idempotent retry.
        var body: [String: AnyEncodable] = ["runId": AnyEncodable(runId), "input": AnyEncodable(input)]
        if let attachments, !attachments.isEmpty { body["attachments"] = AnyEncodable(attachments) }
        return try await post("api/sessions/\(escape(id))/turns", body: body)
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

    func inboxPolicy() async throws -> InboxPolicy {
        struct Wrapped: Decodable { var inbox: InboxPolicy }
        let wrapped: Wrapped = try await get("api/inbox")
        return wrapped.inbox
    }

    /// Raw bytes, one file per request — a failed upload loses one file, not
    /// the whole selection. The filename travels percent-encoded in a header.
    func uploadAttachment(_ id: EngineID, name: String, mediaType: String, data: Data) async throws -> TurnAttachment {
        var request = makeRequest(url("api/sessions/\(escape(id))/attachments"))
        request.httpMethod = "POST"
        request.setValue(mediaType, forHTTPHeaderField: "content-type")
        request.setValue(
            name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "attachment",
            forHTTPHeaderField: "x-telar-attachment-name"
        )
        request.httpBody = data
        struct Wrapped: Decodable { var attachment: TurnAttachment }
        let wrapped: Wrapped = try await perform(request)
        return wrapped.attachment
    }

    func models(driver: String) async throws -> ModelCatalogue {
        struct Wrapped: Decodable { var catalogue: ModelCatalogue }
        let wrapped: Wrapped = try await get("api/models", query: [URLQueryItem(name: "driver", value: driver)])
        return wrapped.catalogue
    }

    func providerInstances() async throws -> [ProviderInstance] {
        struct Wrapped: Decodable { var providerInstances: [ProviderInstance] }
        let wrapped: Wrapped = try await get("api/provider-instances")
        return wrapped.providerInstances
    }

    func sessionDiff(_ id: EngineID) async throws -> SessionDiff {
        struct Wrapped: Decodable { var diff: SessionDiff }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/diff")
        return wrapped.diff
    }

    func filePatch(_ id: EngineID, path: String, untracked: Bool) async throws -> FilePatch {
        var query = [URLQueryItem(name: "path", value: path)]
        if untracked { query.append(URLQueryItem(name: "untracked", value: "1")) }
        struct Wrapped: Decodable { var file: FilePatch }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/diff", query: query)
        return wrapped.file
    }

    func listDirectories(path: String?) async throws -> DirectoryListing {
        var query: [URLQueryItem] = []
        if let path { query.append(URLQueryItem(name: "path", value: path)) }
        return try await get("api/fs", query: query)
    }

    func registerProject(name: String, root: String) async throws -> ProjectRef {
        struct Wrapped: Decodable { var project: ProjectRef }
        let wrapped: Wrapped = try await send("POST", "api/projects", body: ["name": AnyEncodable(name), "root": AnyEncodable(root)])
        return wrapped.project
    }

    func projectGit(_ projectId: EngineID) async throws -> GitOverview {
        struct Wrapped: Decodable { var git: GitOverview }
        let wrapped: Wrapped = try await get("api/projects/\(escape(projectId))/git")
        return wrapped.git
    }

    func remoteStatus() async throws -> RemoteStatus {
        try await get("api/remote")
    }

    private struct WrappedDevice: Decodable { var device: RemoteDevice }

    func renameDevice(_ id: String, name: String) async throws -> RemoteDevice {
        let wrapped: WrappedDevice = try await send(
            "PATCH", "api/remote/devices/\(escape(id))", body: ["name": AnyEncodable(name)]
        )
        return wrapped.device
    }

    func setDeviceRole(_ id: String, role: String) async throws -> RemoteDevice {
        let wrapped: WrappedDevice = try await send(
            "PATCH", "api/remote/devices/\(escape(id))", body: ["role": AnyEncodable(role)]
        )
        return wrapped.device
    }

    func revokeDevice(_ id: String) async throws {
        var request = makeRequest(url("api/remote/devices/\(escape(id))"))
        request.httpMethod = "DELETE"
        let _: IgnoredBody = try await perform(request)
    }

    func revokeOtherDevices() async throws -> Int {
        var request = makeRequest(url("api/remote/devices"))
        request.httpMethod = "DELETE"
        struct Wrapped: Decodable { var revoked: Int }
        let wrapped: Wrapped = try await perform(request)
        return wrapped.revoked
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

    /// Pre-pairing reachability: the one route that answers strangers. Also
    /// the version signature — `proto`/`appVersion` are absent on cockpits
    /// older than the field (treat missing proto as 1).
    func ping() async throws -> Pong {
        try await perform(makeRequest(url("api/ping")))
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
        let (data, status) = try await raw(request)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw EngineAPIError.incompatible(status: status)
        }
    }

    private func raw(_ request: URLRequest) async throws -> Data {
        try await raw(request).0
    }

    /// The transport half of `perform`: the bytes of a 2xx, or the engine's
    /// typed error. Split out so the snapshot cache can keep what the cockpit
    /// sent without parsing it.
    private func raw(_ request: URLRequest) async throws -> (Data, Int) {
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
        return (data, status)
    }
}

/// GET /api/ping — reachability plus the cockpit's version signature.
struct Pong: Decodable {
    var ok: Bool
    /// Pairing-protocol number; nil on cockpits older than the field = 1.
    var proto: Int?
    var appVersion: String?
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
