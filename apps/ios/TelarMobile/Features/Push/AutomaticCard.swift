import Foundation

enum AutomaticCard {
    static let sessionId = "__automatic__"

    struct Shown {
        var id: String
        var hostId: String
        var sessionId: String
        var startedAt: Date
    }

    static func hostsToStart(enabled: Bool, working: Set<HostID>, carded: Set<HostID>, dismissed: Set<HostID>, engineStarts: Set<HostID>) -> Set<HostID> {
        enabled ? working.subtracting(carded).subtracting(dismissed).subtracting(engineStarts) : []
    }

    static func engineStarts(_ report: ActivityReport) -> Bool {
        report.blocker == nil && (report.lastStart.map { $0.status == 200 } ?? true)
    }

    static func duplicates(_ cards: [Shown]) -> Set<String> {
        var newest: [String: Shown] = [:]
        for card in cards where card.sessionId == sessionId {
            if let kept = newest[card.hostId], (kept.startedAt, kept.id) >= (card.startedAt, card.id) { continue }
            newest[card.hostId] = card
        }
        return Set(cards.map(\.id)).subtracting(newest.values.map(\.id))
    }

    static func dismissedStillIdle(_ dismissed: Set<HostID>, working: Set<HostID>) -> Set<HostID> {
        dismissed.intersection(working)
    }

    static let maxRows = 4
    private static let rank: [SessionActivity: Int] = [.blocked: 0, .working: 1, .queued: 2, .monitoring: 3]
    private static let status: [SessionActivity: String] = [.blocked: "Needs you", .working: "Working", .queued: "Queued", .monitoring: "Background"]

    static func families(_ sessions: [Session]) -> [(root: Session, active: [Session])] {
        let byId = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        func root(_ session: Session) -> Session {
            var seen: Set<String> = [session.id]
            var current = session
            while let parent = current.startedFrom.flatMap({ byId[$0.sessionId] }) {
                guard seen.insert(parent.id).inserted else { return session }
                current = parent
            }
            return current
        }
        var order: [String] = []
        var active: [String: [Session]] = [:]
        for session in sessions {
            let top = root(session).id
            if active[top] == nil { order.append(top); active[top] = [] }
            if rank[session.activity] != nil { active[top]!.append(session) }
        }
        return order.compactMap { id in active[id]!.isEmpty ? nil : (byId[id]!, active[id]!) }
    }

    static func rows(_ sessions: [Session], previews: Bool, carried: [SessionActivityRow] = []) -> [SessionActivityRow] {
        let key = { (members: [Session]) in (members.map { rank[$0.activity]! }.min()!, -(members.compactMap(\.activityAt).max() ?? 0)) }
        let active = families(sessions).sorted { (key($0.active).0, key($0.active).1, $0.root.id) < (key($1.active).0, key($1.active).1, $1.root.id) }
        let projects = Dictionary(carried.map { ($0.id, $0.project) }, uniquingKeysWith: { first, _ in first })
        let live = active.map { family in
            let title = family.root.title.trimmingCharacters(in: .whitespacesAndNewlines)
            let workers = family.active.filter { $0.id != family.root.id }.count
            return SessionActivityRow(id: family.root.id, status: status[family.active.min { rank[$0.activity]! < rank[$1.activity]! }!.activity]!,
                                      title: previews && !title.isEmpty ? SessionActivityRow.clip(title, 60) : nil,
                                      project: projects[family.root.id] ?? nil, workers: workers > 0 ? workers : nil)
        }
        let ids = Set(active.map(\.root.id))
        return Array((live + carried.filter { $0.over && !ids.contains($0.id) }).prefix(maxRows))
    }

    static func initialState(_ sessions: [Session], previews: Bool, now: Date, carried: [SessionActivityRow] = []) -> SessionActivityAttributes.ContentState {
        let shown = rows(sessions, previews: previews, carried: carried)
        let active = shown.filter { !$0.over }
        let count = families(sessions).count
        let lead = sessions.first { $0.id == active.first?.id }?.title.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let title = previews && count == 1 && !lead.isEmpty ? SessionActivityRow.clip(lead, 160) : count > 1 ? "\(count) active sessions" : "Telar work"
        return .init(title: title, status: active.first?.status ?? "Working", updatedAt: now, startedAt: now, ended: false,
                     sessionId: shown.first?.id, activeCount: count, rows: shown)
    }

    static func refreshed(_ current: SessionActivityAttributes.ContentState, _ sessions: [Session], previews: Bool, now: Date) -> SessionActivityAttributes.ContentState? {
        var next = initialState(sessions, previews: previews, now: now, carried: current.rows ?? [])
        next.startedAt = current.startedAt
        let same = (next.title, next.status, next.sessionId, next.activeCount, next.rows) == (current.title, current.status, current.sessionId, current.activeCount, current.rows)
        return same ? nil : next
    }
}
