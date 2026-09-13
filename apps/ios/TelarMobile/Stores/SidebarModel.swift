import Foundation

/// ONE MAC'S REGISTRATION OF A PROJECT — the Mac, that Mac's own id for the
/// project, and the name and icon that Mac gave it.
///
/// A group has one of these ordinarily and TWO once the same repository is
/// checked out on two paired Macs. The ids are minted per engine, so the mini's
/// copy is `project_9f…` there and `project_2a…` on the laptop, and a New
/// conversation built from one of them opens nothing on the other — which is
/// why the header needs the list rather than the group's own pair. Mirrors the
/// desktop's `ProjectPlace` (apps/web/lib/hosts/project-places.ts).
struct ProjectPlace: Identifiable, Equatable {
    let hostId: HostID
    let projectId: String
    var name: String
    var icon: String? = nil
    var id: String { "\(hostId.uuidString):\(projectId)" }
}

struct SidebarProject: Identifiable {
    /// THE GROUP'S IDENTITY ON THIS PHONE — what `collapsed`, `projectFilter`
    /// and a drag all key by. `repo:<host>/<owner>/<repo>` for a group folded on
    /// its repository, and this Mac's `hostId:projectId` otherwise; a merged
    /// group must not be identified by one of its two Macs' pairs.
    let id: String
    /// THE KEY A MAC'S OWN LAYOUT DOCUMENT USES for this group, which is NOT
    /// `id`: a cockpit writes its own projects by bare id (see `SidebarLayout`),
    /// so a phone-minted host UUID would never match anything in it. `repo:…`
    /// where the desktop folds on the repository, and the bare project id
    /// otherwise — the desktop's `projectGroupKey` read from that Mac's side.
    let layoutKey: String
    /// The group's default destination: the first of `places`.
    let hostId: HostID
    let projectId: String
    let name: String
    /// `ProjectRef.icon`, when the Mac listed one.
    var icon: String? = nil
    /// Every Mac this group lives on, in a stable order. One entry ordinarily;
    /// two when a repository is checked out on two of them.
    var places: [ProjectPlace] = []
    var sessions: [HostedSession]
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
        /// `ProjectRef.remoteUrl` for a row's project — the repository two Macs
        /// fold on. Absent is an ordinary answer; see `groupKey`.
        remotes: (HostedSession) -> String? = { _ in nil },
        /// What to call each Mac. Only used to give the places a stable reading
        /// order, so a badge list does not re-shuffle itself between polls.
        hostNames: (HostID) -> String? = { _ in nil },
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
        let groups = Dictionary(grouping: ordinary) { row in
            SidebarModel.groupKey(hostId: row.hostId, projectId: row.session.projectId ?? "", remote: remotes(row))
        }
        projects = groups.compactMap { key, rows -> SidebarProject? in
            let places = SidebarModel.places(rows, names: names, icons: icons, hostNames: hostNames)
            guard let first = places.first else { return nil }
            // A group folded on its repository is keyed that way in every Mac's
            // document; one that was not is keyed by the bare project id, and
            // then it has exactly one place to take it from.
            let layoutKey = key.hasPrefix(SidebarModel.repoPrefix) ? key : first.projectId
            return SidebarProject(
                id: key,
                layoutKey: layoutKey,
                hostId: first.hostId,
                projectId: first.projectId,
                name: first.name,
                icon: first.icon,
                places: places,
                // EACH ROW BY ITS OWN MAC'S LIST, even inside a merged group:
                // the two documents are two decisions, and reading one Mac's
                // rank for the other Mac's row would place it by a decision
                // nobody made about it.
                sessions: SidebarModel.arranged(rows) { row in
                    layouts[row.hostId]?.sessionOrder[layoutKey]?.firstIndex(of: row.session.id)
                }
            )
        }.sorted { a, b in
            let ar = SidebarModel.rank(a, layouts: layouts)
            let br = SidebarModel.rank(b, layouts: layouts)
            if ar != br { return ar < br }
            let comparison = a.name.localizedStandardCompare(b.name)
            return comparison == .orderedSame ? a.id < b.id : comparison == .orderedAscending
        }
    }

    /// A group folded on its repository wears this. Not decoration: a reduced
    /// remote is `host/owner/repo` and a per-Mac key is `hostId:projectId`, so
    /// without it a Mac whose id read `github.com` and a project id `owner/repo`
    /// would collide with the repository of that name.
    static let repoPrefix = "repo:"

    /// WHICH GROUP A ROW BELONGS TO — the repository it is work on when the row
    /// can name one, and this Mac's registration of it otherwise. The desktop's
    /// `projectGroupKey` (apps/web/lib/session-groups.ts), and it has to agree
    /// with it: the `repo:` half is what makes the phone's fold and the Mac's
    /// the same fold.
    ///
    /// TWO MACS' CHECKOUTS OF ONE REPOSITORY ARE ONE PROJECT, because that is
    /// what they are to the person looking at them. Keyed by host and project id
    /// they were two groups with one name, told apart only by a badge, and the
    /// reader had to remember which Mac they last started something on to find
    /// the conversation they wanted.
    ///
    /// A ROW THAT CANNOT NAME A REPOSITORY KEEPS THE OLD KEY, and that is the
    /// important half. Folding two originless projects on their NAME would merge
    /// two unrelated folders both called `scratch`, which is a worse failure than
    /// the one this fixes — so the absence of an answer is never an answer.
    static func groupKey(hostId: HostID, projectId: String, remote: String?) -> String {
        if let remote, !remote.isEmpty { return "\(repoPrefix)\(remote)" }
        return "\(hostId.uuidString):\(projectId)"
    }

    /// Every Mac a group's rows came from, this list's own stable order: by the
    /// Mac's name, then by ids so two Macs with one name still never swap.
    private static func places(
        _ rows: [HostedSession],
        names: (HostedSession) -> String?,
        icons: (HostedSession) -> String?,
        hostNames: (HostID) -> String?
    ) -> [ProjectPlace] {
        var found: [String: ProjectPlace] = [:]
        for row in rows {
            let place = ProjectPlace(
                hostId: row.hostId,
                projectId: row.session.projectId ?? "",
                name: names(row) ?? "Other sessions",
                icon: icons(row)
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

    /// WHERE THE READER PUT THIS GROUP — the lowest rank any of its Macs gives
    /// it, and `Int.max` for one nobody has placed.
    ///
    /// THE GROUPS ARE NO LONGER BLOCKED BY MAC, and that is forced rather than
    /// chosen: a group that lives on two Macs cannot sit inside either one's
    /// block. So the rail is arranged the way the desktop arranges it
    /// (`orderProjectGroups`) — placed groups first in that order, the rest
    /// alphabetically after them — and a Mac's own groups stay together only
    /// because its document says so.
    private static func rank(_ group: SidebarProject, layouts: [HostID: SidebarLayout]) -> Int {
        group.places
            .compactMap { layouts[$0.hostId]?.projectOrder.firstIndex(of: group.layoutKey) }
            .min() ?? Int.max
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
