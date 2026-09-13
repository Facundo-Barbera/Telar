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

/// A CONVERSATION THAT HANGS OFF THE ONE ABOVE IT — an assignment the row above
/// handed out, a session it started, or one it asked to be woken by.
struct SidebarChild: Identifiable {
    let row: HostedSession
    /// The state that still differs per child: the scope the coordinator named,
    /// "working", "finished" — or nothing, where the edge is the whole fact.
    var hint: String? = nil
    var id: ScopedSessionID { row.id }
}

/// One row of a band, and the conversations drawn underneath it.
struct SidebarRow: Identifiable {
    let row: HostedSession
    var children: [SidebarChild] = []
    var id: ScopedSessionID { row.id }
    /// This row and its children, top to bottom, as they are drawn.
    var all: [HostedSession] { [row] + children.map(\.row) }
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
    /// The group's rows AS DRAWN — each with whatever hangs off it.
    var rows: [SidebarRow]
    /// Every row this group is showing, children included.
    ///
    /// THE COUNT IS UNTOUCHED BY THE TREE, deliberately: a nested row is still a
    /// row this group draws, and subtracting it would make the header disagree
    /// with what is under it.
    var sessions: [HostedSession] { rows.flatMap(\.all) }
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
    /// The pinned band AS DRAWN — each row with whatever hangs off it.
    var pinnedRows: [SidebarRow]
    var projects: [SidebarProject]

