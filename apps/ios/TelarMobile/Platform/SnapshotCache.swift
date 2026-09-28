import Foundation

struct SnapshotCache: Sendable {
    let root: URL

    static let sessionsPerHost = 30

    static let `default` = SnapshotCache(
        root: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: "snapshots")
    )

    struct Entry: Equatable {
        var data: Data

        var savedAt: Timestamp
    }

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

    func readInbox(host: HostID) -> Entry? {
        read(hostDir(host).appending(path: "inbox.json"))
    }

    func writeInbox(host: HostID, data: Data) {
        write(hostDir(host).appending(path: "inbox.json"), data)
    }

    func dropHost(_ host: HostID) {
        try? FileManager.default.removeItem(at: hostDir(host))
    }

    private func hostDir(_ host: HostID) -> URL { root.appending(path: host.uuidString) }
    private func sessionsDir(_ host: HostID) -> URL { hostDir(host).appending(path: "sessions") }
    private func sessionFile(_ host: HostID, _ id: EngineID) -> URL {
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

            try data.write(to: file, options: .atomic)
        } catch {
        }
    }

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

struct HostSnapshotCache: Sendable {
    let cache: SnapshotCache
    let hostId: HostID

    func readSession(_ id: EngineID) -> SnapshotCache.Entry? { cache.readSession(host: hostId, id: id) }
    func writeSession(_ id: EngineID, _ data: Data) { cache.writeSession(host: hostId, id: id, data: data) }
    func dropSession(_ id: EngineID) { cache.dropSession(host: hostId, id: id) }
    func readInbox() -> SnapshotCache.Entry? { cache.readInbox(host: hostId) }
    func writeInbox(_ data: Data) { cache.writeInbox(host: hostId, data: data) }
}

func recordedAtLabel(_ savedAt: Timestamp) -> String {
    Date(timeIntervalSince1970: TimeInterval(savedAt) / 1000).formatted(date: .omitted, time: .shortened)
}
