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

    static func rows(_ sessions: [Session], previews: Bool, carried: [SessionActivityRow] = []) -> [SessionActivityRow] {
        let active = sessions.filter { rank[$0.activity] != nil }
            .sorted { (rank[$0.activity]!, -($0.activityAt ?? 0), $0.id) < (rank[$1.activity]!, -($1.activityAt ?? 0), $1.id) }
        let projects = Dictionary(carried.map { ($0.id, $0.project) }, uniquingKeysWith: { first, _ in first })
        let live = active.map { SessionActivityRow(id: $0.id, status: status[$0.activity]!, title: previews ? SessionActivityRow.clip($0.title, 60) : nil, project: projects[$0.id] ?? nil) }
        let ids = Set(active.map(\.id))
        return Array((live + carried.filter { $0.over && !ids.contains($0.id) }).prefix(maxRows))
    }

    static func initialState(_ sessions: [Session], previews: Bool, now: Date, carried: [SessionActivityRow] = []) -> SessionActivityAttributes.ContentState {
        let shown = rows(sessions, previews: previews, carried: carried)
        let active = shown.filter { !$0.over }
        let count = sessions.filter { rank[$0.activity] != nil }.count
        let title = previews && count == 1 ? sessions.first { $0.id == active.first?.id }.map { SessionActivityRow.clip($0.title, 160) } ?? "Telar work" : count > 1 ? "\(count) active sessions" : "Telar work"
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
