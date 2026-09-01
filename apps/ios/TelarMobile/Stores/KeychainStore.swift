import Foundation
import Security

/// One secret, one item: the cockpit device token. Keychain rather than
/// UserDefaults because it IS a secret — unlike the base URL, which stays in
/// UserDefaults per AppSettings' own comment. AfterFirstUnlock so a
/// background refresh can authenticate while the phone is locked.
enum KeychainStore {
    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.telar.mobile",
            kSecAttrAccount as String: "deviceToken",
        ]
    }

    static func read() -> String? {
        var item = query
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(item as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ token: String) {
        delete()
        var item = query
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(item as CFDictionary, nil)
    }

    static func delete() {
        SecItemDelete(query as CFDictionary)
    }
}
