import Foundation
import Observation

/// The inbox sections, in the order a reader scans: what needs me, what is
/// moving, what is quiet. Grouping is a pure function so it is testable.
struct InboxSections: Equatable {
    var needsYou: [Session] = []
    var working: [Session] = []
    var quiet: [Session] = []
    /// Snoozed or settled — behind "Show all".
    var hidden: [Session] = []

    var isEmpty: Bool { needsYou.isEmpty && working.isEmpty && quiet.isEmpty && hidden.isEmpty }
}

func groupInbox(_ sessions: [Session], now: Timestamp) -> InboxSections {
    var sections = InboxSections()
    for session in sessions {
        let snoozed = (session.snoozedUntil ?? 0) > now
        let settled = session.settledOverride == "settled"
        if snoozed || settled {
            sections.hidden.append(session)
        } else if session.activity == .blocked || session.lastTurnFailed == true {
            sections.needsYou.append(session)
        } else if session.activity == .working || session.activity == .queued || session.activity == .monitoring {
            sections.working.append(session)
        } else {
            sections.quiet.append(session)
        }
    }
    // Within a band: most actionable first (server-derived rank), then recency.
    let byActivityThenRecency: (Session, Session) -> Bool = {
        ($0.activity, -$0.updatedAt) < ($1.activity, -$1.updatedAt)
    }
    sections.needsYou.sort(by: byActivityThenRecency)
    sections.working.sort(by: byActivityThenRecency)
    sections.quiet.sort { $0.updatedAt > $1.updatedAt }
    sections.hidden.sort { $0.updatedAt > $1.updatedAt }
    return sections
}

@MainActor @Observable final class InboxStore {
    private(set) var sections = InboxSections()
    private(set) var projectNames: [EngineID: String] = [:]
    private(set) var lastError: String?
    private(set) var loaded = false

    private let api: any EngineAPI
    private var loop: Task<Void, Never>?
    private var anythingLive = false

    init(api: any EngineAPI) {
        self.api = api
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                // 3s while anything is live, 10s when the whole list idles.
                let lively = self?.anythingLive ?? false
                try? await Task.sleep(for: .seconds(lively ? 3 : 10))
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    func refresh() async {
        do {
            let live = try await api.liveSessions()
            projectNames = Dictionary(uniqueKeysWithValues: live.projects.map { ($0.id, $0.name) })
            sections = groupInbox(live.sessions, now: Timestamp(Date().timeIntervalSince1970 * 1000))
            anythingLive = live.sessions.contains {
                $0.activity == .blocked || $0.activity == .working || $0.activity == .queued
            }
            lastError = nil
            loaded = true
        } catch {
            lastError = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
