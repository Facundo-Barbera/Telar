import Foundation

/// Mirror of `packages/engine-client/src/protocol/items.ts`.
///
/// The contract's rule for unknown item types is RENDER, not skip — "a
/// silently missing row is worse than an ugly one" — so `ItemDetail` falls
/// back to `.unknown(label:)` instead of throwing, and every enum here decodes
/// with a fallback.

enum ItemStatus: String, Codable {
    case inProgress, completed, failed, declined
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ItemStatus(rawValue: raw) ?? .unknown
    }
}

enum ContentStream: String, Codable {
    case assistantText = "assistant_text"
    case reasoningText = "reasoning_text"
    case commandOutput = "command_output"
    case toolOutput = "tool_output"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ContentStream(rawValue: raw) ?? .unknown
    }
}

struct CommandExecutionDetail: Codable, Equatable {
    var command: String
    var cwd: String?
    var exitCode: Int?
    /// Truncated for transport — a preview, not the output. The full text
    /// streams as `command_output` deltas.
    var outputPreview: String?
    var durationMs: Int?
}

struct FileChangeDetail: Codable, Equatable {
    var path: String
    var kind: String
    var renamedFrom: String?
    var unifiedDiff: String?
    var linesAdded: Int?
    var linesRemoved: Int?
}

struct FileReadDetail: Codable, Equatable {
    var path: String
    var fromLine: Int?
    var toLine: Int?
}

/// `input`/`output` are unknown by contract (MCP schemas belong to the user's
/// servers), carried as raw JSON for generic rendering.
struct ToolCallDetail: Equatable {
    var name: String
    var server: String?
    var input: JSONValue?
    var output: JSONValue?
}

extension ToolCallDetail: Codable {
    private enum CodingKeys: String, CodingKey { case name, server, input, output }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        server = try c.decodeIfPresent(String.self, forKey: .server)
        input = try? c.decodeIfPresent(JSONValue.self, forKey: .input)
        output = try? c.decodeIfPresent(JSONValue.self, forKey: .output)
    }
}

enum PlanStepStatus: String, Codable {
    case pending, inProgress, completed
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PlanStepStatus(rawValue: raw) ?? .pending
    }
}

struct PlanStep: Codable, Equatable {
    var step: String
    var status: PlanStepStatus
}

struct PlanDetail: Codable, Equatable {
    var steps: [PlanStep]
}

struct ErrorDetail: Codable, Equatable {
    var message: String
    var kind: String?
}

/// The contract's discriminated union on `type`.
enum ItemDetail: Equatable {
    case userMessage(text: String)
    case assistantMessage(text: String)
    case reasoning(text: String)
    case plan(PlanDetail)
    case commandExecution(CommandExecutionDetail)
    case fileChange(FileChangeDetail)
    case fileRead(FileReadDetail)
    case mcpToolCall(ToolCallDetail)
    case dynamicToolCall(ToolCallDetail)
    case webSearch(query: String, resultCount: Int?)
    case browserAction(call: ToolCallDetail, url: String?)
    case task(taskId: EngineID)
    case contextCompaction(reason: String?, preTokens: Int?, postTokens: Int?)
    case error(ErrorDetail)
    case unknown(label: String?)
}

