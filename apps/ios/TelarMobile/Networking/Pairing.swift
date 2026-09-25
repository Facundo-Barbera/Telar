import Foundation

/// The pairing exchange: a one-time token from the cockpit's QR buys this
/// phone a long-lived device token.
enum Pairing {
    /// Parses `<base>/pair#token=…`. The token is the cockpit's eight-digit
    /// pairing code (an older cockpit's `tlr_…` token is accepted too, so a
    /// QR it is still showing keeps working). It must ride the FRAGMENT — a
    /// query-string token has been in someone's server log, and refusing it
    /// here keeps the contract honest end to end.
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

    /// Eight digits (the current cockpit) or a `tlr_` token (an older one).
    /// Anything else is not a pairing secret and the QR/link is refused before
    /// a network call is made with it.
    static func looksLikePairingSecret(_ token: String) -> Bool {
        if token.hasPrefix("tlr_") { return true }
        return token.count == 8 && token.allSatisfy(\.isNumber)
    }

    /// Only the token is load-bearing; requiring more would make the exchange
    /// fail against a cockpit that trims or renames the courtesy fields.
    struct ExchangeResponse: Decodable {
        var deviceToken: String
        var deviceId: String?
        var deviceName: String?
        /// Every address the Mac answers on (#832), so a phone paired on the
        /// LAN already knows the tailnet one. Absent from older cockpits.
        var addresses: [String]?
    }

    static func exchange(
        base: URL, token: String, deviceName: String, session: URLSession = .shared
    ) async throws -> ExchangeResponse {
        var request = URLRequest(url: base.appending(path: "api/pair"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        // Platform is self-declared, never sniffed server-side.
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
