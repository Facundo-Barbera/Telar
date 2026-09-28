import Foundation

typealias HostID = UUID

struct Host: Identifiable, Codable, Equatable, Hashable {
    let id: HostID
    var name: String
    var baseURLString: String
    var addresses: [String]
    var daemonId: String?
    var addedAt: Date
    var migratedFromSingle: Bool

    init(id: HostID = HostID(), name: String, baseURLString: String, addresses: [String] = [],
         daemonId: String? = nil, addedAt: Date = Date(), migratedFromSingle: Bool = false) {
        self.id = id
        self.name = name
        self.baseURLString = baseURLString
        self.addresses = HostAddresses.merge(preferred: baseURLString, known: addresses)
        self.daemonId = daemonId
        self.addedAt = addedAt
        self.migratedFromSingle = migratedFromSingle
    }

    enum CodingKeys: String, CodingKey {
        case id, name, baseURLString, addresses, daemonId, addedAt, migratedFromSingle
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let base = try container.decode(String.self, forKey: .baseURLString)
        self.init(
            id: try container.decode(HostID.self, forKey: .id),
            name: try container.decode(String.self, forKey: .name),
            baseURLString: base,
            addresses: try container.decodeIfPresent([String].self, forKey: .addresses) ?? [],
            daemonId: try container.decodeIfPresent(String.self, forKey: .daemonId),
            addedAt: try container.decode(Date.self, forKey: .addedAt),
            migratedFromSingle: try container.decodeIfPresent(Bool.self, forKey: .migratedFromSingle) ?? false
        )
    }

    func isKnown(at urlString: String) -> Bool {
        let normalized = HostBook.normalize(urlString)
        return addresses.contains { HostBook.normalize($0) == normalized }
    }

    var baseURL: URL? {
        guard !baseURLString.isEmpty else { return nil }
        guard let url = URL(string: baseURLString), url.scheme?.hasPrefix("http") == true, url.host() != nil else { return nil }
        return url
    }
}

struct ScopedSessionID: Hashable, Codable {
    var hostId: HostID
    var sessionId: EngineID
}

struct HostBook: Equatable {
    private(set) var hosts: [Host]

    init(hosts: [Host] = []) {
        self.hosts = hosts
    }

    enum Upsert: Equatable {
        case added(HostID)
        case replaced(HostID)
    }

    static func defaultName(for urlString: String) -> String {
        guard let url = URL(string: urlString), let host = url.host() else { return urlString }
        if let port = url.port, port != (url.scheme == "https" ? 443 : 80) {
            return "\(host):\(port)"
        }
        return host
    }

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

    mutating func upsert(
        baseURLString: String, addresses: [String] = [], daemonId: String? = nil, name: String? = nil,
        now: Date = Date(), id: @autoclosure () -> HostID = HostID()
    ) -> Upsert {
        if let index = hosts.firstIndex(where: { $0.isKnown(at: baseURLString) }) {
            hosts[index].baseURLString = baseURLString
            hosts[index].addresses = HostAddresses.merge(
                preferred: baseURLString, known: hosts[index].addresses, learned: addresses
            )
            if let daemonId { hosts[index].daemonId = daemonId }
            if let name { hosts[index].name = name }
            return .replaced(hosts[index].id)
        }
        let fallbackName = Self.defaultName(for: baseURLString)
        let host = Host(
            id: id(), name: name ?? fallbackName, baseURLString: baseURLString,
            addresses: HostAddresses.merge(preferred: baseURLString, known: [], learned: addresses),
            daemonId: daemonId, addedAt: now
        )
        hosts.append(host)
        return .added(host.id)
    }

    mutating func learnAddresses(_ learned: [String], for id: HostID) -> Bool {
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return false }
        let merged = HostAddresses.merge(
            preferred: hosts[index].baseURLString, known: hosts[index].addresses, learned: learned
        )
        guard merged != hosts[index].addresses else { return false }
        hosts[index].addresses = merged
        return true
    }

    mutating func markReachable(_ urlString: String, for id: HostID) -> Bool {
        guard let index = hosts.firstIndex(where: { $0.id == id }),
              let known = hosts[index].addresses.first(where: { HostBook.normalize($0) == HostBook.normalize(urlString) }),
              HostBook.normalize(known) != HostBook.normalize(hosts[index].baseURLString)
        else { return false }
        hosts[index].baseURLString = known
        hosts[index].addresses = HostAddresses.merge(preferred: known, known: hosts[index].addresses)
        return true
    }

    mutating func recordDaemonId(_ daemonId: String, for id: HostID) -> Bool {
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return false }
        if let twin = hosts.firstIndex(where: { $0.id != id && $0.daemonId == daemonId }) {
            let older = hosts[twin].addedAt <= hosts[index].addedAt ? twin : index
            let newer = older == twin ? index : twin
            hosts[older].baseURLString = hosts[newer].baseURLString
            hosts[older].addresses = HostAddresses.merge(
                preferred: hosts[newer].baseURLString, known: hosts[newer].addresses, learned: hosts[older].addresses
            )
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

    var membershipFingerprint: String {
        hosts.map(\.id.uuidString).joined(separator: ",")
    }
}

enum HostAddresses {
    static let limit = 8

    static func merge(preferred: String, known: [String], learned: [String] = []) -> [String] {
        var seen: Set<String> = []
        var merged: [String] = []
        for (index, candidate) in ([preferred] + learned + known).enumerated() {
            guard !candidate.isEmpty, index == 0 || isDialable(candidate),
                  seen.insert(HostBook.normalize(candidate)).inserted else { continue }
            merged.append(candidate)
        }
        return Array(merged.prefix(limit))
    }

    static func isDialable(_ urlString: String) -> Bool {
        guard let url = URL(string: urlString), url.scheme == "http" || url.scheme == "https",
              let host = url.host()?.lowercased(), !host.isEmpty else { return false }
        return host != "localhost" && host != "::1" && !host.hasPrefix("127.")
    }

    static func failoverOrder(_ host: Host, failed: String) -> [String] {
        let dead = HostBook.normalize(failed)
        return host.addresses.filter { HostBook.normalize($0) != dead }
    }

    static func isTransportFailure(_ error: Error) -> Bool {
        guard let code = (error as? URLError)?.code else { return false }
        return [.timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost, .dnsLookupFailed]
            .contains(code)
    }

    static func rebase(_ url: URL, from base: URL, to target: URL) -> URL? {
        let from = base.absoluteString.hasSuffix("/") ? String(base.absoluteString.dropLast()) : base.absoluteString
        let to = target.absoluteString.hasSuffix("/") ? String(target.absoluteString.dropLast()) : target.absoluteString
        let whole = url.absoluteString
        guard whole.hasPrefix(from) else { return nil }
        let rest = whole.dropFirst(from.count)
        guard rest.isEmpty || rest.hasPrefix("/") || rest.hasPrefix("?") else { return nil }
        return URL(string: to + rest)
    }

    static func firstReachable(_ candidates: [URL], probe: @escaping @Sendable (URL) async -> Bool) async -> URL? {
        let probes = candidates.map { url in Task { await probe(url) } }
        defer { probes.forEach { $0.cancel() } }
        for (url, running) in zip(candidates, probes) {
            if await running.value { return url }
        }
        return nil
    }
}