    /// The pinned band flat, children included — what a count or a lookup wants.
    var pinned: [HostedSession] { pinnedRows.flatMap(\.all) }

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
        /// Who each session is working for, scoped by Mac — see `relatedWork`.
        assignments: [ScopedSessionID: [SessionAssignment]] = [:],
        /// Who each PINNED session asked to be woken by, scoped the same way.
        following: [ScopedSessionID: [Subscription]] = [:],
        layouts: [HostID: SidebarLayout] = [:]
    ) {
        attention = sessions.filter { $0.session.activity == .blocked }
        let pins = sessions.filter { $0.session.activity != .blocked && $0.session.settledOverride == "active" }
        /// THE ROW KEYS ARE THE MAC'S OWN. A Mac writes its own sessions into
        /// the document by bare id, which is what this phone holds for them;
        /// a row belonging to a different Mac is never in this Mac's list, so
        /// looking it up there cannot place it by somebody else's decision.
        let arrangedPins = SidebarModel.arranged(pins) { row in layouts[row.hostId]?.pinnedOrder.firstIndex(of: row.session.id) }

        /// A ROW A PINNED CONVERSATION FOLLOWS IS DRAWN UNDER IT, AND THERE ONLY
        /// — the desktop's `withholdFollowedRows`. Following is a relationship
        /// you asked for; a project group is where a row lives anyway, so the
        /// coordinator wins the copy and the group gives it up rather than the
        /// rail claiming two conversations where there is one.
        ///
        /// FIRST PINNED COORDINATOR WINS A CONTESTED ROW, in pinned order: two
        /// coordinators can follow one session, and drawing it under both would
        /// re-create exactly the duplication this removes.
        var claimed: Set<ScopedSessionID> = []
        var followed: [ScopedSessionID: [HostedSession]] = [:]
        for coordinator in arrangedPins {
            var rows: [HostedSession] = []
            for subscription in following[coordinator.id] ?? [] {
                // HOST-QUALIFIED: `targetSessionId` is a bare id, so the
                // coordinator's own Mac is the frame it is resolved in.
                let target = ScopedSessionID(hostId: coordinator.hostId, sessionId: subscription.targetSessionId)
                guard target != coordinator.id, !claimed.contains(target),
                      let row = sessions.first(where: { $0.id == target }) else { continue }
                claimed.insert(target)
                rows.append(row)
            }
            if !rows.isEmpty { followed[coordinator.id] = rows }
        }
        pinnedRows = SidebarModel.tree(arrangedPins, assignments: assignments, followed: followed)

        let ordinary = sessions.filter {
            $0.session.activity != .blocked && $0.session.settledOverride != "active" && !claimed.contains($0.id)
        }
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
                // nobody made about it. The tree is drawn over the ARRANGED
                // list, so a child follows the coordinator wherever it was put.
                rows: SidebarModel.tree(
                    SidebarModel.arranged(rows) { row in
                        layouts[row.hostId]?.sessionOrder[layoutKey]?.firstIndex(of: row.session.id)
                    },
                    assignments: assignments
                )
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

    /// Sessions doing work for one coordinator, and sessions it started — the
    /// desktop's `relatedWork` (apps/web/lib/session-list.ts).
    ///
    /// TWO DIFFERENT RELATIONSHIPS, deliberately not merged. An assignment is
    /// current work and it ends; provenance is permanent and ends nothing. A
    /// session that FINISHED a task still belongs here — under `review` — until
    /// the human settles it, because dropping it the moment its run ended would
    /// hide the very result the coordinator delegated for.
    struct RelatedWork {
        var active: [HostedSession] = []
        var review: [HostedSession] = []
        var independent: [HostedSession] = []
    }

    /// SAME MAC ONLY. An assignment's `fromSessionId` and a `startedFrom` are
    /// bare ids, meaningful only within one engine — a coordinator on one Mac
    /// gathering a stranger from another is exactly the mistake two Macs minting
    /// the same session id makes easy.
    static func relatedWork(
        _ rows: [HostedSession],
        coordinator: HostedSession,
        assignments: [ScopedSessionID: [SessionAssignment]]
    ) -> RelatedWork {
        var found = RelatedWork()
        for row in rows where row.id != coordinator.id && row.hostId == coordinator.hostId {
            let mine = (assignments[row.id] ?? []).filter { $0.fromSessionId == coordinator.session.id }
            if mine.contains(where: { $0.outcome == nil && $0.unresolved != true }) {
                found.active.append(row)
            } else if mine.contains(where: { $0.outcome != nil && $0.outcome != "detached" }) {
                found.review.append(row)
            } else if row.session.startedFrom?.sessionId == coordinator.session.id {
                found.independent.append(row)
            }
        }
        return found
    }

    /// THE TREE A FLAT LIST OF ROWS MAKES — the desktop's `relatedTree`
    /// (apps/web/components/session/related-work.tsx), and #324's shape: every
    /// related conversation renders under its coordinator as an indented child,
    /// with no caption and its state as a trailing hint.
    ///
    /// SCOPED TO THE LIST IT IS GIVEN, which the caller makes one band. A child
    /// here is a row that band would otherwise draw BESIDE its parent; taking a
    /// row out of the project it belongs to is the pinned band's own bargain
    /// (`followed`), and drawing a tree in place needs nothing of the sort.
    ///
    /// ONE LEVEL, AND FIRST POSITION WINS. A row already drawn — as somebody's
    /// child or at the top level — is never claimed again, so two coordinators
    /// delegating to one session is one row under the first of them, and a chain
    /// of delegations reads as a list under its head rather than a staircase
    /// down the rail.
    static func tree(
        _ rows: [HostedSession],
        assignments: [ScopedSessionID: [SessionAssignment]] = [:],
        /// Rows a coordinator FOLLOWS, which may come from outside `rows` — the
        /// pinned band's own claim, resolved by the caller.
        followed: [ScopedSessionID: [HostedSession]] = [:]
    ) -> [SidebarRow] {
        var nested: Set<ScopedSessionID> = []
        var drawn: Set<ScopedSessionID> = []
        var out: [SidebarRow] = []
        for row in rows where !nested.contains(row.id) {
            drawn.insert(row.id)
            var children: [SidebarChild] = []
            func claim(_ candidates: [HostedSession], hint: (HostedSession) -> String?) {
                for candidate in candidates where !nested.contains(candidate.id) && !drawn.contains(candidate.id) {
                    nested.insert(candidate.id)
                    children.append(SidebarChild(row: candidate, hint: hint(candidate)))
                }
            }
            let related = relatedWork(rows, coordinator: row, assignments: assignments)
            // THE SCOPE THE COORDINATOR ACTUALLY NAMED BEATS THE BARE STATE: it
            // says WHICH work, and "working" is then implied by there being any.
            claim(related.active) { scope(assignments[$0.id], from: row.session.id) ?? "working" }
            claim(related.review) { _ in "finished" }
            // PROVENANCE HAS NO STATE TO HINT. "Started from here" is a fact
            // about the edge, not about the row, and the elbow is now that fact.
            claim(related.independent) { _ in nil }
            claim(followed[row.id] ?? []) { _ in nil }
            out.append(SidebarRow(row: row, children: children))
        }
        return out
    }

    /// The scope of the assignment that is ACTUALLY OUTSTANDING — not the first
    /// historical one that happened to carry a scope, which would show a row the
    /// words of a task it finished last week.
    private static func scope(_ assignments: [SessionAssignment]?, from coordinatorId: EngineID) -> String? {
        assignments?.first {
            $0.fromSessionId == coordinatorId && $0.outcome == nil && $0.unresolved != true && $0.scope?.isEmpty == false
        }?.scope
    }

    /// THE PINNED BAND'S OWN SCOPE NAME — the desktop's `PINNED_ROW_SCOPE`.
    static let pinnedScope = "pinned"

    /// A ROW'S DRAG PAYLOAD, AND THAT IT CANNOT BE READ AS A GROUP'S IS THE
    /// POINT: a row carried over a project header must not look like a group
    /// being dropped there — moving a conversation into another project is a
    /// different verb, with a worktree behind it. The desktop spells the
    /// difference as a second MIME type (`SESSION_ROW_MIME`); a SwiftUI `String`
    /// transfer has one type, so the discriminator rides in the value, and a
    /// group's drop handler simply finds no group by this id.
    ///
    /// THE BAND RIDES ALONG for the same reason it does on the web: a drop
    /// target can refuse a row from somewhere else without having to look the
    /// row up. Separated by a control character, which no id or key contains.
    static func rowDragPayload(scope: String, row: ScopedSessionID) -> String {
        ["session", scope, row.hostId.uuidString, row.sessionId].joined(separator: "\u{1}")
    }

    static func rowDrag(_ payload: String) -> (scope: String, row: ScopedSessionID)? {
        let parts = payload.components(separatedBy: "\u{1}")
        guard parts.count == 4, parts[0] == "session", let hostId = UUID(uuidString: parts[2]), !parts[3].isEmpty else { return nil }
        return (parts[1], ScopedSessionID(hostId: hostId, sessionId: parts[3]))
    }

    /// THE ORDER AFTER A DROP: `dragged` lands above `target` in the list AS
    /// DRAWN, and the whole drawn list is what comes back — so every row on
    /// screen keeps the place it had, not only the one that moved. A row nobody
    /// had placed is thereby placed too, which is what stops it drifting back up
    /// the next time something happens to it. The desktop's `movedOrder`
    /// (apps/web/lib/session-groups.ts), less the "below" half a `.dropDestination`
    /// cannot report.
    ///
    /// ONE BAND AT A TIME, ENFORCED BY WHAT THIS TAKES. It is handed one band's
    /// drawn keys; a row dropped somewhere else is not among them, the anchor is
    /// not found, and the drawn order comes back unchanged.
    static func moved(_ drawn: [String], dragged: String, target: String) -> [String] {
        var without = drawn.filter { $0 != dragged }
        guard dragged != target, drawn.contains(dragged), let anchor = without.firstIndex(of: target) else { return drawn }
        without.insert(dragged, at: anchor)
        return without
    }

    /// KEYS THE RAIL IS NOT DRAWING KEEP THEIR SLOT — a row on a shelf, a
    /// project with nothing live, a Mac that is away. Each stored key that is
    /// absent from the drawn list falls in just after the last stored key that
    /// was present, rather than being pruned by a drag that had nothing to do
    /// with it. The tail of the desktop's `movedOrder`, applied against the
    /// document as it was RE-READ rather than as this phone remembered it.
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
