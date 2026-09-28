import Foundation

enum RequestDecision: String, Codable {
    case accept
    case acceptForSession
    case decline
    case cancel
}

struct UserInputField: Codable, Identifiable, Equatable {
    var key: String
    var label: String
    var kind: String
    var choices: [String]?
    var required: Bool?
    var multiple: Bool?

    var id: String { key }

    var isMultiSelect: Bool { kind == "choice" && multiple == true }
}

struct SecretCandidate: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var vault: String?
    var domain: String
}

struct SecretAccessField: Codable, Equatable {
    var kind: String
    var label: String?
}

struct SecretAccessDetail: Codable, Equatable {
    var origin: String
    var fields: [SecretAccessField]
    var candidates: [SecretCandidate]
    var hint: String?
}

enum RequestDetail: Equatable {
    case commandExecution(CommandExecutionDetail)
    case fileChange(FileChangeDetail)
    case fileRead(FileReadDetail)
    case toolCall(ToolCallDetail)
    case userInput(prompt: String, fields: [UserInputField])
    case secretAccess(SecretAccessDetail)
    case unknown(kind: String)
}

extension RequestDetail: Decodable {
    private enum CodingKeys: String, CodingKey {
        case kind, command, change, read, call, prompt, fields, secret
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
        case "secret_access":
            self = (try? c.decode(SecretAccessDetail.self, forKey: .secret)).map { .secretAccess($0) } ?? fallback()
        default:
            self = fallback()
        }
    }
}

struct EngineRequest: Identifiable, Equatable {
    var id: EngineID
    var runId: EngineID
    var sessionId: EngineID
    var itemId: EngineID?
    var state: String
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
