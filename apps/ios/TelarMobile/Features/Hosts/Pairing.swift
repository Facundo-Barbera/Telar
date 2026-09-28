import Foundation

enum Pairing {
    static func parsePairingURL(_ text: String) -> (base: URL, token: String)? {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme == "http" || components.scheme == "https",
              components.host != nil,
              components.queryItems?.contains(where: { $0.name == "token" }) != true,
              let fragment = components.fragment
        else { return nil }
        let params = fragment.split(separator: "&").reduce(into: [String: String]()) { result, pair in
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            if parts.count == 2 { result[parts[0]] = parts[1] }
        }
        guard let token = params["token"], Self.looksLikePairingSecret(token) else { return nil }
        var base = components
        base.fragment = nil
        base.query = nil
        base.path = base.path.hasSuffix("/pair") ? String(base.path.dropLast("/pair".count)) : base.path
        guard let baseURL = base.url else { return nil }
        return (baseURL, token)
    }

    static func looksLikePairingSecret(_ token: String) -> Bool {
        if token.hasPrefix("tlr_") { return true }
        return token.count == 8 && token.allSatisfy(\.isNumber)
    }

    struct ExchangeResponse: Decodable {
        var deviceToken: String
        var deviceId: String?
        var deviceName: String?
        var addresses: [String]?
    }

    static func exchange(
        base: URL, token: String, deviceName: String, session: URLSession = .shared
    ) async throws -> ExchangeResponse {
        var request = URLRequest(url: base.appending(path: "api/pair"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["token": token, "deviceName": deviceName, "platform": "ios"])
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let body = try? JSONDecoder().decode(EngineErrorBody.self, from: data) {
                throw EngineAPIError.engine(code: body.error.code, message: body.error.message, status: status)
            }
            throw EngineAPIError.badResponse(status: status)
        }
        return try JSONDecoder().decode(ExchangeResponse.self, from: data)
    }
}
