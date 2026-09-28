import Foundation

protocol EngineAPI: Sendable {
    func health() async throws -> EngineHealth
    func liveSessions() async throws -> LiveSessions

    func liveSessions(all: Bool) async throws -> LiveSessions

    func liveSessions(matching etag: String?, since: Int?, all: Bool) async throws -> LiveSessionsRead

    func liveSessions(since: Int) async throws -> LiveSessions
    func session(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionSnapshot

    func sessionRead(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionRead
    func events(_ id: EngineID, after: Int) async throws -> EventPage

    func projectIcon(_ projectId: EngineID, icon: String) async throws -> Data
    func submitTurn(_ id: EngineID, runId: String, input: String, attachments: [EngineID]?) async throws -> TurnSubmissionResult
    func stopSession(_ id: EngineID) async throws
    func stopTurn(_ id: EngineID, runId: String) async throws
    func resolveRequest(
        _ id: EngineID, requestId: EngineID,
        decision: RequestDecision, reason: String?, answers: [String: AnswerValue]?
    ) async throws
    func patchSession(_ id: EngineID, patch: SessionPatch) async throws

    func dictationToken() async throws -> DictationTokenAnswer

    func dictationDiagnosis() async throws -> DictationDiagnosisAnswer

    func dictation() async throws -> DictationAnswer

    func setDictation(provider: String?, apiKey: String?, language: String?, vocabulary: [String]?) async throws -> DictationAnswer

    func deleteSession(_ id: EngineID) async throws

    func markSessionRead(_ id: EngineID, runId: String) async throws -> Session

    func promoteTurn(_ id: EngineID, runId: String) async throws
    func createSession(projectId: EngineID, input: NewSessionInput) async throws -> Session

    func inboxPolicy() async throws -> InboxPolicy

    func sidebarLayout() async throws -> SidebarLayout

    func sessionSubscriptions(_ id: EngineID) async throws -> [Subscription]

    func uploadAttachment(_ id: EngineID, name: String, mediaType: String, data: Data) async throws -> TurnAttachment

    func models(driver: String) async throws -> ModelCatalogue

    func providerInstances() async throws -> [ProviderInstance]

    func sessionDiff(_ id: EngineID) async throws -> SessionDiff

    func filePatch(_ id: EngineID, path: String, untracked: Bool) async throws -> FilePatch

    func listDirectories(path: String?) async throws -> DirectoryListing
    func registerProject(name: String, root: String) async throws -> ProjectRef

    func projectGit(_ projectId: EngineID) async throws -> GitOverview

    func usageReport(sinceMs: Timestamp, untilMs: Timestamp, resolution: String, timeZone: String) async throws -> UsageReport

    func remoteStatus() async throws -> RemoteStatus
    func renameDevice(_ id: String, name: String) async throws -> RemoteDevice
    func setDeviceRole(_ id: String, role: String) async throws -> RemoteDevice
    func revokeDevice(_ id: String) async throws

    func revokeOtherDevices() async throws -> Int
}

struct SnapshotWindow: Sendable {
    var turns: Int

    var before: EngineID?

    init(turns: Int, before: EngineID? = nil) {
        self.turns = turns
        self.before = before
    }
}

struct LiveSessionsRead: Sendable {
    var live: LiveSessions?

    var etag: String?

    var data: Data?
}

struct SessionRead: Sendable {
    var snapshot: SessionSnapshot

    var data: Data?
}

extension EngineAPI {
    func session(_ id: EngineID) async throws -> SessionSnapshot {
        try await session(id, window: nil)
    }

    func sidebarLayout() async throws -> SidebarLayout { SidebarLayout() }

    func dictationToken() async throws -> DictationTokenAnswer {
        throw EngineAPIError.engine(code: "conflict", message: "This Mac cannot dictate.", status: 409)
    }

    func dictationDiagnosis() async throws -> DictationDiagnosisAnswer {
        throw EngineAPIError.engine(code: "conflict", message: "This Mac cannot dictate.", status: 409)
    }

    func dictation() async throws -> DictationAnswer {
        DictationAnswer(
            dictation: DictationAnswer.State(
                provider: DictationProvider.off, configured: false, language: DictationLanguages.automatic, languages: []
            )
        )
    }

    func setDictation(provider: String?, apiKey: String?, language: String?, vocabulary: [String]?) async throws -> DictationAnswer {
        throw EngineAPIError.engine(code: "conflict", message: "This Mac cannot change dictation settings.", status: 409)
    }

    func deleteSession(_ id: EngineID) async throws {}

    func sessionSubscriptions(_ id: EngineID) async throws -> [Subscription] { [] }

    func usageReport(sinceMs: Timestamp, untilMs: Timestamp, resolution: String, timeZone: String) async throws -> UsageReport {
        UsageReport.empty
    }

    func liveSessions(since: Int) async throws -> LiveSessions {
        try await liveSessions()
    }

    func liveSessions(all: Bool) async throws -> LiveSessions {
        try await liveSessions()
    }

    func liveSessions(matching etag: String?, since: Int?, all: Bool) async throws -> LiveSessionsRead {
        if let since { return LiveSessionsRead(live: try await liveSessions(since: since), etag: nil, data: nil) }
        return LiveSessionsRead(live: try await liveSessions(all: all), etag: nil, data: nil)
    }

    func sessionRead(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionRead {
        SessionRead(snapshot: try await session(id, window: window), data: nil)
    }
}

struct RawFile: Sendable {
    var data: Data
    var contentType: String?
}

protocol PanelAPI: Sendable {
    func projects() async throws -> [Project]
    func sessionFiles(_ id: EngineID) async throws -> WorkspaceListing
    func sessionFile(_ id: EngineID, path: String) async throws -> WorkspaceFile
    func writeSessionFile(_ id: EngineID, path: String, text: String, expectedSha256: String) async throws -> WorkspaceWriteResult
    func sessionFileRaw(_ id: EngineID, path: String) async throws -> RawFile
    func sessionTable(_ id: EngineID, path: String, offset: Int, limit: Int, sort: String?, desc: Bool) async throws -> TableWindow
    func attachments(_ id: EngineID, tag: String?) async throws -> [TurnAttachment]
    func attachmentBytes(_ id: EngineID, attachmentId: EngineID) async throws -> RawFile
    func tagAttachment(_ id: EngineID, attachmentId: EngineID, tags: [String]) async throws -> TurnAttachment
    func ds<T: Decodable & Sendable>(_ id: EngineID, method: String, body: JSONValue) async throws -> T
    func latex<T: Decodable & Sendable>(_ id: EngineID, method: String, body: JSONValue) async throws -> T
}

extension PanelAPI {
    func kernel(_ id: EngineID) async throws -> KernelStatus { try await ds(id, method: "kernel", body: .object([:])) }
    func kernelInterrupt(_ id: EngineID) async throws { let _: JSONValue = try await ds(id, method: "interrupt", body: .object([:])) }
    func kernelRestart(_ id: EngineID) async throws { let _: JSONValue = try await ds(id, method: "restart", body: .object([:])) }
    func kernelVars(_ id: EngineID, limit: Int = 200) async throws -> [VarRow] {
        try await ds(id, method: "vars", body: .object(["limit": .number(Double(limit))]))
    }
    func kernelInspect(_ id: EngineID, name: String, depth: Int = 10) async throws -> JSONValue {
        try await ds(id, method: "inspect", body: .object(["name": .string(name), "depth": .number(Double(depth))]))
    }
    func packages(_ id: EngineID) async throws -> PackageList { try await ds(id, method: "packages", body: .object([:])) }
    func notebookRead(_ id: EngineID, path: String, withOutputs: Bool = true) async throws -> NotebookRead {
        try await ds(id, method: "notebook/read", body: .object(["path": .string(path), "withOutputs": .bool(withOutputs)]))
    }
    func notebookEdit(_ id: EngineID, path: String, edit: JSONValue) async throws -> NotebookRead {
        try await ds(id, method: "notebook/edit", body: .object(["path": .string(path), "edit": edit]))
    }
    func notebookRun(_ id: EngineID, path: String, cellId: String?, all: Bool = false) async throws -> NotebookRunResult {
        var body: [String: JSONValue] = ["path": .string(path)]
        if let cellId { body["cellId"] = .string(cellId) }
        if all { body["all"] = .bool(true) }
        return try await ds(id, method: "notebook/run", body: .object(body))
    }
    func latexStatus(_ id: EngineID) async throws -> LatexCompileStatus { try await latex(id, method: "status", body: .object([:])) }
    func latexCompile(_ id: EngineID, path: String?) async throws -> LatexCompileAnswer {
        try await latex(id, method: "compile", body: .object(path.map { ["path": .string($0)] } ?? [:]))
    }
    func latexToolchain(_ id: EngineID) async throws -> LatexToolchain { try await latex(id, method: "toolchain", body: .object([:])) }
}

struct InboxPolicy: Decodable, Equatable {
    var autoSettleAfterHours: Double?
}

struct NewSessionInput: Encodable {
    var title: String?
    var driver: String?
    var envMode: String?

    var baseRef: String?

    var branchName: String?
}

enum AnswerValue: Encodable, Equatable {
    case text(String)
    case bool(Bool)
    case list([String])

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .text(let s): try c.encode(s)
        case .bool(let b): try c.encode(b)
        case .list(let labels): try c.encode(labels)
        }
    }
}

struct SessionPatch: Encodable {
    var title: String?
    var settledOverride: String?
    var snoozedUntil: Timestamp?

