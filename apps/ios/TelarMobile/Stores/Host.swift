import Foundation

/// A Mac this phone talks to — t3code calls these "environments". Identity
/// is a LOCAL uuid, minted when the host is added: the server's daemonId is
/// behind the pairing gate (unknown at add time, unknowable while offline),
/// and identity must exist before either. daemonId is recorded when learned
/// and used only to collapse "same Mac, new address" duplicates.
typealias HostID = UUID

struct Host: Identifiable, Codable, Equatable, Hashable {
    let id: HostID
    /// Label; defaults to the URL's host, renameable.
    var name: String
    var baseURLString: String
    var daemonId: String?
    var addedAt: Date
    /// True only for the host built by the single-host migration — the one
    /// allowed to claim legacy pendingSend keys.
    var migratedFromSingle: Bool

    init(id: HostID = HostID(), name: String, baseURLString: String,
         daemonId: String? = nil, addedAt: Date = Date(), migratedFromSingle: Bool = false) {
        self.id = id
        self.name = name
        self.baseURLString = baseURLString
        self.daemonId = daemonId
        self.addedAt = addedAt
        self.migratedFromSingle = migratedFromSingle
    }

    var baseURL: URL? {
        guard !baseURLString.isEmpty else { return nil }
        guard let url = URL(string: baseURLString), url.scheme?.hasPrefix("http") == true, url.host() != nil else { return nil }
        return url
    }
}

/// A session id is only meaningful together with the Mac that minted it —
/// two Macs can mint the same engine id.
struct ScopedSessionID: Hashable, Codable {
    var hostId: HostID
    var sessionId: EngineID
}

/// The host list's RULES, pure — no UserDefaults, no Keychain — so every
/// dedupe/merge/removal rule is a unit test.
struct HostBook: Equatable {
    private(set) var hosts: [Host]

    init(hosts: [Host] = []) {
        self.hosts = hosts
    }

    enum Upsert: Equatable {
        case added(HostID)
        case replaced(HostID)
    }

    /// The label when the human hasn't named it: host, plus the port when
    /// it isn't the scheme default — two stacks on one machine must not
    /// both read "127.0.0.1".
    static func defaultName(for urlString: String) -> String {
        guard let url = URL(string: urlString), let host = url.host() else { return urlString }
        if let port = url.port, port != (url.scheme == "https" ? 443 : 80) {
            return "\(host):\(port)"
        }
        return host
    }

    /// Same Mac, spelled differently: lowercased scheme+host, explicit
    /// default port, no trailing slash.
    static func normalize(_ urlString: String) -> String {
        guard var components = URLComponents(string: urlString.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return urlString
        }
        components.scheme = components.scheme?.lowercased()
        components.host = components.host?.lowercased()
        if components.port == nil {
            components.port = components.scheme == "https" ? 443 : 80
        }
        if components.path == "/" { components.path = "" }
        return components.url?.absoluteString ?? urlString
    }

    /// Pairing ADDS: dedupe by normalized URL — a re-pair of a known address
    /// keeps the host's id (and therefore its scoped keychain account and
    /// pending sends), it never duplicates and never evicts other hosts.
    mutating func upsert(
        baseURLString: String, daemonId: String? = nil, name: String? = nil,
        now: Date = Date(), id: @autoclosure () -> HostID = HostID()
    ) -> Upsert {
        let normalized = Self.normalize(baseURLString)
        if let index = hosts.firstIndex(where: { Self.normalize($0.baseURLString) == normalized }) {
            hosts[index].baseURLString = baseURLString
            if let daemonId { hosts[index].daemonId = daemonId }
            if let name { hosts[index].name = name }
            return .replaced(hosts[index].id)
        }
        let fallbackName = Self.defaultName(for: baseURLString)
        let host = Host(
            id: id(), name: name ?? fallbackName, baseURLString: baseURLString,
            daemonId: daemonId, addedAt: now
        )
        hosts.append(host)
        return .added(host.id)
    }

    /// Learned identity: if another record already carries this daemonId,
    /// the same Mac was added under two addresses — merge into the OLDER
    /// record (its id owns the scoped data) and keep the newer address.
    /// Returns true when a merge happened.
    mutating func recordDaemonId(_ daemonId: String, for id: HostID) -> Bool {
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return false }
        if let twin = hosts.firstIndex(where: { $0.id != id && $0.daemonId == daemonId }) {
            let older = hosts[twin].addedAt <= hosts[index].addedAt ? twin : index
            let newer = older == twin ? index : twin
            hosts[older].baseURLString = hosts[newer].baseURLString
            hosts[older].daemonId = daemonId
            hosts.remove(at: newer)
            return true
        }
        hosts[index].daemonId = daemonId
        return false
    }

    mutating func rename(_ id: HostID, to name: String) {
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        hosts[index].name = trimmed.isEmpty ? (hosts[index].baseURL?.host() ?? hosts[index].name) : trimmed
    }

    mutating func remove(_ id: HostID) {
        hosts.removeAll { $0.id == id }
    }

    func host(_ id: HostID) -> Host? {
        hosts.first { $0.id == id }
    }

    /// Changes iff membership changes — the navigation-prune trigger.
    var membershipFingerprint: String {
        hosts.map(\.id.uuidString).joined(separator: ",")
    }
}
