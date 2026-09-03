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

struct HydratedSession {
    var snapshot: SessionSnapshot
    var events: [EngineEvent]
    var cursor: Int
}

struct TailResult {
    var events: [EngineEvent]
    var cursor: Int
    var snapshot: SessionSnapshot?
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
func hydrateSession(_ api: some EngineAPI, _ sessionId: EngineID) async throws -> HydratedSession {
    let snapshot = try await api.session(sessionId)
    let from: Int
    if let cursor = snapshot.cursor {
        from = cursor
    } else {
        from = journalCursor(try await api.events(sessionId, after: 0).events)
    }
    let tail = try await api.events(sessionId, after: from)
    return HydratedSession(snapshot: snapshot, events: tail.events, cursor: max(from, journalCursor(tail.events)))
}

func tailSession(_ api: some EngineAPI, _ sessionId: EngineID, after: Int) async throws -> TailResult {
    let page = try await api.events(sessionId, after: after)
    let snapshot = needsSessionSnapshot(page.events) ? try await api.session(sessionId) : nil
    return TailResult(
        events: page.events,
        cursor: max(after, journalCursor(page.events)),
        snapshot: snapshot
    )
}
