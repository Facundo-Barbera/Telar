import Foundation

enum AutomaticCard {
    static let sessionId = "__automatic__"

    static func hostsToStart(enabled: Bool, working: Set<HostID>, carded: Set<HostID>, dismissed: Set<HostID>) -> Set<HostID> {
        enabled ? working.subtracting(carded).subtracting(dismissed) : []
    }

    static func dismissedStillIdle(_ dismissed: Set<HostID>, working: Set<HostID>) -> Set<HostID> {
        dismissed.intersection(working)
    }

    static func initialState(_ sessions: [Session], previews: Bool, now: Date) -> SessionActivityAttributes.ContentState {
        let rank: [SessionActivity: Int] = [.blocked: 0, .working: 1, .queued: 2, .monitoring: 3]
        let active = sessions.filter { rank[$0.activity] != nil }
            .sorted { (rank[$0.activity]!, $0.id) < (rank[$1.activity]!, $1.id) }
        let focus = active.first
        let title = previews && active.count == 1 ? focus!.title : active.count > 1 ? "\(active.count) active sessions" : "Telar work"
        let status = switch focus?.activity {
        case .blocked: "Needs you"
        case .queued: "Queued"
        case .monitoring: "Background"
        default: "Working"
        }
        return .init(title: title, status: status, updatedAt: now, startedAt: now, ended: false, sessionId: focus?.id, activeCount: active.count)
    }

    static func refreshed(_ current: SessionActivityAttributes.ContentState, _ sessions: [Session], previews: Bool, now: Date) -> SessionActivityAttributes.ContentState? {
        var next = initialState(sessions, previews: previews, now: now)
        next.startedAt = current.startedAt
        let same = (next.title, next.status, next.sessionId, next.activeCount) == (current.title, current.status, current.sessionId, current.activeCount)
        return same ? nil : next
    }
}
