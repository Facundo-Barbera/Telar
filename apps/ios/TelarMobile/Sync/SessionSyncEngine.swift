import Foundation
import Observation

enum SyncConnectionState: Equatable {
    case idle
    case hydrating
    case live
    /// Transport trouble; still retrying with backoff. Routine — the Mac's
    /// cockpit restarting mid-poll is an ordinary Tuesday.
    case retrying(message: String)
    /// The session is gone from the engine (404). Terminal.
    case gone

    /// Whether what is on screen came from the Mac just now, or from the
    /// phone's own copy of the last thing it recorded (SnapshotCache).
    var isStale: Bool {
        switch self {
        case .live, .gone: false
        case .idle, .hydrating, .retrying: true
        }
    }
}

/// Drives one open session: hydrate, then a poll loop that tails the journal
/// and refolds. `@MainActor` because its published state feeds SwiftUI
/// directly; the network awaits hop off the main thread on their own.
///
/// THE CACHE IS THE FIRST FRAME AND THE LAST RESORT. On start, the last
/// snapshot this phone recorded for the session is shown at once — stamped
/// `recordedAt` so the view can say when — while hydrate runs; a good read
/// replaces it and is written back. When the Mac stops answering, the
/// transcript STAYS: `.retrying` no longer means an empty screen, because the
/// last thing recorded is still the most useful thing to look at.
///
/// THE MAIN THREAD ONLY ASSIGNS. Reading the cache and folding the journal
/// are the two costs an open session pays, and both used to run on the main
/// actor: the cache read inside the view's initialiser (inside the tap), the
/// fold on every poll. On a slow reconnect the two stacked up behind each
/// other and the list stopped answering touches. Both now run detached and
/// hand back a finished value; a fold that lands after a newer one is
/// discarded by generation, and a cache read that lands after the Mac has
/// answered is discarded outright.
@MainActor @Observable final class SessionSyncEngine {
    private(set) var session: Session?
    private(set) var turns: [JournalTurn] = []
    private(set) var openRequests: [EngineRequest] = []
    private(set) var connection: SyncConnectionState = .idle
    /// A fetch of earlier turns is in flight — the button's spinner state.
    private(set) var loadingOlder = false
    /// Every `display.opened` the tail has carried: the agent asking for a
    /// file to be shown. The view decides which are fresh.
    private(set) var displayOpens: [DisplayOpen] = []

    struct DisplayOpen: Equatable, Identifiable {
        var id: Int
        var at: Timestamp
        var path: String
    }
    /// When the shown snapshot was recorded by this phone — set while it is a
    /// cached one, nil once a live read has replaced it.
    private(set) var recordedAt: Timestamp?

    private let api: any EngineAPI
    private let sessionId: EngineID
    private let cache: HostSnapshotCache?
    private var snapshot: SessionSnapshot?
    /// The paging cursor of the WINDOWED transcript — where "Load earlier
    /// turns" continues from. Owned by hydrate and by that button alone: a
    /// tick's companion snapshot must not touch it, because its page describes
    /// the sliding newest window, not how far the reader has paged.
    private var page: SnapshotPage?
    private var events: [EngineEvent] = []
    private var cursor = 0
    private var loop: Task<Void, Never>?
    /// The cache read seeding the first frame. Detached: it is started from
    /// the view's initialiser, which is the tap.
    private var restoring: Task<Void, Never>?
    /// The fold in flight, and the number that lets a slow one be discarded
    /// once a newer one has landed.
    private var folding: Task<Void, Never>?
    private var foldGeneration = 0
    /// The last snapshot bytes as the cockpit sent them, saved after a good
    /// read. Raw on purpose — see SnapshotCache.
    private var lastSnapshotData: Data?

    /// Whether "Load earlier turns" has anything to load.
    var hasOlderTurns: Bool { page?.more == true }

    /// 1s while a turn streams, 3s when the session idles, capped exponential
    /// backoff while the cockpit is unreachable.
    private var interval: Duration {
        if case .retrying = connection { return backoff }
        let active = turns.contains { $0.state.isActive }
        return active ? .seconds(1) : .seconds(3)
    }
    private var backoff: Duration = .seconds(1)

