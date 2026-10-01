import Foundation

protocol SessionsAPI: Sendable {
    func liveSessions() async throws -> LiveSessions
    func liveSessions(matching etag: String?, since: Int?, all: Bool) async throws -> LiveSessionsRead
    func settledShelf(matching etag: String?) async throws -> LiveSessionsRead
    func session(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionSnapshot
    func sessionRead(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionRead
    func events(_ id: EngineID, after: Int) async throws -> EventPage
    func stopSession(_ id: EngineID) async throws
    func patchSession(_ id: EngineID, patch: SessionPatch) async throws
    func deleteSession(_ id: EngineID) async throws
    func regenerateSessionTitle(_ id: EngineID) async throws
    func markSessionRead(_ id: EngineID, runId: String) async throws -> Session
    func createSession(projectId: EngineID, input: NewSessionInput) async throws -> Session
    func inboxPolicy() async throws -> InboxPolicy
    func sidebarLayout() async throws -> SidebarLayout
    func sessionSubscriptions(_ id: EngineID) async throws -> [Subscription]
}

extension SessionsAPI {
    func sidebarLayout() async throws -> SidebarLayout { SidebarLayout() }

    func regenerateSessionTitle(_ id: EngineID) async throws {}

    func deleteSession(_ id: EngineID) async throws {}

    func sessionSubscriptions(_ id: EngineID) async throws -> [Subscription] { [] }

    func liveSessions(matching etag: String?, since: Int?, all: Bool) async throws -> LiveSessionsRead {
        LiveSessionsRead(live: try await liveSessions(), etag: nil, data: nil)
    }

    func sessionRead(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionRead {
        SessionRead(snapshot: try await session(id, window: window), data: nil)
    }

    func settledShelf(matching etag: String?) async throws -> LiveSessionsRead {
        try await liveSessions(matching: etag, since: nil, all: true)
    }
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

extension HTTPEngineAPI: SessionsAPI {
    func liveSessions() async throws -> LiveSessions {
        try await get("api/sessions/live")
    }

    func liveSessions(matching etag: String?, since: Int?, all: Bool) async throws -> LiveSessionsRead {
        var query: [URLQueryItem] = []
        if all { query.append(URLQueryItem(name: "all", value: "1")) }
        if let since { query.append(URLQueryItem(name: "since", value: String(since))) }
        return try await liveRead(query, matching: etag)
    }

    func settledShelf(matching etag: String?) async throws -> LiveSessionsRead {
        try await liveRead([URLQueryItem(name: "all", value: "1"), URLQueryItem(name: "shelf", value: "1")], matching: etag)
    }

    private func liveRead(_ query: [URLQueryItem], matching etag: String?) async throws -> LiveSessionsRead {
        var request = makeRequest(url("api/sessions/live", query: query))
        if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }

        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await exchange(request)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        let fresh = http?.value(forHTTPHeaderField: "Etag")
        if status == 304 { return LiveSessionsRead(live: nil, etag: fresh ?? etag, data: nil) }
        guard (200..<300).contains(status) else { throw EngineAPIError.failure(data, status: status) }
        let live: LiveSessions = try await decode(data, status: status)
        return LiveSessionsRead(live: live, etag: fresh, data: live.unchanged ? nil : data)
    }

    func session(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionSnapshot {
        try await get("api/sessions/\(escape(id))", query: sessionQuery(window))
    }

    func sessionRead(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionRead {
        let (data, status) = try await raw(makeRequest(url("api/sessions/\(escape(id))", query: sessionQuery(window))))
        return SessionRead(snapshot: try await decode(data, status: status), data: data)
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

    func stopSession(_ id: EngineID) async throws {
        let body = ["scope": AnyEncodable("session"), "commandId": AnyEncodable(UUID().uuidString)]
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/stop", body: body)
    }

    func patchSession(_ id: EngineID, patch: SessionPatch) async throws {
        let _: IgnoredBody = try await send("PATCH", "api/sessions/\(escape(id))", body: patch)
    }

    func regenerateSessionTitle(_ id: EngineID) async throws {
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/regenerate-title", body: [:])
    }

    func deleteSession(_ id: EngineID) async throws {
        let _: IgnoredBody = try await delete("api/sessions/\(escape(id))")
    }

    func markSessionRead(_ id: EngineID, runId: String) async throws -> Session {
        struct Wrapped: Decodable { var session: Session }
        let wrapped: Wrapped = try await post("api/sessions/\(escape(id))/read", body: ["runId": AnyEncodable(runId)])
        return wrapped.session
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
}
