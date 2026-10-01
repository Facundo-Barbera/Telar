import Foundation

enum TurnState: String, Codable {
    case queued, claimed, running, completed, failed, stopped
    case ambiguous, discarded, steering, steered

    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TurnState(rawValue: raw) ?? .unknown
    }

    var isActive: Bool {
        self == .queued || self == .claimed || self == .running || self == .steering
    }
}

struct TurnFailure: Codable, Equatable {
    var code: String
    var message: String
}

struct Turn: Codable, Identifiable, Equatable {
    var runId: EngineID
    var sessionId: EngineID
    var sequence: Int
    var state: TurnState
    var input: String

    var kind: String?
    var model: ModelSelection?
    var acceptedAt: Timestamp
    var updatedAt: Timestamp
    var startedAt: Timestamp?
    var completedAt: Timestamp?
    var usage: UsageSnapshot?
    var resultText: String?
    var failure: TurnFailure?

    var origin: String?

    var sender: MessageSender?

    var agentIntent: String?
    var agentDelivery: String?
    var agentSourceRunId: EngineID?
    var assignmentScope: String?

    var wakeReason: WakeReason?

    var agentNotice: String?

    var notification: NotificationDetail?

    var providerReason: ProviderReason?

    var attachments: [TurnAttachment]?

    var id: EngineID { runId }
}

struct MessageSender: Codable, Equatable {
    var sessionId: EngineID?
    var name: String?
}

struct WakeReason: Codable, Equatable {
    var kind: String

    var sessionId: EngineID?

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

func describeProviderWake(_ reason: ProviderReason?) -> String {
    switch reason?.kind {
    case "task_notification": "A background task finished."
    case "unknown", nil: "The provider resumed on its own."
    default: "The provider resumed on its own."
    }
}

func notificationVerb(kind: String, intent: String? = nil, wakeKind: String? = nil) -> String {
    if kind == "peer_message" {
        switch intent ?? "report" {
        case "task": return "A session assigned work"
        case "blocker": return "A session reported a blocker"
        case "result": return "A session sent a result"
        default: return "A session sent a message"
        }
    }

    if kind == "request" || wakeKind == "request_opened" { return "Session asked a question" }
    switch wakeKind {
    case "turn_completed": return "Session finished a turn"
    case "turn_failed": return "Session failed a turn"
    case "turn_stopped": return "Session was stopped"

    default: return "Session activity"
    }
}

let notificationHeadChars = 80

func stripNotificationKind(_ line: String) -> String {
    guard line.hasPrefix("["), let close = line.firstIndex(of: "]") else { return line }
    return String(line[line.index(after: close)...]).trimmingCharacters(in: .whitespaces)
}

func notificationHead(_ text: String?, limit: Int = notificationHeadChars) -> String? {
    let line = (text ?? "").split(separator: "\n", omittingEmptySubsequences: false)
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .first { !$0.isEmpty }
    guard let line else { return nil }
    let stripped = stripNotificationKind(line)
    if stripped.isEmpty { return nil }
    if stripped.count <= limit { return stripped }
    return String(stripped.prefix(limit - 1)) + "…"
}

func describeWake(_ reason: WakeReason?) -> String {
    notificationVerb(kind: reason?.kind == "request_opened" ? "request" : "wake", wakeKind: reason?.kind)
}

func agentSenderLabel(_ sender: MessageSender?) -> String {
    guard let id = sender?.sessionId, !id.isEmpty else { return "agent · outside any session" }
    return "agent · session …\(id.suffix(6))"
}

struct TurnSubmissionResult: Codable {
    var turn: Turn

    var replayed: Bool
}
