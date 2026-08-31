import Foundation
import Observation

/// Connection settings. A full URL string rather than host/port parts, so the
/// eventual `tailscale serve` HTTPS upgrade is a settings edit, not a code
/// change. UserDefaults, not Keychain — there is no secret in it; the tailnet
/// ACL is the auth boundary. If /api ever grows a token, that moves here AND
/// into Keychain together.
@MainActor @Observable final class AppSettings {
    private static let key = "telar.baseURL"

    var baseURLString: String {
        didSet { UserDefaults.standard.set(baseURLString, forKey: Self.key) }
    }

    init() {
        baseURLString = UserDefaults.standard.string(forKey: Self.key) ?? ""
    }

    var baseURL: URL? {
        guard !baseURLString.isEmpty else { return nil }
        guard let url = URL(string: baseURLString), url.scheme?.hasPrefix("http") == true, url.host() != nil else { return nil }
        return url
    }

    /// One shared client, rebuilt when the URL changes. Nil until configured.
    var api: HTTPEngineAPI? {
        baseURL.map { HTTPEngineAPI(baseURL: $0) }
    }

    static func normalize(host: String, port: String) -> String {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
            return trimmed
        }
        let portPart = port.trimmingCharacters(in: .whitespaces)
        return "http://\(trimmed):\(portPart.isEmpty ? "3000" : portPart)"
    }
}
