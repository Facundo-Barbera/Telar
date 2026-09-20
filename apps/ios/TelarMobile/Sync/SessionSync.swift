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
        // DRAINED, because this branch wants the journal's END and a page
        // gives it the BEGINNING (#494). Only an engine too old to stamp a
        // cursor reaches here; for that one there is no cheaper answer than
        // walking to the last id — in bounded pages now, not one 36 MB body.
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

/// EVERY EVENT ABOVE `after`, however many pages that takes (#494).
///
/// The engine caps one response, so a phone that has been away — backgrounded,
/// out of signal, asleep through a long turn — is told `more` and has to ask
/// again. Folding one page and stopping would leave the transcript silently
/// short of what the session did, which is worse than the cost paging removes.
///
/// `maxEventPages` IS A STOP, NOT A BUDGET. A journal appended to faster than
/// the radio reads it would otherwise spin here; stopping hands back a valid
/// cursor, so the next tick resumes where this one reached and nothing is lost.
let maxEventPages = 100

func drainEvents(_ api: some EngineAPI, _ sessionId: EngineID, after: Int) async throws -> (events: [EngineEvent], cursor: Int) {
    var cursor = after
    var events: [EngineEvent] = []
    for _ in 0..<maxEventPages {
        let page = try await api.events(sessionId, after: cursor)
        events.append(contentsOf: page.events)
        let reached = max(cursor, journalCursor(page.events))
        // A page that moved nothing ends the walk whatever `more` claims:
        // asking again from the same cursor is the one way this cannot finish.
        if !page.more || reached == cursor { return (events, reached) }
        cursor = reached
    }
    return (events, cursor)
}

func tailSession(_ api: some EngineAPI, _ sessionId: EngineID, after: Int, window: SnapshotWindow? = nil) async throws -> TailResult {
    // DRAINED (#494): a quiet tick is one page and stops on the first answer,
    // so the ordinary poll costs exactly what it did. A tick that returns to a
    // session which ran while the app was backgrounded keeps paging — each
    // request bounded, the transcript complete.
    let page = try await drainEvents(api, sessionId, after: after)
    let read = needsSessionSnapshot(page.events) ? try await api.sessionRead(sessionId, window: window) : nil
    return TailResult(
        events: page.events,
        cursor: max(after, page.cursor),
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
