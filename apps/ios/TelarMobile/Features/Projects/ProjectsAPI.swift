import Foundation

protocol ProjectsAPI: Sendable {
    func projectIcon(_ projectId: EngineID, icon: String) async throws -> Data
    func listDirectories(path: String?) async throws -> DirectoryListing
    func registerProject(name: String, root: String) async throws -> ProjectRef
}

protocol ProjectListAPI: Sendable {
    func projects() async throws -> [Project]
}

extension HTTPEngineAPI: ProjectsAPI, ProjectListAPI {
    func projectIcon(_ projectId: EngineID, icon: String) async throws -> Data {
        let query = [URLQueryItem(name: "v", value: icon), URLQueryItem(name: "format", value: "png")]
        return try await raw(makeRequest(url("api/projects/\(escape(projectId))/icon", query: query))).0
    }

    func listDirectories(path: String?) async throws -> DirectoryListing {
        var query: [URLQueryItem] = []
        if let path { query.append(URLQueryItem(name: "path", value: path)) }
        return try await get("api/fs", query: query)
    }

    func registerProject(name: String, root: String) async throws -> ProjectRef {
        struct Wrapped: Decodable { var project: ProjectRef }
        let wrapped: Wrapped = try await send("POST", "api/projects", body: ["name": AnyEncodable(name), "root": AnyEncodable(root)])
        return wrapped.project
    }

    func projects() async throws -> [Project] {
        let list: ProjectList = try await get("api/projects")
        return list.projects
    }
}
