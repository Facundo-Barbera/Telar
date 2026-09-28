import Foundation

let queueChangingEvents: Set<String> = [
    "turn.accepted", "turn.requeued", "turn.claimed", "turn.started",
    "turn.completed", "turn.failed", "turn.stopped", "turn.ambiguous",
    "turn.discarded",

    "request.opened", "request.resolved",
]

func needsSessionSnapshot(_ events: [EngineEvent]) -> Bool {
    events.contains { queueChangingEvents.contains($0.type) }
}

let initialTurns = 10
let olderPageTurns = 20

struct HydratedSession {
    var snapshot: SessionSnapshot
    var events: [EngineEvent]
    var cursor: Int

    var snapshotData: Data?
}

struct TailResult {
    var events: [EngineEvent]
    var cursor: Int
    var snapshot: SessionSnapshot?

    var snapshotData: Data?
}

func hydrateSession(_ api: some EngineAPI, _ sessionId: EngineID, window: SnapshotWindow? = nil) async throws -> HydratedSession {
    let read = try await api.sessionRead(sessionId, window: window)
    let snapshot = read.snapshot
    let from: Int
    if let cursor = snapshot.cursor {
        from = cursor
    } else {
        from = try await drainEvents(api, sessionId, after: 0).cursor
    }
    let tail = try await drainEvents(api, sessionId, after: from)
    return HydratedSession(
        snapshot: snapshot,
        events: tail.events,
        cursor: max(from, tail.cursor),
        snapshotData: read.data
    )
}

let maxEventPages = 100

func drainEvents(_ api: some EngineAPI, _ sessionId: EngineID, after: Int) async throws -> (events: [EngineEvent], cursor: Int) {
    var cursor = after
    var events: [EngineEvent] = []
    for _ in 0..<maxEventPages {
        let page = try await api.events(sessionId, after: cursor)
        events.append(contentsOf: page.events)
        let reached = max(cursor, journalCursor(page.events))

        if !page.more || reached == cursor { return (events, reached) }
        cursor = reached
    }
    return (events, cursor)
}

func tailSession(_ api: some EngineAPI, _ sessionId: EngineID, after: Int, window: SnapshotWindow? = nil) async throws -> TailResult {
    let page = try await drainEvents(api, sessionId, after: after)
    let read = needsSessionSnapshot(page.events) ? try await api.sessionRead(sessionId, window: window) : nil
    return TailResult(
        events: page.events,
        cursor: max(after, page.cursor),
        snapshot: read?.snapshot,
        snapshotData: read?.data
    )
}

struct OlderPage {
    var turns: [Turn]
    var items: [Item]
    var tasks: [AgentTask]
    var page: SnapshotPage?
}

func loadOlderTurns(_ api: some EngineAPI, _ sessionId: EngineID, before: EngineID) async throws -> OlderPage {
    let snapshot = try await api.session(sessionId, window: SnapshotWindow(turns: olderPageTurns, before: before))
    return OlderPage(turns: snapshot.turns, items: snapshot.items, tasks: snapshot.tasks, page: snapshot.page)
}

func mergeRows<T>(older: [T], fresh: [T], id: (T) -> String) -> [T] {
    let carried = Set(fresh.map(id))
    return older.filter { !carried.contains(id($0)) } + fresh
}

func mergeOlderPage(current: SessionSnapshot, page: OlderPage) -> SessionSnapshot {
    var merged = current
    merged.turns = mergeRows(older: page.turns, fresh: current.turns) { $0.runId }
    merged.items = mergeRows(older: page.items, fresh: current.items) { $0.id }
    merged.tasks = mergeRows(older: page.tasks, fresh: current.tasks) { $0.id }
    return merged
}
