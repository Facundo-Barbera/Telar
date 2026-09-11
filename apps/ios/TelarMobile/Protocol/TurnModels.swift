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
    /// Set when this turn is a wake-up rather than a message: WHAT happened
    /// and WHERE. An object on the wire, not a string — see `WakeReason`.
    var wakeReason: WakeReason?
    /// A one-line summary the engine writes for a collapsed row. Preferred
    /// verbatim when present; derived locally when it is not.
    var agentNotice: String?
    /// Why the PROVIDER started a turn nobody asked for — a background task
    /// ending, usually. These turns carry an EMPTY `input`, so without this
    /// they drew as an empty right-aligned bubble.
    var providerReason: ProviderReason?

    var id: EngineID { runId }
}

/// Who sent a turn that a session sent. Open-shaped: the engine may learn to
/// name more than a session.
struct MessageSender: Codable, Equatable {
    var sessionId: EngineID?
    var name: String?
}

/// WHY AN `origin: "session"` TURN WAS QUEUED — the engine's `WakeReason`
/// (packages/engine-client/src/protocol/entities.ts): an OBJECT naming what
/// happened and where, not a word.
///
/// This was declared as a `String?` and it cost more than a wrong label. The
/// snapshot decodes its turns through `Skippable`, so a type mismatch does not
/// throw — it DROPS THE TURN. Every real wake was disappearing from the
/// transcript on every read, and the shape the tests asserted was one the
/// engine has never sent.
///
/// Lenient in three directions, because the alternative is losing the turn
/// again: an unknown `kind` is kept as its raw string, every field but `kind`
/// is optional, and a BARE STRING still decodes — an older engine, or a
/// fixture written before this was understood, should not vanish.
struct WakeReason: Codable, Equatable {
    /// `turn_completed` | `turn_failed` | `turn_stopped` | `request_opened`,
    /// or whatever a newer engine has learned to say.
    var kind: String
    /// The session that did the thing.
    var sessionId: EngineID?
    /// Its turn, for the three turn kinds — and for `request_opened`, the turn
    /// the request belongs to.
    var runId: EngineID?
    var requestId: EngineID?

    init(kind: String, sessionId: EngineID? = nil, runId: EngineID? = nil, requestId: EngineID? = nil) {
        self.kind = kind
        self.sessionId = sessionId
        self.runId = runId
        self.requestId = requestId
    }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let raw = try? single.decode(String.self) {
            kind = raw
            sessionId = nil
            runId = nil
            requestId = nil
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? ""
        sessionId = try? c.decodeIfPresent(EngineID.self, forKey: .sessionId)
        runId = try? c.decodeIfPresent(EngineID.self, forKey: .runId)
        requestId = try? c.decodeIfPresent(EngineID.self, forKey: .requestId)
    }
}

/// WHY THE PROVIDER RESUMED ON ITS OWN. Live shapes, from the journal:
/// `{"kind":"task_notification","taskId":"task_…"}` and `{"kind":"unknown"}`.
///
/// Lenient for the same reason `WakeReason` is: a turn carrying a kind this
/// build has not met must still be a turn, not a dropped row.
struct ProviderReason: Codable, Equatable {
    var kind: String
    var taskId: EngineID?

    init(kind: String, taskId: EngineID? = nil) {
        self.kind = kind
        self.taskId = taskId
    }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let raw = try? single.decode(String.self) {
            kind = raw
            taskId = nil
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? ""
        taskId = try? c.decodeIfPresent(EngineID.self, forKey: .taskId)
    }
}

/// What a provider-started turn's quiet line says. The desktop names the task
/// when it can find it; here the kind carries it, since the phone's row is one
/// line and an id nobody can read is worse than a sentence.
func describeProviderWake(_ reason: ProviderReason?) -> String {
    switch reason?.kind {
    case "task_notification": "A background task finished."
    case "unknown", nil: "The provider resumed on its own."
    default: "The provider resumed on its own."
    }
}

/// What a wake row says when the prompt itself has nothing to show. The
/// engine's own `agentNotice` and the prompt's first line both come first;
/// this is the floor, and it names the KIND rather than repeating the id.
func describeWake(_ reason: WakeReason?) -> String {
    switch reason?.kind {
    case "turn_completed": "A turn finished in another session."
    case "turn_failed": "A turn failed in another session."
    case "turn_stopped": "A turn was stopped in another session."
    case "request_opened": "Another session is waiting on an answer."
    default: "Another session woke this one."
    }
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
