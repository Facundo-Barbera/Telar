import Foundation

/// THE LAST THING RECORDED, kept on the phone.
///
/// Every byte this app shows comes from a Mac over the network, and when the
/// Mac goes away — the cockpit restarts, the tailnet drops, the laptop lid
/// closes — the transcript went with it: a spinner where the conversation had
/// been a second earlier. t3 mobile keeps a per-environment snapshot and
/// renders it while the real read is in flight; this is that, for both the
/// inbox and an open session.
///
/// RAW BYTES, NOT MODELS. The wire types are `Decodable` with hand-written
/// decoders (denylist enums, skippable rows) and no encoders, and giving each
/// of them an encoder would be a second copy of the protocol to keep in step.
/// The cockpit's own JSON is already the durable form; it is written as
/// received and decoded on the way back out by the same decoders the network
/// path uses, so a cached snapshot can never disagree with a live one about
/// what a field means.
///
/// PER HOST, PER SESSION. Two Macs can mint the same session id, so the host
/// is the first directory. Files sit under Application Support, excluded from
/// backup — a cache is rebuilt by opening the app, and iCloud should not carry
/// somebody's transcripts around for it.
struct SnapshotCache: Sendable {
    let root: URL

    /// Newest-first eviction bound per host. Thirty is more sessions than a
    /// phone shows without scrolling twice, and a session snapshot is tens of
    /// kilobytes, so the cap is about tidiness rather than space.
    static let sessionsPerHost = 30

    static let `default` = SnapshotCache(
        root: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: "snapshots")
    )

    struct Entry: Equatable {
        var data: Data
        /// Milliseconds since the epoch — the protocol's own clock.
        var savedAt: Timestamp
    }

    // MARK: sessions

    func readSession(host: HostID, id: EngineID) -> Entry? {
        read(sessionFile(host, id))
    }

    func writeSession(host: HostID, id: EngineID, data: Data) {
        write(sessionFile(host, id), data)
        prune(sessionsDir(host))
    }

    func dropSession(host: HostID, id: EngineID) {
        try? FileManager.default.removeItem(at: sessionFile(host, id))
    }

    // MARK: inbox

    func readInbox(host: HostID) -> Entry? {
        read(hostDir(host).appending(path: "inbox.json"))
    }

    func writeInbox(host: HostID, data: Data) {
        write(hostDir(host).appending(path: "inbox.json"), data)
    }

    /// Forgetting a Mac forgets what it said.
    func dropHost(_ host: HostID) {
        try? FileManager.default.removeItem(at: hostDir(host))
    }

    // MARK: files

    private func hostDir(_ host: HostID) -> URL { root.appending(path: host.uuidString) }
    private func sessionsDir(_ host: HostID) -> URL { hostDir(host).appending(path: "sessions") }
    private func sessionFile(_ host: HostID, _ id: EngineID) -> URL {
        // A session id is the engine's own token — path-safe by construction
        // (`session_<hex>`) — but a defensive encode costs nothing.
        let name = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id
        return sessionsDir(host).appending(path: "\(name).json")
    }

    private func read(_ file: URL) -> Entry? {
        guard let data = try? Data(contentsOf: file),
              let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
              let modified = attributes[.modificationDate] as? Date
        else { return nil }
        return Entry(data: data, savedAt: Timestamp(modified.timeIntervalSince1970 * 1000))
    }

    private func write(_ file: URL, _ data: Data) {
        let dir = file.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var rootURL = root
            try? rootURL.setResourceValues(values)
            // Atomic: a half-written snapshot is worse than the previous one.
            try data.write(to: file, options: .atomic)
        } catch {
            // A full disk or a sandbox refusal loses the cache, not the app.
        }
    }

    /// Keep the newest `sessionsPerHost` files by modification date.
    private func prune(_ dir: URL) {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey]
        ), files.count > Self.sessionsPerHost else { return }
        let dated = files.map { file -> (URL, Date) in
            let date = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return (file, date)
        }
        for (file, _) in dated.sorted(by: { $0.1 > $1.1 }).dropFirst(Self.sessionsPerHost) {
            try? FileManager.default.removeItem(at: file)
        }
    }
}

/// One Mac's slice of the cache — what a store bound to a host holds, so it
/// never has to carry the host id beside every call.
struct HostSnapshotCache: Sendable {
    let cache: SnapshotCache
    let hostId: HostID

    func readSession(_ id: EngineID) -> SnapshotCache.Entry? { cache.readSession(host: hostId, id: id) }
    func writeSession(_ id: EngineID, _ data: Data) { cache.writeSession(host: hostId, id: id, data: data) }
    func dropSession(_ id: EngineID) { cache.dropSession(host: hostId, id: id) }
    func readInbox() -> SnapshotCache.Entry? { cache.readInbox(host: hostId) }
    func writeInbox(_ data: Data) { cache.writeInbox(host: hostId, data: data) }
}

/// "Recorded at 12:40" — the one clock a stale banner shows.
func recordedAtLabel(_ savedAt: Timestamp) -> String {
    Date(timeIntervalSince1970: TimeInterval(savedAt) / 1000).formatted(date: .omitted, time: .shortened)
}
