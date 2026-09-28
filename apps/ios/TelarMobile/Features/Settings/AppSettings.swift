import Foundation
import Observation

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

    @ObservationIgnored var probe: @Sendable (URL) async -> Bool = { await HTTPEngineAPI.probe($0) }

    @ObservationIgnored private var probes: [HostID: Task<URL?, Never>] = [:]

    func failover(_ id: HostID, from failed: URL) async -> URL? {
        guard let host = book.host(id) else { return nil }

        if let current = host.baseURL, HostBook.normalize(current.absoluteString) != HostBook.normalize(failed.absoluteString) {
            return current
        }
        return await reprobe(id, order: HostAddresses.failoverOrder(host, failed: failed.absoluteString))
    }

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

    func apiFingerprint(_ id: HostID) -> String {
        (book.host(id)?.baseURLString ?? "") + "|" + (token(for: id) ?? "")
    }

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
