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

/// PURE — a read receipt's answer, folded into whichever band holds that row.
///
/// THE BANDING IS DELIBERATELY LEFT ALONE. Re-running `groupInbox` here would
/// be the obvious thing and the wrong one: the row would be free to jump to
/// another shelf under the reader, at the exact moment they are reading it. It
/// also cannot be needed — `Settling.idleSince` counts from `readAt`, so a
/// receipt RESTARTS the inactivity clock rather than expiring it, and the next
/// poll re-bands from the Mac's own word anyway.
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

/// One Mac's inbox. THE LAST READ SURVIVES THE MAC: a store built with a
/// cache opens on what this phone last recorded for that Mac — stamped
/// `recordedAt` so a row can dim itself and a banner can say when — and keeps
/// showing it while the Mac is away. A failed refresh changes `lastError`
/// and nothing else; the rows stay.
@MainActor @Observable final class InboxStore {
    private(set) var sections = InboxSections()
    private(set) var projectNames: [EngineID: String] = [:]
    /// The projects as the Mac listed them — name AND icon key — so a row can
    /// draw the project's mark, not just say its name.
    private(set) var projects: [EngineID: ProjectRef] = [:]
    private(set) var lastError: String?
    /// A retry can't fix a credential — the merged view escalates this one.
    private(set) var unauthorized = false
    private(set) var loaded = false
    /// When what is shown was recorded by this phone; nil once the Mac has
    /// answered in this session of the app.
    private(set) var recordedAt: Timestamp?
    /// WHERE THIS MAC PUTS THINGS — see `SidebarLayout`. It rides the live read
    /// this store already makes, so a drag on the Mac (or in a browser tab on
    /// it) reaches the phone on the next poll without a request, a timer or a
    /// connection of its own.
    private(set) var layout = SidebarLayout()
    /// WHO EACH SESSION IS WORKING FOR, by session id — folded by the engine
    /// over each session's whole queue and carried on the live read, so the
    /// rail's tree costs no request of its own. Empty from a cockpit that does
    /// not forward the field, which draws the flat list this rail always had.
    private(set) var assignments: [EngineID: [SessionAssignment]] = [:]
    /// Who the PINNED conversations have asked to be woken by, by session id.
    /// A bounded read — see `readFollowing`.
    private(set) var following: [EngineID: [Subscription]] = [:]

    /// Which Mac this store polls; the merged inbox keys by it.
    let hostId: HostID
    private let api: any EngineAPI
    private let cache: HostSnapshotCache?
    private var loop: Task<Void, Never>?
    /// The cache read seeding the first frame — off the main thread, the
    /// same reason as SessionSyncEngine's.
    private var restoring: Task<Void, Never>?
    private var anythingLive = false
    /// The engine's default (3 days) until the real policy arrives; a policy
    /// fetch failure keeps the last known answer rather than rebanding.
    private var autoSettleAfterHours: Double? = 72
    /// The policy is one answer per machine and changes by hand, so it is
    /// re-read once a minute, not on every three-second poll — against a Mac
    /// that is slow to answer, the second request per poll was the one that
    /// kept the list a poll behind.
    private var policyReadAt: ContinuousClock.Instant?
    /// The same once-a-minute rule, for the same reason — but only against a
    /// Mac too old to send the layout on its live read. One that does send it
    /// stamps this on every poll, so the extra request is never made.
    private var layoutReadAt: ContinuousClock.Instant?
    /// The pinned set the subscriptions in hand were read for, and when.
    private var followingFor: Set<EngineID> = []
    private var followingReadAt: ContinuousClock.Instant?
    private var lastInboxData: Data?

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

    /// A read receipt landed on a session this store lists. Clear its dot NOW.
    ///
    /// THE POLL IS TOO SLOW TO BE THE ANSWER HERE, and on the iPad that is
    /// visible rather than theoretical: the sidebar and the transcript are on
    /// screen together, so a reader opening a session with an unread answer
    /// watched the dot sit there for up to ten seconds and then go out as they
    /// moved away — which reads as "it clears when you LEAVE", the opposite of
    /// what it means. (On the phone the sidebar is hidden while you read, so
    /// the poll always landed before anyone could see it.) The same reason
    /// `setSettled` refreshes instead of waiting.
    ///
    /// IN PLACE RATHER THAN A REFRESH. A refresh would be a whole extra round
    /// trip to the Mac to learn one number this call is already holding, and it
    /// would be the SLOWER of the two on exactly the connection where this
    /// matters most. The fold is monotonic, so a poll already carrying a higher
    /// mark cannot be dragged backwards by it.
    func applyRead(_ sessionId: EngineID, answer: Session) {
        let folded = applyReadMark(sections, sessionId: sessionId, answer: answer.readMark)
        guard folded != sections else { return }
        sections = folded
    }

