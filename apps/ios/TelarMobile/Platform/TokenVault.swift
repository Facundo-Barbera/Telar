import Foundation

protocol TokenVault: Sendable {
    func read(account: String) -> String?
    func write(_ token: String, account: String)
    func delete(account: String)
}

struct KeychainVault: TokenVault {
    func read(account: String) -> String? { KeychainStore.read(account: account) }
    func write(_ token: String, account: String) { KeychainStore.write(token, account: account) }
    func delete(account: String) { KeychainStore.delete(account: account) }
}

final class MemoryVault: TokenVault, @unchecked Sendable {
    private var storage: [String: String]

    init(_ storage: [String: String] = [:]) {
        self.storage = storage
    }

    func read(account: String) -> String? { storage[account] }
    func write(_ token: String, account: String) { storage[account] = token }
    func delete(account: String) { storage[account] = nil }
}
