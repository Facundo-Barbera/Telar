import Foundation

/// Port of `apps/web/lib/engine/session-sync.ts`.

/// Every event that changes the durable queue needs its companion snapshot.
/// Item and delta events are DELIBERATELY ABSENT: they are the high-frequency
/// half of the stream and the fold applies them directly — refetching a
/// snapshot per delta would turn streaming into a request storm.
let queueChangingEvents: Set<String> = [
    "turn.accepted", "turn.requeued", "turn.claimed", "turn.started",
    "turn.completed", "turn.failed", "turn.stopped", "turn.ambiguous",
    "turn.discarded",
    // A request opening or closing changes what the human must DO. Approvals
    // are rare — unlike deltas, they cannot storm.
    "request.opened", "request.resolved",
]

func needsSessionSnapshot(_ events: [EngineEvent]) -> Bool {
    events.contains { queueChangingEvents.contains($0.type) }
}

/// WHY 10 AND 20 (mirror of the web constants). The first paint should carry
/// roughly what a screen can show plus a little scrollback — t3code measured
/// ~100 KB gzipped for ten turns of a typical session, against 4.5 MB for the
/// same session read whole. Ten turns also covers the MEDIAN session
/// entirely, so most opens are still one page. Older pages are a deliberate
/// tap, so they can afford to be bigger.
let initialTurns = 10
let olderPageTurns = 20

struct HydratedSession {
    var snapshot: SessionSnapshot
    var events: [EngineEvent]
    var cursor: Int
    /// THE SNAPSHOT'S OWN BYTES (#499) — what the phone records, so the cache
    /// is warmed by the read the screen already made rather than by a second,
    /// unwindowed one. Nil from a conformer that cannot hand them over.
    var snapshotData: Data?
}

struct TailResult {
    var events: [EngineEvent]
    var cursor: Int
    var snapshot: SessionSnapshot?
    /// As above — present exactly when `snapshot` is.
    var snapshotData: Data?
}

/// OPEN ON THE SNAPSHOT, TAIL FROM ITS CURSOR. The snapshot already says
/// everything a settled turn will ever say; the journal only adds what is
/// still streaming. The engine stamps the snapshot with the last event id it
/// reflects (read BEFORE the snapshot, so any overlap is a replay the fold
/// absorbs, never a gap). Reading the journal from zero — nine megabytes on a
/// long session, over a phone's radio — was the whole cost of opening one.
///
/// An engine older than the stamp answers without one; then the journal has
/// to be asked where it ends. The old cost, kept only for that case.
func hydrateSession(_ api: some EngineAPI, _ sessionId: EngineID, window: SnapshotWindow? = nil) async throws -> HydratedSession {
    // KEEPING THE BYTES (#499): the cache is written from this read, not from a
    // second unwindowed one fired behind it.
    let read = try await api.sessionRead(sessionId, window: window)
    let snapshot = read.snapshot
    let from: Int
    if let cursor = snapshot.cursor {
        from = cursor
    } else {
        from = journalCursor(try await api.events(sessionId, after: 0).events)
    }
    let tail = try await api.events(sessionId, after: from)
    return HydratedSession(
        snapshot: snapshot,
        events: tail.events,
        cursor: max(from, journalCursor(tail.events)),
        snapshotData: read.data
    )
}

func tailSession(_ api: some EngineAPI, _ sessionId: EngineID, after: Int, window: SnapshotWindow? = nil) async throws -> TailResult {
    let page = try await api.events(sessionId, after: after)
    let read = needsSessionSnapshot(page.events) ? try await api.sessionRead(sessionId, window: window) : nil
    return TailResult(
        events: page.events,
        cursor: max(after, journalCursor(page.events)),
        snapshot: read?.snapshot,
        snapshotData: read?.data
    )
}

/// One page of settled turns above `before` — what "Load earlier turns" fetches.
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

/// Union by id: `fresh` wins every collision, `older` rows it does not carry
/// are PREPENDED in their own order. Serves both directions — an older page
/// merged under the loaded transcript, and a windowed companion snapshot
/// merged over already-paged-in history.
func mergeRows<T>(older: [T], fresh: [T], id: (T) -> String) -> [T] {
    let carried = Set(fresh.map(id))
    return older.filter { !carried.contains(id($0)) } + fresh
}

/// Prepend an older page below what is already loaded, deduped by id (turns
/// by runId, items and tasks by id) — a page boundary can shift under a live
/// session, so a turn settling between two reads may appear on both sides.
/// The CURRENT rows win a collision: they are the fresher read.
func mergeOlderPage(current: SessionSnapshot, page: OlderPage) -> SessionSnapshot {
    var merged = current
    merged.turns = mergeRows(older: page.turns, fresh: current.turns) { $0.runId }
    merged.items = mergeRows(older: page.items, fresh: current.items) { $0.id }
    merged.tasks = mergeRows(older: page.tasks, fresh: current.tasks) { $0.id }
    return merged
}
