import Foundation

struct ProjectMark: Equatable {
    var icon: String?

    var iconName: String?

    var iconEmoji: String?

    static let none = ProjectMark()
}

struct ProjectPlace: Identifiable, Equatable {
    let hostId: HostID
    let projectId: String
    var name: String
    var mark: ProjectMark = .none
    var id: String { "\(hostId.uuidString):\(projectId)" }
}

struct SidebarProject: Identifiable {
    let id: String

    let layoutKey: String

    let hostId: HostID
    let projectId: String
    let name: String

    var mark: ProjectMark = .none

    var places: [ProjectPlace] = []

    var availability: ProjectAvailability?

    var awayLabel: String? {
        switch availability {
        case .unmounted: return "Drive away"
        case .missing: return "Folder gone"
        case .available, .unknown, nil: return nil
        }
    }

    var sessions: [HostedSession]
}

struct SidebarModel {
    var attention: [HostedSession]

    var pinned: [HostedSession]
    var projects: [SidebarProject]

    init(
        sessions: [HostedSession],
        names: (HostedSession) -> String?,
        marks: (HostedSession) -> ProjectMark = { _ in .none },

        remotes: (HostedSession) -> String? = { _ in nil },

        hostNames: (HostID) -> String? = { _ in nil },

        availabilities: @escaping (HostedSession) -> ProjectAvailability? = { _ in nil },
        layouts: [HostID: SidebarLayout] = [:]
    ) {
        attention = sessions.filter { $0.session.activity == .blocked }
        let pins = sessions.filter { $0.session.activity != .blocked && $0.session.settledOverride == "active" }

        pinned = SidebarModel.arranged(pins) { row in layouts[row.hostId]?.pinnedOrder.firstIndex(of: row.session.id) }

        let ordinary = sessions.filter {
            $0.session.activity != .blocked && $0.session.settledOverride != "active" && !($0.session.projectId ?? "").isEmpty
        }
        let groups = Dictionary(grouping: ordinary) { row in
            SidebarModel.groupKey(hostId: row.hostId, projectId: row.session.projectId ?? "", remote: remotes(row))
        }
        projects = groups.compactMap { key, rows -> SidebarProject? in
            let places = SidebarModel.places(rows, names: names, marks: marks, hostNames: hostNames)
            guard let first = places.first else { return nil }

            let layoutKey = key.hasPrefix(SidebarModel.repoPrefix) ? key : first.projectId
            return SidebarProject(
                id: key,
                layoutKey: layoutKey,
                hostId: first.hostId,
                projectId: first.projectId,
                name: first.name,
                mark: first.mark,
                places: places,
                availability: SidebarModel.agreedAvailability(rows, availabilities: availabilities),

                sessions: SidebarModel.arranged(rows) { row in
                    layouts[row.hostId]?.sessionOrder[layoutKey]?.firstIndex(of: row.session.id)
                }
            )
        }.sorted { a, b in
            let ar = SidebarModel.rank(a, layouts: layouts)
            let br = SidebarModel.rank(b, layouts: layouts)
            if ar != br { return ar < br }
            let comparison = a.name.localizedStandardCompare(b.name)
            if comparison != .orderedSame { return comparison == .orderedAscending }
            let an = hostNames(a.hostId) ?? "", bn = hostNames(b.hostId) ?? ""
            return an == bn ? a.id < b.id : an.localizedStandardCompare(bn) == .orderedAscending
        }
    }

    static func agreedAvailability(
        _ rows: [HostedSession],
        availabilities: (HostedSession) -> ProjectAvailability?
    ) -> ProjectAvailability? {
        var agreed: ProjectAvailability?
        for row in rows {
            guard let state = availabilities(row), state != .available else { return nil }
            if let agreed, agreed != state { return nil }
            agreed = state
        }
        return agreed
    }

    static let repoPrefix = "repo:"

    static func groupKey(hostId: HostID, projectId: String, remote: String?) -> String {
        if let remote, !remote.isEmpty { return "\(repoPrefix)\(remote)" }
        return "\(hostId.uuidString):\(projectId)"
    }

    private static func places(
        _ rows: [HostedSession],
        names: (HostedSession) -> String?,
        marks: (HostedSession) -> ProjectMark,
        hostNames: (HostID) -> String?
    ) -> [ProjectPlace] {
        var found: [String: ProjectPlace] = [:]
        for row in rows {
            let place = ProjectPlace(
                hostId: row.hostId,
                projectId: row.session.projectId ?? "",
                name: names(row) ?? row.session.projectId ?? "",
                mark: marks(row)
            )
            if found[place.id] == nil { found[place.id] = place }
        }
        return found.values.sorted { a, b in
            let an = hostNames(a.hostId) ?? "", bn = hostNames(b.hostId) ?? ""
            if an != bn { return an < bn }
            if a.hostId != b.hostId { return a.hostId.uuidString < b.hostId.uuidString }
            return a.projectId < b.projectId
        }
    }

    private static func rank(_ group: SidebarProject, layouts: [HostID: SidebarLayout]) -> Int {
        group.places
            .compactMap { layouts[$0.hostId]?.projectOrder.firstIndex(of: group.layoutKey) }
            .min() ?? Int.max
    }

    static func reordered(_ drawn: [HostedSession], offsets: IndexSet, to destination: Int) -> (host: HostID, ids: [String])? {
        guard offsets.count == 1, let from = offsets.first, drawn.indices.contains(from) else { return nil }
        let host = drawn[from].hostId

        var next = drawn.enumerated().filter { !offsets.contains($0.offset) }.map(\.element)
        let at = min(max(destination - offsets.filter { $0 < destination }.count, 0), next.count)
        next.insert(contentsOf: offsets.map { drawn[$0] }, at: at)

        let ids = { (rows: [HostedSession]) in rows.filter { $0.hostId == host }.map(\.session.id) }
        let after = ids(next)
        return after == ids(drawn) ? nil : (host, after)
    }

    static func keepingUnseen(_ drawn: [String], stored: [String]) -> [String] {
        var next = drawn
        var after = -1
        for key in stored {
            if let index = next.firstIndex(of: key) {
                after = index
                continue
            }
            next.insert(key, at: after + 1)
            after += 1
        }
        return next
    }

    static func arranged(_ rows: [HostedSession], rank: (HostedSession) -> Int?) -> [HostedSession] {
        var placed: [(at: Int, arrived: Int, row: HostedSession)] = []
        var rest: [HostedSession] = []
        for (arrived, row) in rows.enumerated() {
            if let at = rank(row) { placed.append((at, arrived, row)) } else { rest.append(row) }
        }
        if placed.isEmpty { return rows }
        placed.sort { $0.at == $1.at ? $0.arrived < $1.arrived : $0.at < $1.at }
        return placed.map(\.row) + rest
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

extension Session {
    func cockpitURL(base: URL) -> URL {
        guard let projectId else { return base }
        return base.appendingPathComponent("projects").appendingPathComponent(projectId)
            .appendingPathComponent("sessions").appendingPathComponent(id)
    }
}
