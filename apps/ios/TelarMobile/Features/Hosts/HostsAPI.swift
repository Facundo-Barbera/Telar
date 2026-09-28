import Foundation

protocol HostsAPI: Sendable {
    func health() async throws -> EngineHealth
}

struct Pong: Decodable {
    var ok: Bool

    var proto: Int?
}

extension HTTPEngineAPI: HostsAPI {
    func health() async throws -> EngineHealth {
        try await get("api/health")
    }

    func ping() async throws -> Pong {
        try await get("api/ping")
    }

    private static let probeSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        config.timeoutIntervalForResource = 3
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    static func probe(_ base: URL) async -> Bool {
        guard let (data, response) = try? await probeSession.data(from: base.appending(path: "api/ping")),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let pong = try? JSONDecoder().decode(Pong.self, from: data)
        else { return false }
        return pong.ok
    }
}
