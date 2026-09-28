import Foundation

enum HostMigration {
    static let hostsKey = "telar.hosts"
    static let legacyBaseURLKey = "telar.baseURL"
    static let pendingSendPrefix = "telar.pendingSend."

    struct Plan: Equatable {
        var host: Host?
        var pendingSendRenames: [Rename]

        struct Rename: Equatable {
            var old: String
            var new: String
        }
    }

    static func plan(
        legacyBaseURL: String?, existingKeys: [String],
        now: Date, id: HostID
    ) -> Plan? {
        guard let legacyBaseURL, !legacyBaseURL.isEmpty else { return nil }
        let host = Host(
            id: id,
            name: HostBook.defaultName(for: legacyBaseURL),
            baseURLString: legacyBaseURL,
            addedAt: now,
            migratedFromSingle: true
        )
        let renames = existingKeys
            .filter { $0.hasPrefix(pendingSendPrefix) }
            .map { key in
                Plan.Rename(old: key, new: pendingSendPrefix + id.uuidString + "." + String(key.dropFirst(pendingSendPrefix.count)))
            }
        return Plan(host: host, pendingSendRenames: renames)
    }

    @discardableResult
    static func run(defaults: UserDefaults, vault: any TokenVault, now: Date = Date()) -> Bool {
        guard defaults.data(forKey: hostsKey) == nil else { return false }
        let legacyToken = KeychainStore.readLegacySingle()
        guard let plan = plan(
            legacyBaseURL: defaults.string(forKey: legacyBaseURLKey),
            existingKeys: Array(defaults.dictionaryRepresentation().keys),
            now: now, id: HostID()
        ), let host = plan.host else {
            persist(HostBook(), defaults: defaults)
            return false
        }
        if let legacyToken {
            vault.write(legacyToken, account: tokenAccount(host.id))
            KeychainStore.deleteLegacySingle()
        }
        for rename in plan.pendingSendRenames {
            if let value = defaults.data(forKey: rename.old) {
                defaults.set(value, forKey: rename.new)
            }
            defaults.removeObject(forKey: rename.old)
        }
        persist(HostBook(hosts: [host]), defaults: defaults)
        return true
    }

    static func tokenAccount(_ id: HostID) -> String {
        "deviceToken.\(id.uuidString)"
    }

    static func persist(_ book: HostBook, defaults: UserDefaults) {
        if let data = try? JSONEncoder().encode(book.hosts) {
            defaults.set(data, forKey: hostsKey)
        }
    }

    static func load(defaults: UserDefaults) -> HostBook? {
        guard let data = defaults.data(forKey: hostsKey),
              let hosts = try? JSONDecoder().decode([Host].self, from: data)
        else { return nil }
        return HostBook(hosts: hosts)
    }
}
