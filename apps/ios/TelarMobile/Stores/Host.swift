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
    /// THE ADDRESS IN USE — the last one that answered. Every request goes
    /// here until one fails in transport; then `addresses` is probed and the
    /// winner takes this slot, so it is also what is tried first next time.
    var baseURLString: String
    /// EVERY ADDRESS THIS MAC IS KNOWN BY (#832): LAN, tailnet IP, MagicDNS —
    /// what it was paired at plus what it has since reported. Always contains
    /// `baseURLString`. One host, one identity, one Keychain token: an address
    /// is a way to reach the Mac, not a second Mac.
    var addresses: [String]
    var daemonId: String?
    var addedAt: Date
    /// True only for the host built by the single-host migration — the one
    /// allowed to claim legacy pendingSend keys.
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

    /// A book written before #832 has no `addresses`: it decodes as a host
    /// with exactly one. `baseURLString` is still written, so a downgraded
    /// build reads the address in use and ignores the list.
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

    /// Whether this Mac answers at `urlString` under any spelling.
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

    /// Pairing ADDS: dedupe by normalized URL against EVERY known address — a
    /// re-pair at the Mac's LAN or tailnet spelling keeps the host's id (and
    /// therefore its scoped keychain account and pending sends), it never
    /// duplicates and never evicts other hosts. The paired address just
    /// answered, so it becomes the one in use; `addresses` is what the Mac
    /// reported alongside the token.
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

    /// What the Mac says it answers on now. Returns true when the list changed
    /// (the caller persists only then). Never moves the address in use: that
    /// only follows a probe that got an answer.
    mutating func learnAddresses(_ learned: [String], for id: HostID) -> Bool {
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return false }
        let merged = HostAddresses.merge(
            preferred: hosts[index].baseURLString, known: hosts[index].addresses, learned: learned
        )
        guard merged != hosts[index].addresses else { return false }
        hosts[index].addresses = merged
        return true
    }

    /// A probe got an answer at `urlString`: it becomes the address in use,
    /// and so the first one tried next time. Only a KNOWN address can win — a
    /// stray URL never becomes where this host's token is sent.
    mutating func markReachable(_ urlString: String, for id: HostID) -> Bool {
        guard let index = hosts.firstIndex(where: { $0.id == id }),
              let known = hosts[index].addresses.first(where: { HostBook.normalize($0) == HostBook.normalize(urlString) }),
              HostBook.normalize(known) != HostBook.normalize(hosts[index].baseURLString)
        else { return false }
        hosts[index].baseURLString = known
        hosts[index].addresses = HostAddresses.merge(preferred: known, known: hosts[index].addresses)
        return true
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
            // Both records' addresses reach the same Mac: keep them all.
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

    /// Changes iff membership changes — the navigation-prune trigger.
    var membershipFingerprint: String {
        hosts.map(\.id.uuidString).joined(separator: ",")
    }
}

/// THE ADDRESS RULES (#832), pure — no URLSession, no clock — so ordering,
/// learning and failover choice are unit tests. A Mac on a phone is reached
/// by whichever of its addresses answers from where the phone is right now:
/// the LAN IP at home, the tailnet IP or MagicDNS name anywhere else.
enum HostAddresses {
    /// A Mac reports three or four; the rest are addresses it used to have
    /// (a DHCP lease that moved). The cap keeps a failover probe bounded.
    static let limit = 8

    /// Ordered, deduplicated by spelling: the address in use first, then what
    /// the Mac just reported, then older ones. `preferred` is kept even when
    /// it is not dialable from elsewhere — a simulator paired at 127.0.0.1
    /// must keep working — but no LEARNED loopback is ever added.
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

    /// http(s), a host, and not this phone.
    static func isDialable(_ urlString: String) -> Bool {
        guard let url = URL(string: urlString), url.scheme == "http" || url.scheme == "https",
              let host = url.host()?.lowercased(), !host.isEmpty else { return false }
        return host != "localhost" && host != "::1" && !host.hasPrefix("127.")
    }

    /// Where to look once `failed` stopped answering: every other address,
    /// most-recently-good first.
    static func failoverOrder(_ host: Host, failed: String) -> [String] {
        let dead = HostBook.normalize(failed)
        return host.addresses.filter { HostBook.normalize($0) != dead }
    }

    /// Only a failure to REACH the Mac moves the host. A 401, a 500 or a body
    /// this build cannot read came from a Mac that answered, and another
    /// address would answer the same. No network at all is not a wrong
    /// address either: every probe would fail with it.
    static func isTransportFailure(_ error: Error) -> Bool {
        guard let code = (error as? URLError)?.code else { return false }
        return [.timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost, .dnsLookupFailed]
            .contains(code)
    }

    /// The same request, pointed at another address of the same Mac.
    static func rebase(_ url: URL, from base: URL, to target: URL) -> URL? {
        let from = base.absoluteString.hasSuffix("/") ? String(base.absoluteString.dropLast()) : base.absoluteString
        let to = target.absoluteString.hasSuffix("/") ? String(target.absoluteString.dropLast()) : target.absoluteString
        let whole = url.absoluteString
        guard whole.hasPrefix(from) else { return nil }
        let rest = whole.dropFirst(from.count)
        guard rest.isEmpty || rest.hasPrefix("/") || rest.hasPrefix("?") else { return nil }
        return URL(string: to + rest)
    }

    /// PROBED AT ONCE, CHOSEN IN ORDER. Every candidate is asked together and
    /// the answers are read in preference order, so the earliest address that
    /// answers wins — the in-order rule — while dead addresses cost one probe
    /// timeout in total rather than one each. The losers are cancelled.
    static func firstReachable(_ candidates: [URL], probe: @escaping @Sendable (URL) async -> Bool) async -> URL? {
        let probes = candidates.map { url in Task { await probe(url) } }
        defer { probes.forEach { $0.cancel() } }
        for (url, running) in zip(candidates, probes) {
            if await running.value { return url }
        }
        return nil
    }
}
