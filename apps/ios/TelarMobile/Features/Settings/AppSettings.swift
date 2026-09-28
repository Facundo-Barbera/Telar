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
        return HTTPEngineAPI(baseURL: url, deviceToken: token(for: id)) { [weak self] failed in
            await self?.failover(id, from: failed)
        }
    }

    // MARK: addresses (#832)

    /// The connectivity probe. Swappable so a test answers without a network.
    @ObservationIgnored var probe: @Sendable (URL) async -> Bool = { await HTTPEngineAPI.probe($0) }
    /// One probe pass per host at a time: a poll, a transcript and a panel
    /// that all lose the Mac together share the one answer.
    @ObservationIgnored private var probes: [HostID: Task<URL?, Never>] = [:]

    /// A request to `failed` could not reach the Mac: find the address that
    /// can. The winner becomes the host's address in use and is persisted, so
    /// every rebuilt client — and the next launch — starts there.
    func failover(_ id: HostID, from failed: URL) async -> URL? {
        guard let host = book.host(id) else { return nil }
        // Someone else already moved this host while our request was failing.
        if let current = host.baseURL, HostBook.normalize(current.absoluteString) != HostBook.normalize(failed.absoluteString) {
            return current
        }
        return await reprobe(id, order: HostAddresses.failoverOrder(host, failed: failed.absoluteString))
    }

    /// FOREGROUND: the phone may have changed network while it slept. Probe
    /// every host's addresses, the one in use first, then ask each reachable
    /// Mac what it answers on now. Probes carry no token; the status read is
    /// the gated GET /api/remote, so only a paired phone learns addresses.
    func refreshAddresses() async {
        for host in hosts {
            guard await reprobe(host.id, order: host.addresses) != nil,
                  let api = api(for: host.id), let status = try? await api.remoteStatus() else { continue }
            if book.learnAddresses(status.dialableAddresses, for: host.id) { persist() }
        }
    }

    private func reprobe(_ id: HostID, order: [String]) async -> URL? {
        if let running = probes[id] { return await running.value }
        let candidates = order.compactMap(URL.init(string:))
        guard !candidates.isEmpty else { return nil }
        let probe = self.probe
        let running = Task { await HostAddresses.firstReachable(candidates, probe: probe) }
        probes[id] = running
        let winner = await running.value
        probes[id] = nil
        if let winner, book.markReachable(winner.absoluteString, for: id) { persist() }
        return winner
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
    func upsert(baseURLString: String, token: String?, addresses: [String] = [], name: String? = nil) -> HostID {
        let result = book.upsert(baseURLString: baseURLString, addresses: addresses, name: name)
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
