import Foundation
import Observation

struct InboxSections: Equatable {
    var active: [Session] = []

    var snoozed: [Session] = []
    var settled: [Session] = []

    var tail: [Session] { snoozed + settled }
    var isEmpty: Bool { active.isEmpty && snoozed.isEmpty && settled.isEmpty }
}

func groupInbox(_ sessions: [Session], now: Timestamp, autoSettleAfterHours: Double?) -> InboxSections {
    var sections = InboxSections()
    for session in sessions {
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

func applyReadMark(_ sections: InboxSections, sessionId: EngineID, answer: ReadMark) -> InboxSections {
    func fold(_ rows: [Session]) -> [Session] {
        rows.map { row in
            guard row.id == sessionId else { return row }
            var next = row
            next.applyReadMark(answer)
            return next
        }
    }
    var next = sections
    next.active = fold(sections.active)
    next.snoozed = fold(sections.snoozed)
    next.settled = fold(sections.settled)
    return next
}

@MainActor @Observable final class InboxStore {
    private(set) var sections = InboxSections()
    private(set) var projectNames: [EngineID: String] = [:]

    private(set) var projects: [EngineID: ProjectRef] = [:]
    private(set) var lastError: String?

    private(set) var unauthorized = false
    private(set) var loaded = false

    private(set) var recordedAt: Timestamp?

    private(set) var layout = SidebarLayout()

    private(set) var assignments: [EngineID: [SessionAssignment]] = [:]

    let hostId: HostID
    private let api: any EngineAPI
    private let cache: HostSnapshotCache?
    private var loop: Task<Void, Never>?

    private var restoring: Task<Void, Never>?

    private var recording: Task<Void, Never>?
    private var anythingLive = false

    private var autoSettleAfterHours: Double? = 72

    private var policyReadAt: ContinuousClock.Instant?

    private var layoutReadAt: ContinuousClock.Instant?
    private var lastInboxData: Data?

    private var revision: Int?

    private var etag: String?

    private(set) var shelvedOnMac = 0

    private var wantsSettled = false

    init(api: any EngineAPI, hostId: HostID = HostID(), cache: HostSnapshotCache? = nil) {
        self.api = api
        self.hostId = hostId
        self.cache = cache
        restore()
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()

                let lively = self?.anythingLive ?? false
                try? await Task.sleep(for: .seconds(lively ? 3 : 10))
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    func applyRead(_ sessionId: EngineID, answer: Session) {
        let folded = applyReadMark(sections, sessionId: sessionId, answer: answer.readMark)
        guard folded != sections else { return }
        sections = folded
    }

    func applyLayout(_ next: SidebarLayout) {
        guard next != layout else { return }
        layout = next
    }

    func setSettled(_ id: EngineID, _ settled: Bool) async {
        do {
            try await api.patchSession(id, patch: SessionPatch(settledOverride: settled ? "settled" : "active"))
            await refresh()
        } catch {
            lastError = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func restore() {
        guard let cache else { return }
        restoring = Task.detached(priority: .userInitiated) { [weak self] in
            guard let entry = cache.readInbox(),
                  let live = try? JSONDecoder().decode(LiveSessions.self, from: entry.data)
            else { return }
            await self?.applyRestored(live, entry: entry)
        }
    }

    private func applyRestored(_ live: LiveSessions, entry: SnapshotCache.Entry) {
        guard !loaded else { return }
        lastInboxData = entry.data
        recordedAt = entry.savedAt
        apply(live)
    }

    func awaitPendingWork() async {
        await restoring?.value
        await recording?.value
    }

    func refresh() async {
        do {
            let answer: LiveSessionsRead
            if etag == nil, !wantsSettled, let cursor = revision {
                answer = try await api.liveSessions(matching: nil, since: cursor, all: false)
            } else {
                answer = try await api.liveSessions(matching: etag, since: nil, all: wantsSettled)
            }
            etag = answer.etag
            guard let live = answer.live else {
                lastError = nil
                unauthorized = false
                loaded = true
                recordedAt = nil
                return
            }
            revision = live.revision
            if live.unchanged {
                lastError = nil
                unauthorized = false
                loaded = true
                recordedAt = nil
                return
            }

            if let policy = live.inbox {
                autoSettleAfterHours = policy.autoSettleAfterHours
                policyReadAt = .now
            } else if policyReadAt.map({ $0.duration(to: .now) > .seconds(60) }) ?? true,
                      let policy = try? await api.inboxPolicy() {
                autoSettleAfterHours = policy.autoSettleAfterHours
                policyReadAt = .now
            }

            if live.layout != nil {
                layoutReadAt = .now
            } else if layoutReadAt.map({ $0.duration(to: .now) > .seconds(60) }) ?? true,
                      let fetched = try? await api.sidebarLayout() {
                layout = fetched
                layoutReadAt = .now
            }
            apply(live)
            lastError = nil
            unauthorized = false
            loaded = true
            recordedAt = nil
            remember(answer.data)
        } catch {
            lastError = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
            unauthorized = (error as? EngineAPIError)?.isUnauthorized == true
        }
    }

    func showSettled() async {
        guard !wantsSettled else { return }
        wantsSettled = true
        await refresh()
    }

    private func apply(_ live: LiveSessions) {
        if let arrangement = live.layout { layout = arrangement }

        shelvedOnMac = live.settledCount ?? 0
        projectNames = Dictionary(uniqueKeysWithValues: live.projects.map { ($0.id, $0.name) })
        projects = Dictionary(uniqueKeysWithValues: live.projects.map { ($0.id, $0) })
        assignments = live.assignments
        sections = groupInbox(
            live.sessions,
            now: Timestamp(Date().timeIntervalSince1970 * 1000),
            autoSettleAfterHours: autoSettleAfterHours
        )
        anythingLive = live.sessions.contains {
            $0.activity == .blocked || $0.activity == .working || $0.activity == .queued
        }
    }

    private func remember(_ data: Data?) {
        guard let cache, let data, data != lastInboxData else { return }
        lastInboxData = data
        recording = Task.detached(priority: .utility) { cache.writeInbox(data) }
    }
}