    init(api: any EngineAPI, sessionId: EngineID, cache: HostSnapshotCache? = nil) {
        self.api = api
        self.sessionId = sessionId
        self.cache = cache
        restore()
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            await self?.run()
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    func refresh() async {
        await hydrate()
    }

    private func run() async {
        await hydrate()
        while !Task.isCancelled {
            try? await Task.sleep(for: interval)
            if Task.isCancelled { break }
            await tick()
        }
    }

    /// The first frame: what this phone last recorded, decoded by the same
    /// decoder the network path uses. Absent cache, absent entry, or bytes an
    /// older build wrote that this one cannot read all mean "start empty".
    /// Read, decoded and folded off the main thread; only the result lands.
    private func restore() {
        guard let cache else { return }
        let id = sessionId
        restoring = Task.detached(priority: .userInitiated) { [weak self] in
            guard let entry = cache.readSession(id),
                  let restored = try? JSONDecoder().decode(SessionSnapshot.self, from: entry.data)
            else { return }
            let folded = fold(restored, events: [])
            await self?.applyRestored(restored, entry: entry, folded: folded)
        }
    }

    /// The Mac may have answered first — its word wins, and a session it no
    /// longer has is not worth a photograph of.
    private func applyRestored(_ restored: SessionSnapshot, entry: SnapshotCache.Entry, folded: Folded) {
        guard snapshot == nil, connection != .gone else { return }
        snapshot = restored
        lastSnapshotData = entry.data
        recordedAt = entry.savedAt
        session = restored.session
        foldGeneration += 1
        apply(folded, generation: foldGeneration)
    }

    /// Tests: wait for the cache read and the fold in flight to land.
    func awaitPendingWork() async {
        await restoring?.value
        await folding?.value
    }

    private func hydrate() async {
        if connection == .idle { connection = .hydrating }
        do {
            // WINDOWED: the last ten user turns, not the whole history — the
            // rest stays on the engine behind "Load earlier turns".
            let hydrated = try await hydrateSession(api, sessionId, window: SnapshotWindow(turns: initialTurns))
            snapshot = hydrated.snapshot
            page = hydrated.snapshot.page
            events = hydrated.events
            cursor = hydrated.cursor
            refold()
            connection = .live
            recordedAt = nil
            backoff = .seconds(1)
            remember()
        } catch {
            fail(error)
        }
    }

    private func tick() async {
        do {
            // The companion snapshot is windowed to the SAME size as
            // hydrate's — a queue event on a long session must not refetch
            // the whole history the window existed to avoid.
            let tail = try await tailSession(api, sessionId, after: cursor, window: SnapshotWindow(turns: initialTurns))
            try Task.checkCancellation()
            if let fresh = tail.snapshot {
                // A UNION, NOT A REPLACEMENT. The snapshot only carries the
                // newest window, so a reader who paged older turns in would
                // lose them to the first queue event. Fresh rows win the ids
                // they carry; loaded older rows survive above them. `page` is
                // deliberately untouched — see its declaration.
                if var held = snapshot {
                    held.cursor = fresh.cursor
                    held.session = fresh.session
                    held.requests = fresh.requests
                    held.turns = mergeRows(older: held.turns, fresh: fresh.turns) { $0.runId }
                    held.items = mergeRows(older: held.items, fresh: fresh.items) { $0.id }
                    held.tasks = mergeRows(older: held.tasks, fresh: fresh.tasks) { $0.id }
                    snapshot = held
                } else {
                    snapshot = fresh
                    page = fresh.page
                }
            }
            if !tail.events.isEmpty || tail.snapshot != nil {
                events = appendJournalEvents(events, tail.events)
                if let reflected = tail.snapshot?.cursor { events.removeAll { $0.id <= reflected } }
                refold()
            }
            cursor = max(tail.cursor, tail.snapshot?.cursor ?? 0)
            connection = .live
            recordedAt = nil
            backoff = .seconds(1)
            if tail.snapshot != nil { remember() }
        } catch {
            fail(error)
        }
    }

    /// One page of settled turns above the transcript, on an explicit tap —
    /// never on scroll, so reading the top of the window stays free.
    func loadOlderTurns() async {
        guard let before = page?.before, !loadingOlder else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let older = try await TelarMobile.loadOlderTurns(api, sessionId, before: before)
            if let held = snapshot {
                snapshot = mergeOlderPage(current: held, page: older)
            }
            page = older.page
            refold()
        } catch {
            fail(error)
        }
    }

