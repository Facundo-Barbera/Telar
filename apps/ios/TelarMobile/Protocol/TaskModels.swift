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
    var resultText: String?
    var failure: String?

    private enum CodingKeys: String, CodingKey {
        case id, sessionId, runId, kind, state, title, role
        case startedAt, updatedAt, completedAt, parentTaskId, resultText, failure
    }
}
