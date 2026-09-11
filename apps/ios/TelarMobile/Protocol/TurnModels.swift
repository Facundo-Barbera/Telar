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

    /// WHO STARTED THIS TURN. "user" (or absent) is a person typing; "session"
    /// is another agent's `sessions_send`; "provider" is the model waking
    /// itself. The phone decoded none of this and drew every turn as a user
    /// bubble, so a peer's twenty-line report sat on the right of the screen
    /// looking exactly like something the reader had said.
    ///
    /// EVERY FIELD OPTIONAL AND LENIENT, on purpose: they arrive from an
    /// engine that may be older than this build, and a turn that decodes
    /// without them is exactly the turn this app already drew.
    var origin: String?
    /// Stamped by the engine from a claim token, so the attribution here
    /// cannot be asserted by a model.
    var sender: MessageSender?
    /// What the peer meant by sending: "task" is work being handed over,
    /// "report" / "result" / "blocker" are a peer talking.
    var agentIntent: String?
    var agentDelivery: String?
    var agentSourceRunId: EngineID?
    var assignmentScope: String?
    /// Set when this turn is a wake-up rather than a message: the engine's own
    /// short reason, e.g. "completed".
    var wakeReason: String?
    /// A one-line summary the engine writes for a collapsed row. Preferred
    /// verbatim when present; derived locally when it is not.
    var agentNotice: String?

    var id: EngineID { runId }
}

/// Who sent a turn that a session sent. Open-shaped: the engine may learn to
/// name more than a session.
struct MessageSender: Codable, Equatable {
    var sessionId: EngineID?
    var name: String?
}

/// THE DESKTOP'S `agentSenderLabel`, 1:1. A session id is long and meaningless
/// in full; its last six characters are enough to tell two peers apart, which
/// is all the label is for.
func agentSenderLabel(_ sender: MessageSender?) -> String {
    guard let id = sender?.sessionId, !id.isEmpty else { return "agent · outside any session" }
    return "agent · session …\(id.suffix(6))"
}

struct TurnSubmissionResult: Codable {
    var turn: Turn
    /// True when the runId was already seen — the retry case, still a success.
    var replayed: Bool
}
