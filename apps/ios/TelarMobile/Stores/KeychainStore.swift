import Foundation
import Security

/// The cockpit device tokens. Keychain rather than UserDefaults because they
/// ARE secrets — unlike the base URLs, which stay in UserDefaults per
/// AppSettings' own comment. AfterFirstUnlock so a background refresh can
/// authenticate while the phone is locked.
///
/// Accounts are host-scoped ("deviceToken.<hostId>") — one phone holds one
/// credential PER MAC. The unscoped account "deviceToken" is the pre-multi-
/// host singleton, read only by the migration.
enum KeychainStore {
    /// SCOPED TO THIS FLAVOR'S OWN BUNDLE ID, not a shared literal. The
    /// nightly and Telar Dev are separate apps with separate cockpits'
    /// worth of trust; a hard-coded service made every flavor read as
    /// "paired" the moment any one of them was — including a pairing
    /// inherited from a long-deleted install, because the keychain outlives
    /// the app that wrote it.
    private static let service = Bundle.main.bundleIdentifier ?? "com.telar.mobile"
    private static let legacyService = "com.telar.mobile"
    private static let legacyAccount = "deviceToken"

    private static func query(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func read(service: String, account: String) -> String? {
        var item = query(service: service, account: account)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(item as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func read(account: String) -> String? {
        read(service: service, account: account)
    }

    static func write(_ token: String, account: String) {
        delete(account: account)
        var item = query(service: service, account: account)
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(item as CFDictionary, nil)
    }

    static func delete(account: String) {
        SecItemDelete(query(service: service, account: account) as CFDictionary)
    }

    /// The pre-multi-host singleton, including the pre-flavor-split hop:
    /// own service first, then the shared literal (migrating it over).
    /// Reachable only from HostMigration; steady state never reads it.
    static func readLegacySingle() -> String? {
        if let token = read(service: service, account: legacyAccount) { return token }
        guard service != legacyService,
              let token = read(service: legacyService, account: legacyAccount)
        else { return nil }
        write(token, account: legacyAccount)
        SecItemDelete(query(service: legacyService, account: legacyAccount) as CFDictionary)
        return token
    }

    static func deleteLegacySingle() {
        SecItemDelete(query(service: service, account: legacyAccount) as CFDictionary)
    }
}