    var runtimeMode: String?

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
    case engine(code: String, message: String, status: Int)

    case badResponse(status: Int)

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

    var isUnauthorized: Bool {
        if case .engine(let code, _, _) = self { return code == "cockpit_unauthorized" }
        return false
    }

    var isForbidden: Bool {
        if case .engine(let code, _, _) = self { return code == "cockpit_forbidden" }
        return false
    }
}

enum RunID {
    static func newRunId() -> String {
        "run_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}

struct HTTPEngineAPI: EngineAPI {
    let baseURL: URL

    let deviceToken: String?
    let session: URLSession

    let failover: (@Sendable (URL) async -> URL?)?

    init(baseURL: URL, deviceToken: String? = nil, session: URLSession? = nil,
         failover: (@Sendable (URL) async -> URL?)? = nil) {
        self.baseURL = baseURL
        self.deviceToken = deviceToken
        self.failover = failover
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default

            config.timeoutIntervalForRequest = 30

            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    func sidebarLayout() async throws -> SidebarLayout {
        struct Reply: Decodable { var layout: SidebarLayout }
        let reply: Reply = try await get("api/sidebar-layout")
        return reply.layout
    }

    func setSidebarLayout(
        projectOrder: [String]? = nil,
        sessionOrder: [String: [String]]? = nil,
        pinnedOrder: [String]? = nil
    ) async throws -> SidebarLayout {
        struct Reply: Decodable { var layout: SidebarLayout }
        var patch: [String: JSONValue] = [:]
        if let projectOrder { patch["projectOrder"] = .array(projectOrder.map { .string($0) }) }
        if let sessionOrder {
            patch["sessionOrder"] = .object(sessionOrder.mapValues { .array($0.map { .string($0) }) })
        }
        if let pinnedOrder { patch["pinnedOrder"] = .array(pinnedOrder.map { .string($0) }) }
        let reply: Reply = try await send("PATCH", "api/sidebar-layout", body: JSONValue.object(patch))
        return reply.layout
    }

    func sessionSubscriptions(_ id: EngineID) async throws -> [Subscription] {
        struct Reply: Decodable { var subscriptions: [Skippable<Subscription>] }
        let reply: Reply = try await get("api/sessions/\(escape(id))/subscriptions")
        return reply.subscriptions.compactMap(\.value)
    }

    func registerPush(_ registration: PushRegistration) async throws -> PushStatus {
        try await send("PUT", "api/mobile/push", body: registration)
    }

    func health() async throws -> EngineHealth {
        try await get("api/health")
    }

    func liveSessions() async throws -> LiveSessions {
        try await get("api/sessions/live")
    }

    func liveSessions(all: Bool) async throws -> LiveSessions {
        try await get("api/sessions/live", query: all ? [URLQueryItem(name: "all", value: "1")] : [])
    }

    func liveSessions(since: Int) async throws -> LiveSessions {
        try await get("api/sessions/live", query: [URLQueryItem(name: "since", value: String(since))])
    }

    func liveSessions(matching etag: String?, since: Int?, all: Bool) async throws -> LiveSessionsRead {
        var query: [URLQueryItem] = []
        if all { query.append(URLQueryItem(name: "all", value: "1")) }
        if let since { query.append(URLQueryItem(name: "since", value: String(since))) }
        var request = makeRequest(url("api/sessions/live", query: query))
        if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }

        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await exchange(request)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        let fresh = http?.value(forHTTPHeaderField: "Etag")
        if status == 304 { return LiveSessionsRead(live: nil, etag: fresh ?? etag, data: nil) }
        guard (200..<300).contains(status) else {
            if let body = try? JSONDecoder().decode(EngineErrorBody.self, from: data) {
                throw EngineAPIError.engine(code: body.error.code, message: body.error.message, status: status)
            }
            throw EngineAPIError.badResponse(status: status)
        }

        let live = try await Task.detached(priority: .userInitiated) {
            guard let live = try? JSONDecoder().decode(LiveSessions.self, from: data) else {
                throw EngineAPIError.incompatible(status: status)
            }
            return live
        }.value

        return LiveSessionsRead(live: live, etag: fresh, data: live.unchanged ? nil : data)
    }

    func session(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionSnapshot {
        try await get("api/sessions/\(escape(id))", query: sessionQuery(window))
    }

    func sessionRead(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionRead {
        let (data, status) = try await raw(makeRequest(url("api/sessions/\(escape(id))", query: sessionQuery(window))))

        let snapshot: SessionSnapshot = try await Task.detached(priority: .userInitiated) {
            do {
                return try JSONDecoder().decode(SessionSnapshot.self, from: data)
            } catch {
                throw EngineAPIError.incompatible(status: status)
            }
        }.value
        return SessionRead(snapshot: snapshot, data: data)
    }

    private func sessionQuery(_ window: SnapshotWindow?) -> [URLQueryItem] {
        guard let window else { return [] }
        var query = [URLQueryItem(name: "turns", value: String(window.turns))]
        if let before = window.before {
            query.append(URLQueryItem(name: "before", value: before))
        }
        return query
    }

    func events(_ id: EngineID, after: Int) async throws -> EventPage {
        try await get("api/sessions/\(escape(id))/events", query: [URLQueryItem(name: "after", value: String(after))])
    }

    func projectIcon(_ projectId: EngineID, icon: String) async throws -> Data {
        try await raw(makeRequest(url("api/projects/\(escape(projectId))/icon", query: [URLQueryItem(name: "v", value: icon)])))
    }

    func submitTurn(_ id: EngineID, runId: String, input: String, attachments: [EngineID]? = nil) async throws -> TurnSubmissionResult {
        var body: [String: AnyEncodable] = ["runId": AnyEncodable(runId), "input": AnyEncodable(input)]
        if let attachments, !attachments.isEmpty { body["attachments"] = AnyEncodable(attachments) }
        return try await post("api/sessions/\(escape(id))/turns", body: body)
    }

    func stopTurn(_ id: EngineID, runId: String) async throws {
        let body = ["runId": AnyEncodable(runId)]
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/stop", body: body)
    }

    func stopSession(_ id: EngineID) async throws {
        let body = ["scope": AnyEncodable("session"), "commandId": AnyEncodable(UUID().uuidString)]
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

    func dictationToken() async throws -> DictationTokenAnswer {
        try await post("api/dictation/token", body: [:])
    }

    func dictationDiagnosis() async throws -> DictationDiagnosisAnswer {
        try await post("api/dictation/diagnose", body: [:])
    }

    func dictation() async throws -> DictationAnswer {
        try await get("api/dictation")
    }

    func setDictation(provider: String?, apiKey: String?, language: String?, vocabulary: [String]?) async throws -> DictationAnswer {
        var patch: [String: AnyEncodable] = [:]
        if let provider { patch["provider"] = AnyEncodable(provider) }
        if let apiKey { patch["apiKey"] = AnyEncodable(apiKey) }
        if let language { patch["language"] = AnyEncodable(language) }
        if let vocabulary { patch["vocabulary"] = AnyEncodable(vocabulary) }
        return try await send("PATCH", "api/dictation", body: patch)
    }

    func deleteSession(_ id: EngineID) async throws {
        var request = makeRequest(url("api/sessions/\(escape(id))"))
        request.httpMethod = "DELETE"
        let _: IgnoredBody = try await perform(request)
    }

    func promoteTurn(_ id: EngineID, runId: String) async throws {
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/turns/\(escape(runId))/promote", body: [:])
    }

    func markSessionRead(_ id: EngineID, runId: String) async throws -> Session {
        struct Wrapped: Decodable { var session: Session }
        let wrapped: Wrapped = try await post("api/sessions/\(escape(id))/read", body: ["runId": AnyEncodable(runId)])
        return wrapped.session
    }

    func readState(_ ids: [EngineID]) async throws -> [EngineID] {
        struct Answer: Decodable { var cleared: [EngineID] }
        let answer: Answer = try await get("api/mobile/read-state", query: [URLQueryItem(name: "ids", value: ids.joined(separator: ","))])
        return answer.cleared
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

    func usageReport(sinceMs: Timestamp, untilMs: Timestamp, resolution: String, timeZone: String) async throws -> UsageReport {
        struct Wrapped: Decodable { var usage: UsageReport }
        let wrapped: Wrapped = try await get("api/usage", query: [
            URLQueryItem(name: "since", value: String(sinceMs)),
            URLQueryItem(name: "until", value: String(untilMs)),
            URLQueryItem(name: "resolution", value: resolution),
            URLQueryItem(name: "tz", value: timeZone),
        ])
        return wrapped.usage
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

    private func escape(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    }

    private func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        return components.url!
    }

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

    private func exchange(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch {
            guard HostAddresses.isTransportFailure(error), let failover,
                  let moved = await failover(baseURL),
                  ["GET", "HEAD"].contains(request.httpMethod ?? "GET"),
                  let url = request.url, let rebased = HostAddresses.rebase(url, from: baseURL, to: moved)
            else { throw EngineAPIError.transport(error) }
            var retry = request
            retry.url = rebased
            do {
                return try await session.data(for: retry)
            } catch {
                throw EngineAPIError.transport(error)
            }
        }
    }

    static let probeTimeout: TimeInterval = 3

    private static let probeSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = probeTimeout
        config.timeoutIntervalForResource = probeTimeout
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    static func probe(_ base: URL) async -> Bool {
        guard let (data, response) = try? await probeSession.data(from: base.appending(path: "api/ping")),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let pong = try? JSONDecoder().decode(Pong.self, from: data)
        else { return false }
        return pong.ok
    }

    func ping() async throws -> Pong {
        try await perform(makeRequest(url("api/ping")))
    }

    private func post<T: Decodable>(_ path: String, body: [String: AnyEncodable]) async throws -> T {
        try await send("POST", path, body: body)
    }

    private func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: B) async throws -> T {
        var request = makeRequest(url(path, query: query))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await perform(request)
    }

    private func rawFile(_ request: URLRequest) async throws -> RawFile {
        let (data, response) = try await exchange(request)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let body = try? JSONDecoder().decode(EngineErrorBody.self, from: data) {
                throw EngineAPIError.engine(code: body.error.code, message: body.error.message, status: status)
            }
            throw EngineAPIError.badResponse(status: status)
        }
        return RawFile(data: data, contentType: http?.value(forHTTPHeaderField: "content-type"))
    }

    private func perform<T: Decodable & Sendable>(_ request: URLRequest) async throws -> T {
        let (data, status) = try await raw(request)
        return try await Task.detached(priority: .userInitiated) {
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                throw EngineAPIError.incompatible(status: status)
            }
        }.value
    }

    private func raw(_ request: URLRequest) async throws -> Data {
        try await raw(request).0
    }

    private func raw(_ request: URLRequest) async throws -> (Data, Int) {
        let (data, response) = try await exchange(request)
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

extension HTTPEngineAPI: PanelAPI {
    func projects() async throws -> [Project] {
        let list: ProjectList = try await get("api/projects")
        return list.projects
    }

    func sessionFiles(_ id: EngineID) async throws -> WorkspaceListing {
        struct Wrapped: Decodable { var listing: WorkspaceListing }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/files")
        return wrapped.listing
    }

    func sessionFile(_ id: EngineID, path: String) async throws -> WorkspaceFile {
        struct Wrapped: Decodable { var file: WorkspaceFile }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/files", query: [URLQueryItem(name: "path", value: path)])
        return wrapped.file
    }

    func writeSessionFile(_ id: EngineID, path: String, text: String, expectedSha256: String) async throws -> WorkspaceWriteResult {
        try await send(
            "PUT", "api/sessions/\(escape(id))/files",
            query: [URLQueryItem(name: "path", value: path)],
            body: ["text": AnyEncodable(text), "expectedSha256": AnyEncodable(expectedSha256)]
        )
    }

    func sessionFileRaw(_ id: EngineID, path: String) async throws -> RawFile {
        try await rawFile(makeRequest(url("api/sessions/\(escape(id))/files/raw", query: [URLQueryItem(name: "path", value: path)])))
    }

    func sessionTable(_ id: EngineID, path: String, offset: Int, limit: Int, sort: String?, desc: Bool) async throws -> TableWindow {
        var query = [
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "offset", value: String(offset)),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        if let sort { query.append(URLQueryItem(name: "sort", value: sort)) }
        if desc { query.append(URLQueryItem(name: "desc", value: "1")) }
        return try await get("api/sessions/\(escape(id))/data/table", query: query)
    }

    func attachments(_ id: EngineID, tag: String?) async throws -> [TurnAttachment] {
        struct Wrapped: Decodable {
            var attachments: [TurnAttachment]
            private enum CodingKeys: String, CodingKey { case attachments }
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                attachments = try c.decode([Skippable<TurnAttachment>].self, forKey: .attachments).compactMap(\.value)
            }
        }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/attachments", query: tag.map { [URLQueryItem(name: "tag", value: $0)] } ?? [])
        return wrapped.attachments
    }

    func attachmentBytes(_ id: EngineID, attachmentId: EngineID) async throws -> RawFile {
        try await rawFile(makeRequest(url("api/sessions/\(escape(id))/attachments/\(escape(attachmentId))")))
    }

    func tagAttachment(_ id: EngineID, attachmentId: EngineID, tags: [String]) async throws -> TurnAttachment {
        struct Wrapped: Decodable { var attachment: TurnAttachment }
        let wrapped: Wrapped = try await send("PATCH", "api/sessions/\(escape(id))/attachments/\(escape(attachmentId))", body: ["tags": AnyEncodable(tags)])
        return wrapped.attachment
    }

    func ds<T: Decodable & Sendable>(_ id: EngineID, method: String, body: JSONValue) async throws -> T {
        try await door("ds", id, method: method, body: body)
    }

    func latex<T: Decodable & Sendable>(_ id: EngineID, method: String, body: JSONValue) async throws -> T {
        try await door("latex", id, method: method, body: body)
    }

    private func door<T: Decodable & Sendable>(_ door: String, _ id: EngineID, method: String, body: JSONValue) async throws -> T {
        let path = "api/sessions/\(escape(id))/\(door)/" + method.split(separator: "/").map { escape(String($0)) }.joined(separator: "/")
        var request = makeRequest(url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, status) = try await raw(request)
        return try await Task.detached(priority: .userInitiated) {
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                throw EngineAPIError.engine(code: "unexpected_answer", message: "The Mac answered \(door)/\(method) in a shape this app cannot read.", status: status)
            }
        }.value
    }
}

struct Pong: Decodable {
    var ok: Bool

    var proto: Int?
    var appVersion: String?
}

struct IgnoredBody: Decodable {
    init(from decoder: Decoder) {}
}

struct AnyEncodable: Encodable {
    private let encodeFn: (Encoder) throws -> Void
    init<T: Encodable>(_ value: T) {
        encodeFn = { try value.encode(to: $0) }
    }
    func encode(to encoder: Encoder) throws {
        try encodeFn(encoder)
    }
}
