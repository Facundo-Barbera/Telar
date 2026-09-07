// Generates a runtime credential in Keychain; prints only its public hash for deployment.
import Foundation
import Security
import CryptoKit
let service = "com.telar.push-relay"
let lookup: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "host"]
var query = lookup
query[kSecReturnData as String] = true
query[kSecMatchLimit as String] = kSecMatchLimitOne
var result: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &result)
var token: String
var hostID: String
if status == errSecSuccess, let data = result as? Data, let existing = try JSONSerialization.jsonObject(with: data) as? [String: String], let saved = existing["token"], let savedID = existing["id"] {
    token = saved; hostID = savedID
} else if status == errSecItemNotFound {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { fatalError("Could not generate runtime identity") }
    token = bytes.map { String(format: "%02x", $0) }.joined()
    hostID = UUID().uuidString.lowercased()
    let data = try JSONSerialization.data(withJSONObject: ["token": token, "id": hostID, "url": "https://telar-push-relay.facundo-barbera.workers.dev"])
    var item = lookup
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { fatalError("Could not store runtime identity in Keychain") }
} else { fatalError("Could not read existing Keychain identity; refusing to replace it") }
let hash = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
let publicRecord = try JSONSerialization.data(withJSONObject: ["id": hostID, "sha256": hash], options: [.sortedKeys])
print(String(data: publicRecord, encoding: .utf8)!)
