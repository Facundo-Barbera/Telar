import Foundation

protocol ProvidersAPI: Sendable {
    func models(driver: String) async throws -> ModelCatalogue
    func providerInstances() async throws -> [ProviderInstance]
    func sessionSkills(_ id: EngineID) async throws -> ProviderSkills
    func projectSkills(_ projectId: EngineID, driver: String?) async throws -> ProviderSkills
}

struct ProviderSkill: Decodable, Equatable, Sendable {
    var name: String
    var description: String
    var source: String
}

struct ProviderSkills: Decodable, Equatable, Sendable {
    var skills: [ProviderSkill]
    var commands: [ProviderSkill]

    static let empty = ProviderSkills(skills: [], commands: [])
}

extension HTTPEngineAPI: ProvidersAPI {
    func models(driver: String) async throws -> ModelCatalogue {
        struct Wrapped: Decodable { var catalogue: ModelCatalogue }
        let wrapped: Wrapped = try await get("api/models", query: [URLQueryItem(name: "driver", value: driver)])
        return wrapped.catalogue
    }

    func providerInstances() async throws -> [ProviderInstance] {
        struct Wrapped: Decodable { var providerInstances: [ProviderInstance] }
        let wrapped: Wrapped = try await get("api/provider-instances")
        return wrapped.providerInstances
    }

    func sessionSkills(_ id: EngineID) async throws -> ProviderSkills {
        try await get("api/sessions/\(escape(id))/skills")
    }

    func projectSkills(_ projectId: EngineID, driver: String?) async throws -> ProviderSkills {
        try await get("api/projects/\(escape(projectId))/skills", query: driver.map { [URLQueryItem(name: "driver", value: $0)] } ?? [])
    }
}
