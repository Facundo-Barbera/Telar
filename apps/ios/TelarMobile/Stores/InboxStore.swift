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

    /// Which Mac this store polls; the merged inbox keys by it.
    let hostId: HostID
    private let api: any EngineAPI
    private let cache: HostSnapshotCache?
    private var loop: Task<Void, Never>?
    /// The cache read seeding the first frame — off the main thread, the
    /// same reason as SessionSyncEngine's.
    private var restoring: Task<Void, Never>?
    /// The cache WRITE in flight, held only so the tests can wait for it.
    private var recording: Task<Void, Never>?
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
    private var lastInboxData: Data?
    /// THE CONDITIONAL READ'S CURSOR (#459) — the number this Mac handed back
    /// last time, sent with the next ask so a tick with nothing behind it costs
    /// sixty bytes instead of every row again.
    ///
    /// NIL MEANS ASK FOR EVERYTHING, which is the right answer in all three
    /// cases that produce it: the first poll after this store was built, a Mac
    /// too old to count, and a Mac that restarted and now counts from somewhere
    /// else. One store is one Mac, so a cursor can never be spent on another's.
    private var revision: Int?
    /// THE CONDITIONAL READ'S TAG (#457) — what the Mac handed back last time,
    /// sent with the next ask so a tick with nothing behind it costs a 304 and
    /// no body at all.
    ///
    /// AN ETAG RATHER THAN `revision` ABOVE, because the tag carries the MODE:
    /// a cursor earned against the unsettled list and spent against the wide one
    /// would be answered "unchanged" and leave the settled shelf empty. `nil`
    /// means ask for everything, which is the right answer in all three cases
    /// that produce it: the first poll after this store was built, a Mac too old
    /// to mint a tag, and a Mac that restarted and now counts from somewhere
    /// else. One store is one Mac, so a tag can never be spent on another's.
    private var etag: String?
    /// HOW MANY SETTLED ROWS THE MAC IS HOLDING BACK (#457).
    ///
    /// Its live read answers the UNSETTLED rows by default — 7 of 291 on the
    /// owner's store, where it used to fold and serialise all 291 every three
    /// seconds for this phone and every other device at once. This is the count
    /// it sends instead, and it is what the "Settled" divider draws so there is
    /// something to tap that asks for the rest.
    ///
    /// ZERO FROM A MAC THAT PREDATES THE FILTER, which sent every row — the
    /// sections below then hold the settled ones already and this adds nothing.
    private(set) var shelvedOnMac = 0
    /// WHICH CONVERSATION THIS MAC CALLS MAIN (#522), as of its last answer.
    ///
    /// NIL UNTIL A MAC SAYS OTHERWISE, and nil again the moment one says it is
    /// off: unlike `layout` beside it, an absent field here is a real answer
    /// rather than "cannot say". A Mac whose engine predates the feature sends
    /// nothing and means off, and holding a stale designation for it would put a
    /// row on this sidebar that its own rail does not draw.
    private(set) var mainSession: MainSession?
    /// WHETHER THIS PHONE IS ASKING FOR THEM. Off until a reader opens the
    /// shelf, and it stays on afterwards: the rows cost nothing to keep, and
    /// turning it back off would mean re-fetching all of them the next time
    /// they glanced at the list.
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

    /// Tests: wait for the cache read — and the cache write — to land.
    func awaitPendingWork() async {
        await restoring?.value
        await recording?.value
    }

    func refresh() async {
        do {
            /**
             THE CONDITIONAL READ (#459), and on a phone it is the whole game.

             This poll runs every three seconds while anything is live, and on
             the owner's Mac it was pulling 318 KB each time — then a second
             full read straight after it, for the cache (`remember`). Handing
             back the cursor turns a tick with nothing behind it into sixty
             bytes and no work on the Mac at all, which is most of what "the
             phone crawls" (#457) was made of.

             UNCHANGED MEANS KEEP WHAT YOU HAVE. Returning before `apply` is
             the point: those rows are the ones already on screen, and the
             answer carries none to replace them with. The error state is
             cleared first, because a tick that succeeded is a tick that
             succeeded.

             AND IT IS THE UNSETTLED ROWS UNLESS THE SHELF IS OPEN (#457). The
             Mac now sends 7 rows where it sent 291, and `settledCount` beside
             them draws the divider that asks for the other 284.

             THE CONDITIONAL IS AN ETAG RATHER THAN THE CURSOR, and that is what
             makes the wide read conditional too. A cursor is a number about the
             Mac's store, so it does not move when a reader opens a shelf — one
             earned against the unsettled list and spent against `all` would be
             answered "unchanged" and the shelf would stay empty until something
             else happened over there. The tag carries the mode, so the two asks
             can never be answered with each other's list. A 304 also has no
             body at all, where the cursor's cheapest answer is sixty bytes.
             `revision` is still read off the answers that carry one, so a Mac
             too old to mint a tag keeps working exactly as it did.
             */
            /**
             THE CURSOR IS THE FLOOR, NOT THE DEAD PATH. A Mac too old to mint a
             tag answers 200 with none, and this phone then falls back to
             `?since=` — which is exactly what it did before, so a mixed-version
             pair loses nothing. Only the NARROW read can use a cursor; the wide
             one is refused a cursor for the reason above and simply pays.
             */
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
            // THE WINDOW RIDES THE LIST NOW (#459), so the ask below is only for
            // a Mac whose engine predates the field — the same shape, and the
            // same reason, as the arrangement's fallback just after it.
            if let policy = live.inbox {
                autoSettleAfterHours = policy.autoSettleAfterHours
                policyReadAt = .now
            } else if policyReadAt.map({ $0.duration(to: .now) > .seconds(60) }) ?? true,
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

    /// A reader opened the settled shelf. Ask the Mac for its rows, now rather
    /// than on the next tick — otherwise they tap "Settled (284)" and watch an
    /// empty shelf for three seconds.
    func showSettled() async {
        guard !wantsSettled else { return }
        wantsSettled = true
        await refresh()
    }

    private func apply(_ live: LiveSessions) {
        // The Mac's own word about where things sit. Absent means an engine
        // that cannot say, never "nobody has arranged anything" — so the copy
        // already held survives rather than being blanked every poll.
        if let arrangement = live.layout { layout = arrangement }
        // HOW MANY IT HELD BACK (#457). Nil means a Mac that sent everything,
        // and the sections below then hold the settled rows themselves — so
        // zero here is "nothing withheld", never "nothing settled".
        shelvedOnMac = live.settledCount ?? 0
        // WHICH ONE THIS MAC CALLS MAIN (#522). Taken straight, not merged with
        // what was held: nil is the Mac saying "off", not "cannot say", so a
        // designation switched off on the desktop leaves this sidebar on the
        // very next poll rather than lingering until something else moves.
        mainSession = live.mainSession
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

    /// The bytes of the read that just succeeded, kept for next time.
    ///
    /// THE POLL'S OWN BODY (#499) — never a second read. This used to fire a
    /// fresh, unconditional GET of the whole live list the instant a poll
    /// changed anything: 318 KB on the owner's Mac, for rows it had been handed
    /// microseconds earlier, on a route it asks every three seconds. The read
    /// that earned the rows carries the bytes now, so warming the cache costs
    /// nothing over reading it.
    ///
    /// NIL MEANS NOTHING NEW TO RECORD — a 304, an `unchanged` answer, or a
    /// conformer with no bytes to give. The copy already on disk stands, which
    /// is right in all three: it is still the last thing this Mac actually
    /// said.
    ///
    /// THE WRITE IS DETACHED because it is file I/O, and this is the tail of a
    /// poll that runs on the main actor while somebody is reading the list.
    private func remember(_ data: Data?) {
        guard let cache, let data, data != lastInboxData else { return }
        lastInboxData = data
        recording = Task.detached(priority: .utility) { cache.writeInbox(data) }
    }
}
