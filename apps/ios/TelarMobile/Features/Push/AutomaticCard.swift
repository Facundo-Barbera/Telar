import Foundation

/**
 THE AUTOMATIC CARD, STARTED BY THE PHONE ITSELF.

 Push-to-start needs a token iOS hands over when it chooses, and on the
 owner's phone it never did: `pushToStartToken` stayed nil and
 `pushToStartTokenUpdates` never yielded, so no Mac could start a card.
 `Activity.request` has no such dependency. While Telar is open and a Mac has
 work, the phone starts that Mac's `__automatic__` card with `pushType: .token`
 and registers the card's own push token; the Mac then updates and ends it
 exactly as it does a card it started. Push-to-start stays as the way a card
 starts while Telar is closed.

 A card the person dismissed is not started again until that Mac's work has
 gone idle, so swiping it away sticks.
 */
enum AutomaticCard {
    static let sessionId = "__automatic__"

    /// Macs that should get a card now: work on them, none showing, none dismissed this stretch.
    static func hostsToStart(enabled: Bool, working: Set<HostID>, carded: Set<HostID>, dismissed: Set<HostID>) -> Set<HostID> {
        enabled ? working.subtracting(carded).subtracting(dismissed) : []
    }

    /// A dismissal is forgotten once that Mac has no work, so the next stretch gets a card.
    static func dismissedStillIdle(_ dismissed: Set<HostID>, working: Set<HostID>) -> Set<HostID> {
        dismissed.intersection(working)
    }

    /// The first content, until the Mac's first update replaces it.
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

    /// What a showing card should read now, from what the open app already
    /// knows — or nil when nothing on it would change. The Mac's push is
    /// delivered when iOS chooses; the app in the foreground need not wait for it.
    static func refreshed(_ current: SessionActivityAttributes.ContentState, _ sessions: [Session], previews: Bool, now: Date) -> SessionActivityAttributes.ContentState? {
        var next = initialState(sessions, previews: previews, now: now)
        next.startedAt = current.startedAt
        let same = (next.title, next.status, next.sessionId, next.activeCount) == (current.title, current.status, current.sessionId, current.activeCount)
        return same ? nil : next
    }
}
