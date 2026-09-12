import Foundation

struct SidebarProject: Identifiable {
    let hostId: HostID
    let projectId: String
    let name: String
    /// `ProjectRef.icon`, when the Mac listed one.
    var icon: String? = nil
    var sessions: [HostedSession]
    var id: String { "\(hostId.uuidString):\(projectId)" }
}

/// The desktop's precedence: attention, pins, projects. Never duplicate a row.
///
/// WHERE A ROW SITS INSIDE A BAND IS A DECISION TOO, not only where its group
/// sits — the desktop's `groupSessions` (apps/web/lib/session-groups.ts). An
/// arrangement made on the Mac used to reach the phone as project order only,
/// so conversations dragged within a group, or within pinned, showed here in
/// default order (#306, part of #285).
struct SidebarModel {
    var attention: [HostedSession]
    var pinned: [HostedSession]
    var projects: [SidebarProject]

    init(
        sessions: [HostedSession],
        names: (HostedSession) -> String?,
        icons: (HostedSession) -> String? = { _ in nil },
        layouts: [HostID: SidebarLayout] = [:]
    ) {
        attention = sessions.filter { $0.session.activity == .blocked }
        let pins = sessions.filter { $0.session.activity != .blocked && $0.session.settledOverride == "active" }
        /// THE ROW KEYS ARE THE MAC'S OWN. A Mac writes its own sessions into
        /// the document by bare id, which is what this phone holds for them;
        /// a row belonging to a different Mac is never in this Mac's list, so
        /// looking it up there cannot place it by somebody else's decision.
        pinned = SidebarModel.arranged(pins) { row in layouts[row.hostId]?.pinnedOrder.firstIndex(of: row.session.id) }
        let ordinary = sessions.filter { $0.session.activity != .blocked && $0.session.settledOverride != "active" }
        let groups = Dictionary(grouping: ordinary) { "\($0.hostId):\($0.session.projectId ?? "")" }
        projects = groups.values.compactMap { rows in
            guard let first = rows.first else { return nil }
            let projectId = first.session.projectId ?? ""
            let order = layouts[first.hostId]?.sessionOrder[projectId]
            return SidebarProject(
                hostId: first.hostId,
                projectId: projectId,
                name: names(first) ?? "Other sessions",
                icon: icons(first),
                sessions: SidebarModel.arranged(rows) { row in order?.firstIndex(of: row.session.id) }
            )
        }.sorted { a, b in
            if a.hostId != b.hostId { return a.hostId.uuidString < b.hostId.uuidString }
            if a.hostId == b.hostId {
                let order = layouts[a.hostId]?.projectOrder ?? []
                let ar = order.firstIndex(of: a.projectId) ?? Int.max
                let br = order.firstIndex(of: b.projectId) ?? Int.max
                if ar != br { return ar < br }
            }
            let comparison = a.name.localizedStandardCompare(b.name)
            return comparison == .orderedSame ? a.id < b.id : comparison == .orderedAscending
        }
    }

    /// The desktop's `orderSessions`, to the letter: the rows somebody placed
    /// come first in that order, and the rest fall in after them in the order
    /// they arrived — which is the recency sort this list already had.
    ///
    /// A PARTITION RATHER THAN A SORT, for the reason the desktop gives: a
    /// comparator would have to answer "which of two unplaced rows comes
    /// first", and the only right answer is "whichever the merge already put
    /// first", which a comparator cannot see. The placed side carries its
    /// arrival index as a tiebreak because Swift's `sort` is not stable, and
    /// two Macs can each claim rank 0 for a row in the pinned band.
    private static func arranged(_ rows: [HostedSession], rank: (HostedSession) -> Int?) -> [HostedSession] {
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

/// Public cockpit links are portable between devices; host UUID links stay local to this installation.
extension Session {
    func cockpitURL(base: URL) -> URL {
        guard let projectId else { return base.appendingPathComponent("spool") }
        return base.appendingPathComponent("projects").appendingPathComponent(projectId)
            .appendingPathComponent("sessions").appendingPathComponent(id)
    }
}
