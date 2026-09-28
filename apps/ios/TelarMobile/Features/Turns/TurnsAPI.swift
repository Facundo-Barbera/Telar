import Foundation

protocol TurnsAPI: Sendable {
    func submitTurn(_ id: EngineID, runId: String, input: String, attachments: [EngineID]?) async throws -> TurnSubmissionResult
    func stopTurn(_ id: EngineID, runId: String) async throws
    func resolveRequest(
        _ id: EngineID, requestId: EngineID,
        decision: RequestDecision, reason: String?, answers: [String: AnswerValue]?
    ) async throws
    func promoteTurn(_ id: EngineID, runId: String) async throws
    func uploadAttachment(_ id: EngineID, name: String, mediaType: String, data: Data) async throws -> TurnAttachment
}

enum AnswerValue: Encodable, Equatable {
    case text(String)
    case bool(Bool)
    case list([String])

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .text(let s): try c.encode(s)
        case .bool(let b): try c.encode(b)
        case .list(let labels): try c.encode(labels)
        }
    }
}

enum RunID {
    static func newRunId() -> String {
        "run_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}

extension HTTPEngineAPI: TurnsAPI {
    func submitTurn(_ id: EngineID, runId: String, input: String, attachments: [EngineID]? = nil) async throws -> TurnSubmissionResult {
        var body: [String: AnyEncodable] = ["runId": AnyEncodable(runId), "input": AnyEncodable(input)]
        if let attachments, !attachments.isEmpty { body["attachments"] = AnyEncodable(attachments) }
        return try await post("api/sessions/\(escape(id))/turns", body: body)
    }

    func stopTurn(_ id: EngineID, runId: String) async throws {
        let body = ["runId": AnyEncodable(runId)]
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/stop", body: body)
    }

    func resolveRequest(
        _ id: EngineID, requestId: EngineID,
        decision: RequestDecision, reason: String?, answers: [String: AnswerValue]?
    ) async throws {
        var body: [String: AnyEncodable] = ["decision": AnyEncodable(decision.rawValue)]
        if let reason { body["reason"] = AnyEncodable(reason) }
        if let answers { body["answers"] = AnyEncodable(answers) }
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/requests/\(escape(requestId))", body: body)
    }

    func promoteTurn(_ id: EngineID, runId: String) async throws {
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/turns/\(escape(runId))/promote", body: [:])
    }

    func uploadAttachment(_ id: EngineID, name: String, mediaType: String, data: Data) async throws -> TurnAttachment {
        var request = makeRequest(url("api/sessions/\(escape(id))/attachments"))
        request.httpMethod = "POST"
        request.setValue(mediaType, forHTTPHeaderField: "content-type")
        request.setValue(
            name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "attachment",
            forHTTPHeaderField: "x-telar-attachment-name"
        )
        request.httpBody = data
        struct Wrapped: Decodable { var attachment: TurnAttachment }
        let wrapped: Wrapped = try await perform(request)
        return wrapped.attachment
    }
}
