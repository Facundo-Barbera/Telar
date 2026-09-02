import Foundation

/// Mirror of `Task` in `packages/engine-client/src/protocol/tasks.ts` —
/// named `AgentTask` because `Task` is Swift concurrency's.

enum TaskKind: String, Codable {
    case agent, background

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        // Denylist-shaped per the contract: anything unrecognised is treated
        // as an agent so new kinds show up unstyled rather than invisible.
        self = TaskKind(rawValue: raw) ?? .agent
    }
}

enum TaskState: String, Codable {
    case pending, running, waiting, completed, failed, stopped

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TaskState(rawValue: raw) ?? .completed
    }

    var isLive: Bool {
        self == .pending || self == .running || self == .waiting
    }
}

/// Warp-specific linkage, present only on tasks belonging to a warp run.
///
/// DECODED FOR ONE REASON: a warp run's own row is `background` — it outlives
/// the turn that started it — so any rule that filters background work out of
/// the conversation would take the run with it and leave its agents as loose
/// chips under no heading. The linkage is what tells a background job apart
/// from a fan-out. The phone draws no progress tree, so only the fields that
/// answer "is this a warp, and whose" are mirrored.
struct WarpLinkage: Codable, Equatable {
    var warpRunId: EngineID
    var warpName: String
}

struct AgentTask: Codable, Identifiable, Equatable {
    var id: EngineID
    var sessionId: EngineID
    /// The turn that launched it. A background task may outlive this turn.
    var runId: EngineID
    var kind: TaskKind
    var state: TaskState
    var title: String?
    var role: String?
    var startedAt: Timestamp
    var updatedAt: Timestamp
    var completedAt: Timestamp?
    var parentTaskId: EngineID?
    var warp: WarpLinkage?
    var resultText: String?
    var failure: String?

    private enum CodingKeys: String, CodingKey {
        case id, sessionId, runId, kind, state, title, role
        case startedAt, updatedAt, completedAt, parentTaskId, warp, resultText, failure
    }
}
