import Foundation

protocol FilesAPI: Sendable {
    func sessionFiles(_ id: EngineID) async throws -> WorkspaceListing
    func sessionFile(_ id: EngineID, path: String) async throws -> WorkspaceFile
    func writeSessionFile(_ id: EngineID, path: String, text: String, expectedSha256: String) async throws -> WorkspaceWriteResult
    func sessionFileRaw(_ id: EngineID, path: String) async throws -> RawFile
}

extension HTTPEngineAPI: FilesAPI {
    func sessionFiles(_ id: EngineID) async throws -> WorkspaceListing {
        struct Wrapped: Decodable { var listing: WorkspaceListing }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/files")
        return wrapped.listing
    }

    func sessionFile(_ id: EngineID, path: String) async throws -> WorkspaceFile {
        struct Wrapped: Decodable { var file: WorkspaceFile }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/files", query: [URLQueryItem(name: "path", value: path)])
        return wrapped.file
    }

    func writeSessionFile(_ id: EngineID, path: String, text: String, expectedSha256: String) async throws -> WorkspaceWriteResult {
        try await send(
            "PUT", "api/sessions/\(escape(id))/files",
            query: [URLQueryItem(name: "path", value: path)],
            body: ["text": AnyEncodable(text), "expectedSha256": AnyEncodable(expectedSha256)]
        )
    }

    func sessionFileRaw(_ id: EngineID, path: String) async throws -> RawFile {
        try await rawFile(makeRequest(url("api/sessions/\(escape(id))/files/raw", query: [URLQueryItem(name: "path", value: path)])))
    }
}