    /// A drop on THIS phone, drawn now rather than a poll later — the same
    /// reason `applyRead` exists, and the same monotonic caution: the write's
    /// own answer lands here too, so the optimistic guess is replaced by the
    /// Mac's word a moment later rather than living on beside it.
    func applyLayout(_ next: SidebarLayout) {
        guard next != layout else { return }
        layout = next
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

    /// The first frame, from the phone's own copy. `loaded` stays false: the
    /// rows are shown, but "nothing here" is not a claim this copy can make.
    /// Read and decoded off the main thread; only the rows land.
    private func restore() {
        guard let cache else { return }
        restoring = Task.detached(priority: .userInitiated) { [weak self] in
            guard let entry = cache.readInbox(),
                  let live = try? JSONDecoder().decode(LiveSessions.self, from: entry.data)
            else { return }
            await self?.applyRestored(live, entry: entry)
        }
    }

    /// The Mac may have answered first — its word wins.
    private func applyRestored(_ live: LiveSessions, entry: SnapshotCache.Entry) {
        guard !loaded else { return }
        lastInboxData = entry.data
        recordedAt = entry.savedAt
        apply(live)
    }

    /// Tests: wait for the cache read to land.
    func awaitPendingWork() async {
        await restoring?.value
    }

    func refresh() async {
        do {
            let live = try await api.liveSessions()
            if policyReadAt.map({ $0.duration(to: .now) > .seconds(60) }) ?? true,
               let policy = try? await api.inboxPolicy() {
                autoSettleAfterHours = policy.autoSettleAfterHours
                policyReadAt = .now
            }
            // THE ARRANGEMENT COSTS NOTHING WHEN IT RIDES ALONG, and the ask is
            // only for a Mac whose engine predates that — rationed like the
            // policy above, because against a slow Mac a second request per
            // three-second poll is what keeps the list a poll behind.
            if live.layout != nil {
                layoutReadAt = .now
            } else if layoutReadAt.map({ $0.duration(to: .now) > .seconds(60) }) ?? true,
                      let fetched = try? await api.sidebarLayout() {
                layout = fetched
                layoutReadAt = .now
            }
            apply(live)
            await readFollowing()
            lastError = nil
            unauthorized = false
            loaded = true
            recordedAt = nil
            remember()
        } catch {
            lastError = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
            unauthorized = (error as? EngineAPIError)?.isUnauthorized == true
        }
    }

    /// WHO THE PINNED CONVERSATIONS FOLLOW — one read per pinned row, and only
    /// the pinned rows.
    ///
    /// A SUBSCRIPTION IS NOT ON THE LIVE LIST, unlike an assignment: it lives in
    /// an engine-wide file rather than on either session, so there is no fold
    /// over the inbox that could carry it. Pinned is the handful a person keeps
    /// in view, so asking per pinned row is bounded where asking per row of the
    /// list would be an N+1 over the whole inbox, every poll.
    ///
    /// RATIONED, like the policy and the layout above: re-read when the pinned
    /// SET changes, and otherwise every fifteen seconds — an agent can add,
    /// remove or consume a `once` subscription while the same conversations stay
    /// pinned, which a set-keyed read alone would never notice. A read that
    /// fails leaves the last answer standing; a Mac being slow must not empty
    /// the tree it already drew.
    private func readFollowing() async {
        let pinned = Set(sections.active.filter { $0.settledOverride == "active" }.map(\.id))
        guard !pinned.isEmpty else {
            following = [:]
            followingFor = []
            followingReadAt = nil
            return
        }
        let stale = followingReadAt.map { $0.duration(to: .now) > .seconds(15) } ?? true
        guard pinned != followingFor || stale else { return }
        var next: [EngineID: [Subscription]] = [:]
        for id in pinned {
            guard let held = try? await api.sessionSubscriptions(id), !held.isEmpty else { continue }
            next[id] = held
        }
        following = next
        followingFor = pinned
        followingReadAt = .now
    }

    private func apply(_ live: LiveSessions) {
        // The Mac's own word about where things sit. Absent means an engine
        // that cannot say, never "nobody has arranged anything" — so the copy
        // already held survives rather than being blanked every poll.
        if let arrangement = live.layout { layout = arrangement }
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

    /// The bytes of the read that just succeeded, kept for next time. A
    /// second small GET rather than a re-encode — see SessionSyncEngine.
    private func remember() {
        guard let cache else { return }
        let api = self.api
        Task.detached(priority: .utility) { [weak self] in
            guard let data = try? await api.liveSessionsData() else { return }
            await self?.store(data, in: cache)
        }
    }

    private func store(_ data: Data, in cache: HostSnapshotCache) {
        if data == lastInboxData { return }
        lastInboxData = data
        cache.writeInbox(data)
    }
}
