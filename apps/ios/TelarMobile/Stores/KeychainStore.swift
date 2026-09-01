import Foundation
import Security

/// One secret, one item: the cockpit device token. Keychain rather than
/// UserDefaults because it IS a secret — unlike the base URL, which stays in
/// UserDefaults per AppSettings' own comment. AfterFirstUnlock so a
/// background refresh can authenticate while the phone is locked.
enum KeychainStore {
    /// SCOPED TO THIS FLAVOR'S OWN BUNDLE ID, not a shared literal. The
    /// nightly and Telar Dev are separate apps with separate cockpits'
    /// worth of trust; a hard-coded service made every flavor read as
    /// "paired" the moment any one of them was — including a pairing
    /// inherited from a long-deleted install, because the keychain outlives
    /// the app that wrote it.
    private static let service = Bundle.main.bundleIdentifier ?? "com.telar.mobile"
    private static let legacyService = "com.telar.mobile"

    private static func query(service: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "deviceToken",
        ]
    }

    private static func read(service: String) -> String? {
        var item = query(service: service)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(item as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func read() -> String? {
        if let token = read(service: service) { return token }
        // One-time migration for installs that stored under the shared
        // literal (only the flavor whose bundle id IS the literal skips
        // this, harmlessly — same service twice).
        guard service != legacyService, let token = read(service: legacyService) else { return nil }
        write(token)
        SecItemDelete(query(service: legacyService) as CFDictionary)
        return token
    }

    static func write(_ token: String) {
        delete()
        var item = query(service: service)
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(item as CFDictionary, nil)
    }

    static func delete() {
        SecItemDelete(query(service: service) as CFDictionary)
    }
}
