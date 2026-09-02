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

/// A journal page and a snapshot cannot be read atomically. Reading
/// journal → snapshot → journal tail → snapshot closes both directions of the
/// gap: transitions are reflected by their event, and a newly accepted turn
/// gains its prompt from a snapshot even though `turn.accepted` omits it.
/// THE DISCARDED FIRST SNAPSHOT IS LOAD-BEARING — it orders the reads.
func hydrateSession(_ api: some EngineAPI, _ sessionId: EngineID) async throws -> HydratedSession {
    let journal = try await api.events(sessionId, after: 0)
    _ = try await api.session(sessionId)
    let catchup = try await api.events(sessionId, after: journalCursor(journal.events))
    let events = appendJournalEvents(journal.events, catchup.events)
    let snapshot = try await api.session(sessionId)
    return HydratedSession(snapshot: snapshot, events: events, cursor: journalCursor(events))
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
