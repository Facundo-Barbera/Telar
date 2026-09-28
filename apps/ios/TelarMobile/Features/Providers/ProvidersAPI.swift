import Foundation

protocol ProvidersAPI: Sendable {
    func models(driver: String) async throws -> ModelCatalogue
    func providerInstances() async throws -> [ProviderInstance]
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
}
