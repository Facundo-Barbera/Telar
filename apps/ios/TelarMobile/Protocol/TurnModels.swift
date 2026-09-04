import Foundation

/// Mirror of `Turn` in `packages/engine-client/src/protocol/entities.ts`.

enum TurnState: String, Codable {
    case queued, claimed, running, completed, failed, stopped
    case ambiguous, discarded, steering, steered
    /// A state this build does not know. Neither queued nor active — the
    /// snapshot refetch on the next queue-changing event resolves it.
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TurnState(rawValue: raw) ?? .unknown
    }

    /// Matches `isActiveTurn` in apps/web/lib/engine/journal.ts.
    var isActive: Bool {
        self == .queued || self == .claimed || self == .running || self == .steering
    }
}

struct TurnFailure: Codable, Equatable {
    var code: String
    var message: String
}

struct Turn: Codable, Identifiable, Equatable {
    /// Client-supplied idempotency key: resubmitting the same runId returns
    /// the original turn instead of queueing a second.
    var runId: EngineID
    var sessionId: EngineID
    var sequence: Int
    var state: TurnState
    var input: String
    /// "compact" when the turn is the compaction gesture, not a message.
    var kind: String?
    var model: ModelSelection?
    var acceptedAt: Timestamp
    var updatedAt: Timestamp
    var startedAt: Timestamp?
    var completedAt: Timestamp?
    var usage: UsageSnapshot?
    var resultText: String?
    var failure: TurnFailure?

    var id: EngineID { runId }
}

struct TurnSubmissionResult: Codable {
    var turn: Turn
    /// True when the runId was already seen — the retry case, still a success.
    var replayed: Bool
}
