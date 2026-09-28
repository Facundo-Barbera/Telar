import Foundation

protocol GitAPI: Sendable {
    func sessionDiff(_ id: EngineID) async throws -> SessionDiff
    func filePatch(_ id: EngineID, path: String, untracked: Bool) async throws -> FilePatch
    func projectGit(_ projectId: EngineID) async throws -> GitOverview
}

extension HTTPEngineAPI: GitAPI {
    func sessionDiff(_ id: EngineID) async throws -> SessionDiff {
        struct Wrapped: Decodable { var diff: SessionDiff }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/diff")
        return wrapped.diff
    }

    func filePatch(_ id: EngineID, path: String, untracked: Bool) async throws -> FilePatch {
        var query = [URLQueryItem(name: "path", value: path)]
        if untracked { query.append(URLQueryItem(name: "untracked", value: "1")) }
        struct Wrapped: Decodable { var file: FilePatch }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/diff", query: query)
        return wrapped.file
    }

    func projectGit(_ projectId: EngineID) async throws -> GitOverview {
        struct Wrapped: Decodable { var git: GitOverview }
        let wrapped: Wrapped = try await get("api/projects/\(escape(projectId))/git")
        return wrapped.git
    }
}
