import Foundation

/// Mirror of `packages/engine-client/src/protocol/requests.ts` — the things
/// that need a human. While one is open, no further work happens on the
/// session, which is exactly why the phone exists.

enum RequestDecision: String, Codable {
    case accept
    /// Accept and stop asking for this kind of thing this session.
    case acceptForSession
    case decline
    /// Withdraw the whole turn rather than answering.
    case cancel
}

struct UserInputField: Codable, Identifiable, Equatable {
    var key: String
    var label: String
    var kind: String // text | secret | choice | boolean
    var choices: [String]?
    var required: Bool?

    var id: String { key }
}

enum RequestDetail: Equatable {
    case commandExecution(CommandExecutionDetail)
    case fileChange(FileChangeDetail)
    case fileRead(FileReadDetail)
    case toolCall(ToolCallDetail)
    case userInput(prompt: String, fields: [UserInputField])
    /// An approval kind this build does not know. Still renders a card that
    /// can accept or decline — parking the session silently would be worse.
    case unknown(kind: String)
}

extension RequestDetail: Decodable {
    private enum CodingKeys: String, CodingKey {
        case kind, command, change, read, call, prompt, fields
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        func fallback() -> RequestDetail { .unknown(kind: kind) }
        switch kind {
        case "command_execution":
            self = (try? c.decode(CommandExecutionDetail.self, forKey: .command)).map { .commandExecution($0) } ?? fallback()
        case "file_change":
            self = (try? c.decode(FileChangeDetail.self, forKey: .change)).map { .fileChange($0) } ?? fallback()
        case "file_read":
            self = (try? c.decode(FileReadDetail.self, forKey: .read)).map { .fileRead($0) } ?? fallback()
        case "tool_call":
            self = (try? c.decode(ToolCallDetail.self, forKey: .call)).map { .toolCall($0) } ?? fallback()
        case "user_input":
            if let prompt = try? c.decode(String.self, forKey: .prompt),
               let fields = try? c.decode([UserInputField].self, forKey: .fields) {
                self = .userInput(prompt: prompt, fields: fields)
            } else {
                self = fallback()
            }
        default:
            self = fallback()
        }
    }

    /// A question is answered, not permitted — it renders a form, and it is
    /// never auto-resolved by any runtime mode.
    var isUserInput: Bool {
        if case .userInput = self { return true }
        return false
    }
}

struct EngineRequest: Identifiable, Equatable {
    var id: EngineID
    var runId: EngineID
    var sessionId: EngineID
    var itemId: EngineID?
    var state: String // open | resolved
    var detail: RequestDetail
    var openedAt: Timestamp
    var decision: RequestDecision?
    var resolvedAt: Timestamp?
    var reason: String?

    var isOpen: Bool { state == "open" }
}

extension EngineRequest: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, runId, sessionId, itemId, state, detail, openedAt
        case decision, resolvedAt, reason
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(EngineID.self, forKey: .id)
        runId = try c.decode(EngineID.self, forKey: .runId)
        sessionId = try c.decode(EngineID.self, forKey: .sessionId)
        itemId = try c.decodeIfPresent(EngineID.self, forKey: .itemId)
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "open"
        detail = (try? c.decode(RequestDetail.self, forKey: .detail)) ?? .unknown(kind: "unknown")
        openedAt = try c.decode(Timestamp.self, forKey: .openedAt)
        decision = try? c.decodeIfPresent(RequestDecision.self, forKey: .decision)
        resolvedAt = try c.decodeIfPresent(Timestamp.self, forKey: .resolvedAt)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
    }
}
