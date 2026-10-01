import UIKit

@MainActor final class AttachmentCache {
    static let shared = AttachmentCache()

    private var images: [String: UIImage] = [:]
    private var failed: Set<String> = []
    private let root: URL

    init(root: URL = SnapshotCache.default.root.appending(path: "attachments")) {
        self.root = root
    }

    func folder(host: HostID?, session: EngineID, attachmentId: EngineID) -> URL {
        let safe = { (part: String) in part.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? part }
        return root.appending(path: safe(host?.uuidString ?? "local")).appending(path: safe(session)).appending(path: safe(attachmentId))
    }

    func file(host: HostID?, session: EngineID, attachmentId: EngineID, name: String) -> URL {
        folder(host: host, session: session, attachmentId: attachmentId).appending(path: Self.fileName(name))
    }

    func store(_ data: Data, host: HostID?, session: EngineID, attachmentId: EngineID, name: String) {
        let target = file(host: host, session: session, attachmentId: attachmentId, name: name)
        let folder = target.deletingLastPathComponent()
        if Self.isPlainFile(folder) { try? FileManager.default.removeItem(at: folder) }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? data.write(to: target, options: .atomic)
    }

    func cached(host: HostID?, session: EngineID, attachmentId: EngineID) -> Data? {
        let folder = folder(host: host, session: session, attachmentId: attachmentId)
        if Self.isPlainFile(folder) { return try? Data(contentsOf: folder) }
        guard let first = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil).first else { return nil }
        return try? Data(contentsOf: first)
    }

    func fileURL(
        host: HostID?, session: EngineID, attachmentId: EngineID, name: String,
        fetch: (EngineID, EngineID) async throws -> RawFile
    ) async -> URL? {
        let target = file(host: host, session: session, attachmentId: attachmentId, name: name)
        if FileManager.default.fileExists(atPath: target.path) { return target }
        if let data = cached(host: host, session: session, attachmentId: attachmentId) {
            store(data, host: host, session: session, attachmentId: attachmentId, name: name)
            return target
        }
        guard let raw = try? await fetch(session, attachmentId) else { return nil }
        store(raw.data, host: host, session: session, attachmentId: attachmentId, name: name)
        return target
    }

    func image(
        host: HostID?, session: EngineID, attachmentId: EngineID,
        fetch: (EngineID, EngineID) async throws -> RawFile
    ) async -> UIImage? {
        let key = "\(host?.uuidString ?? "local")/\(session)/\(attachmentId)"
        if let hit = images[key] { return hit }
        if failed.contains(key) { return nil }
        if let data = cached(host: host, session: session, attachmentId: attachmentId), let image = UIImage(data: data) {
            images[key] = image
            return image
        }
        guard let raw = try? await fetch(session, attachmentId), let image = UIImage(data: raw.data) else {
            failed.insert(key)
            return nil
        }
        store(raw.data, host: host, session: session, attachmentId: attachmentId, name: attachmentId)
        images[key] = image
        return image
    }

    func image(host: HostID?, session: EngineID, attachmentId: EngineID, api: any PanelAPI) async -> UIImage? {
        await image(host: host, session: session, attachmentId: attachmentId) { try await api.attachmentBytes($0, attachmentId: $1) }
    }

    private static func isPlainFile(_ url: URL) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory) && !directory.boolValue
    }

    static func fileName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed == "." || trimmed == ".." ? "attachment" : trimmed
    }
}
