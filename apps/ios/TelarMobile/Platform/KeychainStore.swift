import Foundation
import Security

enum KeychainStore {
    private static let service = Bundle.main.bundleIdentifier ?? "io.github.novarix.telar"
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
