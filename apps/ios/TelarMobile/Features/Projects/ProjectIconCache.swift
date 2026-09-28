import Foundation
import Observation
import UIKit

/// THE PROJECT'S MARK, kept once per key.
///
/// `ProjectRef.icon` is a content-derived key: the cockpit serves the bytes
/// behind it with an immutable cache header, and a changed file is a changed
/// key. So the phone never revalidates — a key it has seen is drawn from disk,
/// a key it has not is fetched once, and a fetch that fails is remembered for
/// the app's lifetime so a missing file does not cost a round trip per row.
///
/// PER HOST, like the snapshot cache: two Macs can register the same project
/// id, and a key is only meaningful against the Mac that minted it.
///
/// Decoded images are held in memory by key; the sidebar draws the same
/// handful of marks on every row, and `UIImage(data:)` per row per redraw is
/// the cost this avoids.
@MainActor @Observable final class ProjectIconCache {
    static let shared = ProjectIconCache(root: SnapshotCache.default.root.appending(path: "icons"))

    private let root: URL
    private var images: [String: UIImage] = [:]
    /// Keys whose fetch failed this launch. Not persisted: a Mac that was
    /// away is not a file that is gone.
    private var failed: Set<String> = []
    private var loading: Set<String> = []

    init(root: URL) {
        self.root = root
    }

    /// What is on hand right now, without fetching. `nil` until `load` has
    /// been asked and has answered.
    func image(host: HostID, projectId: EngineID, icon: String) -> UIImage? {
        images[cacheKey(host, projectId, icon)]
    }

    /// Disk first, then the Mac, then nothing. Idempotent per key: a second
    /// caller while the first is in flight waits for nothing and gets the
    /// answer when the first one lands.
    func load(host: HostID, projectId: EngineID, icon: String, api: any EngineAPI) {
        let key = cacheKey(host, projectId, icon)
        guard images[key] == nil, !failed.contains(key), !loading.contains(key) else { return }
        loading.insert(key)
        let file = fileURL(host, projectId, icon)
        Task.detached(priority: .utility) { [weak self] in
            if let data = try? Data(contentsOf: file), let image = UIImage(data: data) {
                await self?.settle(key, image: image)
                return
            }
            guard let data = try? await api.projectIcon(projectId, icon: icon), let image = UIImage(data: data) else {
                await self?.settle(key, image: nil)
                return
            }
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: file, options: .atomic)
            await self?.settle(key, image: image)
        }
    }

    private func settle(_ key: String, image: UIImage?) {
        loading.remove(key)
        if let image { images[key] = image } else { failed.insert(key) }
    }

    private func cacheKey(_ host: HostID, _ projectId: EngineID, _ icon: String) -> String {
        "\(host.uuidString)/\(projectId)/\(icon)"
    }

    private func fileURL(_ host: HostID, _ projectId: EngineID, _ icon: String) -> URL {
        let safe = { (part: String) in part.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? part }
        return root.appending(path: host.uuidString).appending(path: safe(projectId)).appending(path: safe(icon))
    }
}