    private func fail(_ error: Error) {
        if let apiError = error as? EngineAPIError, apiError.isNotFound {
            connection = .gone
            // A session the engine no longer has is not worth keeping a
            // photograph of; the next open would show a ghost.
            cache?.dropSession(sessionId)
            stop()
            return
        }
        backoff = min(backoff * 2, .seconds(30))
        // The transcript on screen is left exactly as it was — that is the
        // point. Only the connection state changes, and the view says so.
        connection = .retrying(message: (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription)
    }

    /// Write the snapshot the last good read produced, AS THE COCKPIT SENT
    /// IT. The wire types decode only, so the bytes come from a second GET of
    /// the same record rather than from re-encoding a struct that has no
    /// encoder — one small read after a hydrate or a queue-changing tail,
    /// never per delta, and never on the hot path (it is detached).
    private func remember() {
        guard let cache else { return }
        let api = self.api, id = sessionId
        Task.detached(priority: .utility) { [weak self] in
            guard let data = try? await api.sessionData(id) else { return }
            await self?.store(data, in: cache)
        }
    }

    private func store(_ data: Data, in cache: HostSnapshotCache) {
        if data == lastSnapshotData { return }
        lastSnapshotData = data
        cache.writeSession(sessionId, data)
    }

    /// The session row is cheap and lands now; the fold is the cost and lands
    /// when it is done. A tick that arrives while a fold is still running
    /// starts a newer one and the older result is dropped on arrival.
    private func refold() {
        guard let snapshot else { return }
        session = snapshot.session
        foldGeneration += 1
        let generation = foldGeneration
        let events = self.events
        folding = Task.detached(priority: .userInitiated) { [weak self] in
            let folded = fold(snapshot, events: events)
            await self?.apply(folded, generation: generation)
        }
    }

    private func apply(_ folded: Folded, generation: Int) {
        guard generation == foldGeneration else { return }
        turns = folded.turns
        openRequests = folded.openRequests
        if folded.displayOpens != displayOpens { displayOpens = folded.displayOpens }
    }
}

/// What one fold produces — computed away from the main actor, assigned on it.
private struct Folded {
    var turns: [JournalTurn]
    var openRequests: [EngineRequest]
    var displayOpens: [SessionSyncEngine.DisplayOpen]
}

private func fold(_ snapshot: SessionSnapshot, events: [EngineEvent]) -> Folded {
    let turns = projectJournal(
        turns: snapshot.turns, items: snapshot.items,
        events: events, tasks: snapshot.tasks
    )
    let displayOpens: [SessionSyncEngine.DisplayOpen] = events.compactMap { event in
        if case .displayOpened(let path, _) = event.payload {
            return SessionSyncEngine.DisplayOpen(id: event.id, at: event.at, path: path)
        }
        return nil
    }
    // Requests: the snapshot's list, corrected by any resolutions the tail
    // has seen since — the same journal-wins rule as items.
    var resolved = Set<EngineID>()
    var openedInTail = [EngineRequest]()
    for event in events {
        switch event.payload {
        case .requestOpened(let request): openedInTail.append(request)
        case .requestResolved(let requestId, _): resolved.insert(requestId)
        default: break
        }
    }
    var known = Set(snapshot.requests.map(\.id))
    var all = snapshot.requests
    for request in openedInTail where !known.contains(request.id) {
        known.insert(request.id)
        all.append(request)
    }
    return Folded(turns: turns, openRequests: all.filter { $0.isOpen && !resolved.contains($0.id) }, displayOpens: displayOpens)
}
