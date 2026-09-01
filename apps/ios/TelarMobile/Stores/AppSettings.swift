import Foundation
import Observation

/// Connection settings. The base URL is a full URL string (so the ts.net
/// HTTPS upgrade is a settings edit) and stays in UserDefaults — it is an
/// address, not a secret. The DEVICE TOKEN is the secret, and it lives in the
/// Keychain via KeychainStore, exactly as this file promised it would the day
/// /api grew auth.
@MainActor @Observable final class AppSettings {
    private static let key = "telar.baseURL"

    var baseURLString: String {
        didSet { UserDefaults.standard.set(baseURLString, forKey: Self.key) }
    }

    /// The pairing credential. Nil against an open cockpit.
    var deviceToken: String? {
        didSet {
            if let deviceToken { KeychainStore.write(deviceToken) } else { KeychainStore.delete() }
        }
    }

    init() {
        baseURLString = UserDefaults.standard.string(forKey: Self.key) ?? ""
        deviceToken = KeychainStore.read()
    }

    var baseURL: URL? {
        guard !baseURLString.isEmpty else { return nil }
        guard let url = URL(string: baseURLString), url.scheme?.hasPrefix("http") == true, url.host() != nil else { return nil }
        return url
    }

    /// One shared client, rebuilt when the URL or credential changes. Nil
    /// until configured.
    var api: HTTPEngineAPI? {
        baseURL.map { HTTPEngineAPI(baseURL: $0, deviceToken: deviceToken) }
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
