import ImageIO
import UIKit

@MainActor final class AttachmentCache {
    static let shared = AttachmentCache()

    private let images = NSCache<NSString, UIImage>()
    private var failed: Set<String> = []
    private let root: URL

    init(root: URL = SnapshotCache.default.root.appending(path: "attachments"), budget: Int = 48 * 1024 * 1024) {
        self.root = root
        images.totalCostLimit = budget
    }

    nonisolated func folder(host: HostID?, session: EngineID, attachmentId: EngineID) -> URL {
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

    nonisolated func cached(host: HostID?, session: EngineID, attachmentId: EngineID) -> Data? {
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
        host: HostID?, session: EngineID, attachmentId: EngineID, side: CGFloat = Thumbnail.figure,
        fetch: (EngineID, EngineID) async throws -> RawFile
    ) async -> UIImage? {
        let key = "\(host?.uuidString ?? "local")/\(session)/\(attachmentId)@\(Int(side))"
        if let hit = images.object(forKey: key as NSString) { return hit }
        if failed.contains(key) { return nil }
        let image: UIImage?
        let onDisk = await Task.detached(priority: .userInitiated) { [self] in
            cached(host: host, session: session, attachmentId: attachmentId).flatMap { Thumbnail.make($0, side: side) }
        }.value
        if let onDisk {
            image = onDisk
        } else if let raw = try? await fetch(session, attachmentId) {
            image = await Task.detached(priority: .userInitiated) { Thumbnail.make(raw.data, side: side) }.value
            if image != nil { store(raw.data, host: host, session: session, attachmentId: attachmentId, name: attachmentId) }
        } else {
            image = nil
        }
        guard let image else {
            failed.insert(key)
            return nil
        }
        images.setObject(image, forKey: key as NSString, cost: Thumbnail.cost(image))
        return image
    }

    func image(host: HostID?, session: EngineID, attachmentId: EngineID, side: CGFloat = Thumbnail.figure, api: any PanelAPI) async -> UIImage? {
        await image(host: host, session: session, attachmentId: attachmentId, side: side) { try await api.attachmentBytes($0, attachmentId: $1) }
    }

    private nonisolated static func isPlainFile(_ url: URL) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory) && !directory.boolValue
    }

    static func fileName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed == "." || trimmed == ".." ? "attachment" : trimmed
    }
}

enum Thumbnail {
    static let tile: CGFloat = 320
    static let figure: CGFloat = 2048

    static func make(_ data: Data, side: CGFloat) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: side,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    static func cost(_ image: UIImage) -> Int {
        image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
    }
}
