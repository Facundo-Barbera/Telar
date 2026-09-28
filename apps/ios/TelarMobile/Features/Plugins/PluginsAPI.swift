import Foundation

protocol PluginsAPI: Sendable {
    func sessionTable(_ id: EngineID, path: String, offset: Int, limit: Int, sort: String?, desc: Bool) async throws -> TableWindow
    func attachments(_ id: EngineID, tag: String?) async throws -> [TurnAttachment]
    func attachmentBytes(_ id: EngineID, attachmentId: EngineID) async throws -> RawFile
    func tagAttachment(_ id: EngineID, attachmentId: EngineID, tags: [String]) async throws -> TurnAttachment
    func ds<T: Decodable & Sendable>(_ id: EngineID, method: String, body: JSONValue) async throws -> T
    func latex<T: Decodable & Sendable>(_ id: EngineID, method: String, body: JSONValue) async throws -> T
}

extension PluginsAPI {
    func kernel(_ id: EngineID) async throws -> KernelStatus { try await ds(id, method: "kernel", body: .object([:])) }
    func kernelInterrupt(_ id: EngineID) async throws { let _: JSONValue = try await ds(id, method: "interrupt", body: .object([:])) }
    func kernelRestart(_ id: EngineID) async throws { let _: JSONValue = try await ds(id, method: "restart", body: .object([:])) }
    func kernelVars(_ id: EngineID, limit: Int = 200) async throws -> [VarRow] {
        try await ds(id, method: "vars", body: .object(["limit": .number(Double(limit))]))
    }
    func kernelInspect(_ id: EngineID, name: String, depth: Int = 10) async throws -> JSONValue {
        try await ds(id, method: "inspect", body: .object(["name": .string(name), "depth": .number(Double(depth))]))
    }
    func packages(_ id: EngineID) async throws -> PackageList { try await ds(id, method: "packages", body: .object([:])) }
    func notebookRead(_ id: EngineID, path: String, withOutputs: Bool = true) async throws -> NotebookRead {
        try await ds(id, method: "notebook/read", body: .object(["path": .string(path), "withOutputs": .bool(withOutputs)]))
    }
    func notebookEdit(_ id: EngineID, path: String, edit: JSONValue) async throws -> NotebookRead {
        try await ds(id, method: "notebook/edit", body: .object(["path": .string(path), "edit": edit]))
    }
    func notebookRun(_ id: EngineID, path: String, cellId: String?, all: Bool = false) async throws -> NotebookRunResult {
        var body: [String: JSONValue] = ["path": .string(path)]
        if let cellId { body["cellId"] = .string(cellId) }
        if all { body["all"] = .bool(true) }
        return try await ds(id, method: "notebook/run", body: .object(body))
    }
    func latexStatus(_ id: EngineID) async throws -> LatexCompileStatus { try await latex(id, method: "status", body: .object([:])) }
    func latexCompile(_ id: EngineID, path: String?) async throws -> LatexCompileAnswer {
        try await latex(id, method: "compile", body: .object(path.map { ["path": .string($0)] } ?? [:]))
    }
    func latexToolchain(_ id: EngineID) async throws -> LatexToolchain { try await latex(id, method: "toolchain", body: .object([:])) }
}

extension HTTPEngineAPI: PluginsAPI {
    func sessionTable(_ id: EngineID, path: String, offset: Int, limit: Int, sort: String?, desc: Bool) async throws -> TableWindow {
        var query = [
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "offset", value: String(offset)),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        if let sort { query.append(URLQueryItem(name: "sort", value: sort)) }
        if desc { query.append(URLQueryItem(name: "desc", value: "1")) }
        return try await get("api/sessions/\(escape(id))/data/table", query: query)
    }

    func attachments(_ id: EngineID, tag: String?) async throws -> [TurnAttachment] {
        struct Wrapped: Decodable { var attachments: [Skippable<TurnAttachment>] }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/attachments", query: tag.map { [URLQueryItem(name: "tag", value: $0)] } ?? [])
        return wrapped.attachments.compactMap(\.value)
    }

    func attachmentBytes(_ id: EngineID, attachmentId: EngineID) async throws -> RawFile {
        try await rawFile(makeRequest(url("api/sessions/\(escape(id))/attachments/\(escape(attachmentId))")))
    }

    func tagAttachment(_ id: EngineID, attachmentId: EngineID, tags: [String]) async throws -> TurnAttachment {
        struct Wrapped: Decodable { var attachment: TurnAttachment }
        let wrapped: Wrapped = try await send("PATCH", "api/sessions/\(escape(id))/attachments/\(escape(attachmentId))", body: ["tags": AnyEncodable(tags)])
        return wrapped.attachment
    }

    func ds<T: Decodable & Sendable>(_ id: EngineID, method: String, body: JSONValue) async throws -> T {
        try await door("ds", id, method: method, body: body)
    }

    func latex<T: Decodable & Sendable>(_ id: EngineID, method: String, body: JSONValue) async throws -> T {
        try await door("latex", id, method: method, body: body)
    }

    private func door<T: Decodable & Sendable>(_ door: String, _ id: EngineID, method: String, body: JSONValue) async throws -> T {
        let path = "api/sessions/\(escape(id))/\(door)/" + method.split(separator: "/").map { escape(String($0)) }.joined(separator: "/")
        let (data, status) = try await raw(jsonRequest("POST", url(path), body: body))
        return try await Task.detached(priority: .userInitiated) {
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                throw EngineAPIError.engine(code: "unexpected_answer", message: "The Mac answered \(door)/\(method) in a shape this app cannot read.", status: status)
            }
        }.value
    }
}
