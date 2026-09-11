import Foundation
import Observation

/// Connection settings — now a BOOK of hosts, not a singleton. Base URLs are
/// addresses, not secrets: they stay in UserDefaults ("telar.hosts"). The
/// device tokens ARE secrets and live in the Keychain, one account per host
/// ("deviceToken.<hostId>") via TokenVault.
///
/// There is no "active host": t3's model, ported. All hosts are usable at
/// once; views ask for `api(for:)` and the inbox merges across them.
@MainActor @Observable final class AppSettings {
    private(set) var book: HostBook
    private let defaults: UserDefaults
    private let vault: any TokenVault

    init(defaults: UserDefaults = .standard, vault: any TokenVault = KeychainVault()) {
        self.defaults = defaults
        self.vault = vault
        HostMigration.run(defaults: defaults, vault: vault)
        book = HostMigration.load(defaults: defaults) ?? HostBook()
    }

    var hosts: [Host] { book.hosts }

    func host(_ id: HostID) -> Host? { book.host(id) }

    func token(for id: HostID) -> String? {
        vault.read(account: HostMigration.tokenAccount(id))
    }

    func api(for id: HostID) -> HTTPEngineAPI? {
        guard let url = book.host(id)?.baseURL else { return nil }
        return HTTPEngineAPI(baseURL: url, deviceToken: token(for: id))
    }

    /// Changes when the host's address or credential changes — the rebuild
    /// key for anything bound to one Mac.
    func apiFingerprint(_ id: HostID) -> String {
        (book.host(id)?.baseURLString ?? "") + "|" + (token(for: id) ?? "")
    }

    /// Pairing/adding ADDS a host; a re-pair of a known address replaces its
    /// token and keeps its identity (and so its scoped data). Never evicts
    /// other hosts.
    @discardableResult
    func upsert(baseURLString: String, token: String?, name: String? = nil) -> HostID {
        let result = book.upsert(baseURLString: baseURLString, name: name)
        let id: HostID
        switch result {
        case .added(let new): id = new
        case .replaced(let existing): id = existing
        }
        if let token {
            vault.write(token, account: HostMigration.tokenAccount(id))
        }
        persist()
        return id
    }

    func setToken(_ token: String?, for id: HostID) {
        if let token {
            vault.write(token, account: HostMigration.tokenAccount(id))
        } else {
            vault.delete(account: HostMigration.tokenAccount(id))
        }
        // Token lives in the vault, but observers key off the book — nudge it.
        persist()
    }

    func rename(_ id: HostID, to name: String) {
        book.rename(id, to: name)
        persist()
    }

    func recordDaemonId(_ daemonId: String, for id: HostID) {
        _ = book.recordDaemonId(daemonId, for: id)
        persist()
    }

    /// Removing a Mac clears everything scoped to it: credential and
    /// pending-send drafts.
    func remove(_ id: HostID) {
        let pushAPI = api(for: id)
        vault.delete(account: HostMigration.tokenAccount(id))
        let prefix = HostMigration.pendingSendPrefix + id.uuidString + "."
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(prefix) {
            defaults.removeObject(forKey: key)
        }
        MobileDrafts.shared.remove(host: id)
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("telar.draft.\(id).") { defaults.removeObject(forKey: key) }
        Task { await MobileNotifications.shared.removeHost(id, api: pushAPI) }
        book.remove(id)
        persist()
    }

    private func persist() {
        HostMigration.persist(book, defaults: defaults)
    }

    // MARK: single-host compatibility shim — first host stands in for "the"
    // host until every call site is host-aware. Deleted with the merged inbox.

    var baseURLString: String {
        get { hosts.first?.baseURLString ?? "" }
        set {
            if let first = hosts.first {
                book.upsert(baseURLString: newValue, name: first.name)
                persist()
            } else if !newValue.isEmpty {
                upsert(baseURLString: newValue, token: nil)
            }
        }
    }

    var baseURL: URL? { hosts.first?.baseURL }

    var deviceToken: String? {
        get { hosts.first.flatMap { token(for: $0.id) } }
        set {
            guard let first = hosts.first else { return }
            setToken(newValue, for: first.id)
        }
    }

    var api: HTTPEngineAPI? {
        hosts.first.flatMap { api(for: $0.id) }
    }

    /// Where this phone keeps what a Mac last said (SnapshotCache). Nil in
    /// tests and previews that build settings without a disk.
    var snapshots: SnapshotCache? = .default

    func snapshotCache(for id: HostID) -> HostSnapshotCache? {
        snapshots.map { HostSnapshotCache(cache: $0, hostId: id) }
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
