import Foundation

struct SidebarProject: Identifiable {
    let hostId: HostID
    let projectId: String
    let name: String
    var sessions: [HostedSession]
    var id: String { "\(hostId.uuidString):\(projectId)" }
}

/// The desktop's precedence: attention, pins, projects. Never duplicate a row.
struct SidebarModel {
    var attention: [HostedSession]
    var pinned: [HostedSession]
    var projects: [SidebarProject]

    init(sessions: [HostedSession], names: (HostedSession) -> String?, orders: [HostID: [String]] = [:]) {
        attention = sessions.filter { $0.session.activity == .blocked }
        pinned = sessions.filter { $0.session.activity != .blocked && $0.session.settledOverride == "active" }
        let ordinary = sessions.filter { $0.session.activity != .blocked && $0.session.settledOverride != "active" }
        let groups = Dictionary(grouping: ordinary) { "\($0.hostId):\($0.session.projectId ?? "")" }
        projects = groups.values.compactMap { rows in
            guard let first = rows.first else { return nil }
            return SidebarProject(hostId: first.hostId, projectId: first.session.projectId ?? "", name: names(first) ?? "Other sessions", sessions: rows)
        }.sorted { a, b in
            if a.hostId != b.hostId { return a.hostId.uuidString < b.hostId.uuidString }
            if a.hostId == b.hostId {
                let order = orders[a.hostId] ?? []
                let ar = order.firstIndex(of: a.projectId) ?? Int.max
                let br = order.firstIndex(of: b.projectId) ?? Int.max
                if ar != br { return ar < br }
            }
            let comparison = a.name.localizedStandardCompare(b.name)
            return comparison == .orderedSame ? a.id < b.id : comparison == .orderedAscending
        }
    }
}

extension ScopedSessionID {
    var url: URL {
        var parts = URLComponents()
        parts.scheme = "telar"
        parts.host = "session"
        parts.queryItems = [URLQueryItem(name: "host", value: hostId.uuidString), URLQueryItem(name: "id", value: sessionId)]
        return parts.url!
    }

    init?(url: URL) {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "telar", parts.host == "session",
              let host = parts.queryItems?.first(where: { $0.name == "host" })?.value,
              let hostId = UUID(uuidString: host),
              let session = parts.queryItems?.first(where: { $0.name == "id" })?.value,
              !session.isEmpty else { return nil }
        self.init(hostId: hostId, sessionId: session)
    }
}

/// Public cockpit links are portable between devices; host UUID links stay local to this installation.
extension Session {
    func cockpitURL(base: URL) -> URL {
        guard let projectId else { return base.appendingPathComponent("spool") }
        return base.appendingPathComponent("projects").appendingPathComponent(projectId)
            .appendingPathComponent("sessions").appendingPathComponent(id)
    }
}
