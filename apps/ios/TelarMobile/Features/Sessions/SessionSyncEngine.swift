import Foundation
import Observation

enum SyncConnectionState: Equatable {
    case idle
    case hydrating
    case live

    case retrying(message: String)

    case gone

    var isStale: Bool {
        switch self {
        case .live, .gone: false
        case .idle, .hydrating, .retrying: true
        }
    }
}

@MainActor @Observable final class SessionSyncEngine {
    private(set) var session: Session?
    private(set) var turns: [JournalTurn] = []
    private(set) var openRequests: [EngineRequest] = []
    private(set) var connection: SyncConnectionState = .idle

    private(set) var loadingOlder = false

    private(set) var displayOpens: [DisplayOpen] = []

    private(set) var kernelSignals = KernelSignals()

    struct DisplayOpen: Equatable, Identifiable {
        var id: Int
        var at: Timestamp
        var path: String
    }

    private(set) var recordedAt: Timestamp?

    private let api: any EngineAPI
    private let sessionId: EngineID
    private let cache: HostSnapshotCache?
    private var snapshot: SessionSnapshot?

    private var page: SnapshotPage?
    private var events: [EngineEvent] = []
    private var cursor = 0
    private var loop: Task<Void, Never>?

    private var restoring: Task<Void, Never>?

    private var folding: Task<Void, Never>?
    private var foldGeneration = 0

    private var lastSnapshotData: Data?

    private var recording: Task<Void, Never>?

    var hasOlderTurns: Bool { page?.more == true }

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

    func applyRead(_ answer: Session) {
        guard var current = session, current.id == answer.id else { return }
        guard current.applyReadMark(answer.readMark) else { return }
        session = current
    }

    private func run() async {
        await hydrate()
        while !Task.isCancelled {
            try? await Task.sleep(for: interval)
            if Task.isCancelled { break }
            await tick()
        }
    }

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

    private func applyRestored(_ restored: SessionSnapshot, entry: SnapshotCache.Entry, folded: Folded) {
        guard snapshot == nil, connection != .gone else { return }
        snapshot = restored
        lastSnapshotData = entry.data
        recordedAt = entry.savedAt
        session = restored.session
        foldGeneration += 1
        apply(folded, generation: foldGeneration)
    }

    func awaitPendingWork() async {
        await restoring?.value
        await folding?.value
        await recording?.value
    }

    private func hydrate() async {
        if connection == .idle { connection = .hydrating }
        do {
            let hydrated = try await hydrateSession(api, sessionId, window: SnapshotWindow(turns: initialTurns))
            snapshot = hydrated.snapshot
            page = hydrated.snapshot.page
            events = hydrated.events
            cursor = hydrated.cursor
            refold()
            connection = .live
            recordedAt = nil
            backoff = .seconds(1)
            remember(hydrated.snapshotData)
        } catch {
            fail(error)
        }
    }

    private func tick() async {
        do {
            let tail = try await tailSession(api, sessionId, after: cursor, window: SnapshotWindow(turns: initialTurns))
            try Task.checkCancellation()
            if let fresh = tail.snapshot {
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
            if tail.snapshot != nil { remember(tail.snapshotData) }
        } catch {
            fail(error)
        }
    }

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

            cache?.dropSession(sessionId)
            stop()
            return
        }
        backoff = min(backoff * 2, .seconds(30))

        connection = .retrying(message: (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription)
    }

    private func remember(_ data: Data?) {
        guard let cache, let data, data != lastSnapshotData else { return }
        lastSnapshotData = data
        let id = sessionId
        recording = Task.detached(priority: .utility) { cache.writeSession(id, data) }
    }

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
        if folded.kernelSignals != kernelSignals { kernelSignals = folded.kernelSignals }
    }
}

private struct Folded {
    var turns: [JournalTurn]
    var openRequests: [EngineRequest]
    var displayOpens: [SessionSyncEngine.DisplayOpen]
    var kernelSignals: KernelSignals
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
    return Folded(
        turns: turns,
        openRequests: all.filter { $0.isOpen && !resolved.contains($0.id) },
        displayOpens: displayOpens,

        kernelSignals: foldKernelSignals(events, after: snapshot.cursor ?? 0)
    )
}

struct KernelSignals: Equatable {
    var kernelRevision = 0

    var kernelState: KernelState?

    var notebookRevision: [String: Int] = [:]

    var outputRevision = 0

    var plotRevision = 0
}

func foldKernelSignals(_ events: [EngineEvent], after cursor: Int) -> KernelSignals {
    var signals = KernelSignals()
    for event in events where event.id > cursor {
        switch event.payload {
        case .kernelStateChanged(let state, _):
            signals.kernelRevision += 1
            signals.kernelState = state
        case .notebookCellOutput(_, _, let producer, let output):
            signals.outputRevision += 1
            if let producer { signals.notebookRevision[producer, default: 0] += 1 }
            if case .image = output { signals.plotRevision += 1 }
        default:
            continue
        }
    }
    return signals
}
