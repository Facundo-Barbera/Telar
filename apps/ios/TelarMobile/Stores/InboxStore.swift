import Foundation
import Observation

/// t3 mobile's thread-list model: ONE flat list, two blocks. The active block
/// is sorted by createdAt descending and ACTIVITY NEVER REORDERS IT — a row
/// holds its position from open until settled, because a list that reorders
/// itself while you read it is not a list. Status is carried per row as a
/// colored label, not as sections. The settled tail (snoozed rides with it)
/// recedes into slim rows below a "Settled" divider.
struct InboxSections: Equatable {
    var active: [Session] = []
    /// Snoozed first (they come back), then settled — both slim.
    var snoozed: [Session] = []
    var settled: [Session] = []

    var tail: [Session] { snoozed + settled }
    var isEmpty: Bool { active.isEmpty && snoozed.isEmpty && settled.isEmpty }
}

func groupInbox(_ sessions: [Session], now: Timestamp, autoSettleAfterHours: Double?) -> InboxSections {
    var sections = InboxSections()
    for session in sessions {
        // The full three-layer rule (Settling.swift), not just the pin —
        // most settled sessions are settled by the inactivity clock.
        if Settling.isSnoozed(session, now: now) {
            sections.snoozed.append(session)
        } else if Settling.isSettled(session, now: now, autoSettleAfterHours: autoSettleAfterHours) {
            sections.settled.append(session)
        } else {
            sections.active.append(session)
        }
    }
    sections.active.sort { $0.createdAt > $1.createdAt }
    sections.snoozed.sort { $0.updatedAt > $1.updatedAt }
    sections.settled.sort { $0.updatedAt > $1.updatedAt }
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
    /// The engine's default (3 days) until the real policy arrives; a policy
    /// fetch failure keeps the last known answer rather than rebanding.
    private var autoSettleAfterHours: Double? = 72

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

    /// Settle or unsettle straight off a row — a context-menu action, so the
    /// refresh must be immediate rather than waiting for the next poll.
    func setSettled(_ id: EngineID, _ settled: Bool) async {
        do {
            try await api.patchSession(id, patch: SessionPatch(settledOverride: settled ? "settled" : "active"))
            await refresh()
        } catch {
            lastError = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func refresh() async {
        do {
            let live = try await api.liveSessions()
            if let policy = try? await api.inboxPolicy() {
                autoSettleAfterHours = policy.autoSettleAfterHours
            }
            projectNames = Dictionary(uniqueKeysWithValues: live.projects.map { ($0.id, $0.name) })
            sections = groupInbox(
                live.sessions,
                now: Timestamp(Date().timeIntervalSince1970 * 1000),
                autoSettleAfterHours: autoSettleAfterHours
            )
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
