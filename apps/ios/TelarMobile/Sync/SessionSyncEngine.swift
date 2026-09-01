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
}

/// Drives one open session: hydrate, then a poll loop that tails the journal
/// and refolds. `@MainActor` because its published state feeds SwiftUI
/// directly; the network awaits hop off the main thread on their own.
@MainActor @Observable final class SessionSyncEngine {
    private(set) var session: Session?
    private(set) var turns: [JournalTurn] = []
    private(set) var openRequests: [EngineRequest] = []
    private(set) var connection: SyncConnectionState = .idle

    private let api: any EngineAPI
    private let sessionId: EngineID
    private var snapshot: SessionSnapshot?
    private var events: [EngineEvent] = []
    private var cursor = 0
    private var loop: Task<Void, Never>?

    /// 1s while a turn streams, 3s when the session idles, capped exponential
    /// backoff while the cockpit is unreachable.
    private var interval: Duration {
        if case .retrying = connection { return backoff }
        let active = turns.contains { $0.state.isActive }
        return active ? .seconds(1) : .seconds(3)
    }
    private var backoff: Duration = .seconds(1)

    init(api: any EngineAPI, sessionId: EngineID) {
        self.api = api
        self.sessionId = sessionId
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

    private func hydrate() async {
        if connection == .idle { connection = .hydrating }
        do {
            let hydrated = try await hydrateSession(api, sessionId)
            snapshot = hydrated.snapshot
            events = hydrated.events
            cursor = hydrated.cursor
            refold()
            connection = .live
            backoff = .seconds(1)
        } catch {
            fail(error)
        }
    }

    private func tick() async {
        do {
            let tail = try await tailSession(api, sessionId, after: cursor)
            if let fresh = tail.snapshot { snapshot = fresh }
            if !tail.events.isEmpty || tail.snapshot != nil {
                events = appendJournalEvents(events, tail.events)
                refold()
            }
            cursor = tail.cursor
            connection = .live
            backoff = .seconds(1)
        } catch {
            fail(error)
        }
    }

    private func fail(_ error: Error) {
        if let apiError = error as? EngineAPIError, apiError.isNotFound {
            connection = .gone
            stop()
            return
        }
        backoff = min(backoff * 2, .seconds(30))
        connection = .retrying(message: (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription)
    }

    private func refold() {
        guard let snapshot else { return }
        session = snapshot.session
        turns = projectJournal(
            turns: snapshot.turns, items: snapshot.items,
            events: events, tasks: snapshot.tasks
        )
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
        openRequests = all.filter { $0.isOpen && !resolved.contains($0.id) }
    }
}