extension ItemDetail: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type, text, plan, command, change, read, call, query, resultCount
        case url, taskId, reason, preTokens, postTokens, error, label
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        // A recognised type whose payload fails to decode is treated as
        // unknown rather than thrown: the row survives, ugly.
        func fallback() -> ItemDetail { .unknown(label: type) }
        switch type {
        case "user_message":
            self = (try? c.decode(String.self, forKey: .text)).map { .userMessage(text: $0) } ?? fallback()
        case "assistant_message":
            self = (try? c.decode(String.self, forKey: .text)).map { .assistantMessage(text: $0) } ?? fallback()
        case "reasoning":
            self = (try? c.decode(String.self, forKey: .text)).map { .reasoning(text: $0) } ?? fallback()
        case "plan":
            self = (try? c.decode(PlanDetail.self, forKey: .plan)).map { .plan($0) } ?? fallback()
        case "command_execution":
            self = (try? c.decode(CommandExecutionDetail.self, forKey: .command)).map { .commandExecution($0) } ?? fallback()
        case "file_change":
            self = (try? c.decode(FileChangeDetail.self, forKey: .change)).map { .fileChange($0) } ?? fallback()
        case "file_read":
            self = (try? c.decode(FileReadDetail.self, forKey: .read)).map { .fileRead($0) } ?? fallback()
        case "mcp_tool_call":
            self = (try? c.decode(ToolCallDetail.self, forKey: .call)).map { .mcpToolCall($0) } ?? fallback()
        case "dynamic_tool_call":
            self = (try? c.decode(ToolCallDetail.self, forKey: .call)).map { .dynamicToolCall($0) } ?? fallback()
        case "web_search":
            self = (try? c.decode(String.self, forKey: .query)).map {
                .webSearch(query: $0, resultCount: try? c.decodeIfPresent(Int.self, forKey: .resultCount))
            } ?? fallback()
        case "browser_action":
            self = (try? c.decode(ToolCallDetail.self, forKey: .call)).map {
                .browserAction(call: $0, url: try? c.decodeIfPresent(String.self, forKey: .url))
            } ?? fallback()
        case "task":
            self = (try? c.decode(EngineID.self, forKey: .taskId)).map { .task(taskId: $0) } ?? fallback()
        case "context_compaction":
            self = .contextCompaction(
                reason: try? c.decodeIfPresent(String.self, forKey: .reason),
                preTokens: try? c.decodeIfPresent(Int.self, forKey: .preTokens),
                postTokens: try? c.decodeIfPresent(Int.self, forKey: .postTokens)
            )
        case "error":
            self = (try? c.decode(ErrorDetail.self, forKey: .error)).map { .error($0) } ?? fallback()
        case "unknown":
            self = .unknown(label: try? c.decodeIfPresent(String.self, forKey: .label))
        default:
            self = fallback()
        }
    }

    /// Matches `isToolItem` in items.ts's `ToolItemType`.
    var isTool: Bool {
        switch self {
        case .commandExecution, .fileChange, .fileRead, .mcpToolCall,
             .dynamicToolCall, .webSearch, .browserAction:
            true
        default:
            false
        }
    }
}

/// One timeline row. `title` is engine-produced — the client must not invent
/// collapsed-row labels.
struct Item: Identifiable, Equatable {
    var id: EngineID
    var runId: EngineID
    var sessionId: EngineID
    var status: ItemStatus
    var title: String?
    var detail: ItemDetail
    var startedAt: Timestamp
    var completedAt: Timestamp?
    /// Set when produced inside a sub-agent — filed under that task, not the
    /// main timeline.
    var taskId: EngineID?
    var streamed: String? = nil
    var streamedThrough: Int? = nil
}

extension Item: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, runId, sessionId, status, title, detail, startedAt, completedAt, taskId, streamed, streamedThrough
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(EngineID.self, forKey: .id)
        runId = try c.decode(EngineID.self, forKey: .runId)
        sessionId = try c.decode(EngineID.self, forKey: .sessionId)
        status = try c.decodeIfPresent(ItemStatus.self, forKey: .status) ?? .unknown
        title = try c.decodeIfPresent(String.self, forKey: .title)
        detail = (try? c.decode(ItemDetail.self, forKey: .detail)) ?? .unknown(label: nil)
        startedAt = try c.decode(Timestamp.self, forKey: .startedAt)
        completedAt = try c.decodeIfPresent(Timestamp.self, forKey: .completedAt)
        taskId = try c.decodeIfPresent(EngineID.self, forKey: .taskId)
        streamed = try c.decodeIfPresent(String.self, forKey: .streamed)
        streamedThrough = try c.decodeIfPresent(Int.self, forKey: .streamedThrough)
    }
}

/// Arbitrary JSON, for the tool-call payloads the contract deliberately
/// leaves unknown.
enum JSONValue: Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

extension JSONValue: Codable {
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "not JSON")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// Pretty text for a generic tool-payload view.
    var prettyPrinted: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(self) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}
