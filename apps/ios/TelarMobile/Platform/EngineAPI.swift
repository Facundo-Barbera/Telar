import Foundation

typealias EngineAPI = HostsAPI & SessionsAPI & TurnsAPI & DictationAPI & ProjectsAPI & ProvidersAPI & GitAPI & UsageAPI & RemoteAPI

typealias PanelAPI = ProjectListAPI & FilesAPI & PluginsAPI

enum EngineAPIError: Error, LocalizedError {
    case engine(code: String, message: String, status: Int)

    case badResponse(status: Int)

    case incompatible(status: Int)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .engine(let code, let message, _):
            switch code {
            case "cockpit_unauthorized": "This phone is not paired with the cockpit — get a pairing code from Settings → Remote access."
            case "cockpit_forbidden": "This phone is paired for viewing only — give it full access from Remote access on the Mac."
            case "engine_unavailable": "The Mac's engine is down — the cockpit is up but can't reach it."
            case "worker_unavailable": "No worker is running on the Mac to take the turn."
            case "not_found": "That no longer exists on the engine."
            default: message
            }
        case .badResponse(let status): "Unexpected response (\(status)) — is the base URL a Telar cockpit?"
        case .incompatible: "The Mac and this app are on very different versions — update whichever is older."
        case .transport(let error): error.localizedDescription
        }
    }

    var isNotFound: Bool {
        if case .engine(let code, _, _) = self { return code == "not_found" }
        return false
    }

    var isUnauthorized: Bool {
        if case .engine(let code, _, _) = self { return code == "cockpit_unauthorized" }
        return false
    }

    var isForbidden: Bool {
        if case .engine(let code, _, _) = self { return code == "cockpit_forbidden" }
        return false
    }

    static func failure(_ data: Data, status: Int) -> EngineAPIError {
        guard let body = try? JSONDecoder().decode(EngineErrorBody.self, from: data) else { return .badResponse(status: status) }
        return .engine(code: body.error.code, message: body.error.message, status: status)
    }
}

struct RawFile: Sendable {
    var data: Data
    var contentType: String?
}

struct HTTPEngineAPI: Sendable {
    let baseURL: URL

    let deviceToken: String?
    let session: URLSession

    let failover: (@Sendable (URL) async -> URL?)?

    init(baseURL: URL, deviceToken: String? = nil, session: URLSession? = nil,
         failover: (@Sendable (URL) async -> URL?)? = nil) {
        self.baseURL = baseURL
        self.deviceToken = deviceToken
        self.failover = failover
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default

            config.timeoutIntervalForRequest = 30

            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    func escape(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    }

    func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        return components.url!
    }

    func makeRequest(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if let deviceToken {
            request.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await perform(makeRequest(url(path, query: query)))
    }

    func post<T: Decodable>(_ path: String, body: [String: AnyEncodable]) async throws -> T {
        try await send("POST", path, body: body)
    }

    func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: B) async throws -> T {
        try await perform(jsonRequest(method, url(path, query: query), body: body))
    }

    func delete<T: Decodable>(_ path: String) async throws -> T {
        var request = makeRequest(url(path))
        request.httpMethod = "DELETE"
        return try await perform(request)
    }

    func jsonRequest<B: Encodable>(_ method: String, _ url: URL, body: B) throws -> URLRequest {
        var request = makeRequest(url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    func exchange(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch {
            guard HostAddresses.isTransportFailure(error), let failover,
                  let moved = await failover(baseURL),
                  ["GET", "HEAD"].contains(request.httpMethod ?? "GET"),
                  let url = request.url, let rebased = HostAddresses.rebase(url, from: baseURL, to: moved)
            else { throw EngineAPIError.transport(error) }
            var retry = request
            retry.url = rebased
            do {
                return try await session.data(for: retry)
            } catch {
                throw EngineAPIError.transport(error)
            }
        }
    }

    func rawFile(_ request: URLRequest) async throws -> RawFile {
        let (data, response) = try await exchange(request)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw EngineAPIError.failure(data, status: status) }
        return RawFile(data: data, contentType: http?.value(forHTTPHeaderField: "content-type"))
    }

    func perform<T: Decodable & Sendable>(_ request: URLRequest) async throws -> T {
        let (data, status) = try await raw(request)
        return try await decode(data, status: status)
    }

    func decode<T: Decodable & Sendable>(_ data: Data, status: Int) async throws -> T {
        try await Task.detached(priority: .userInitiated) {
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                throw EngineAPIError.incompatible(status: status)
            }
        }.value
    }

    func raw(_ request: URLRequest) async throws -> (Data, Int) {
        let (data, response) = try await exchange(request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw EngineAPIError.failure(data, status: status) }
        return (data, status)
    }
}

struct IgnoredBody: Decodable {
    init(from decoder: Decoder) {}
}

struct AnyEncodable: Encodable {
    private let encodeFn: (Encoder) throws -> Void
    init<T: Encodable>(_ value: T) {
        encodeFn = { try value.encode(to: $0) }
    }
    func encode(to encoder: Encoder) throws {
        try encodeFn(encoder)
    }
}
