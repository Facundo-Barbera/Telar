import Foundation
import Observation
import UIKit

@MainActor @Observable final class ProjectIconCache {
    static let shared = ProjectIconCache(root: SnapshotCache.default.root.appending(path: "icons"))

    private let root: URL
    private var images: [String: UIImage] = [:]

    private var failed: Set<String> = []
    private var loading: Set<String> = []

    init(root: URL) {
        self.root = root
    }

    func image(host: HostID, projectId: EngineID, icon: String) -> UIImage? {
        images[cacheKey(host, projectId, icon)]
    }

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
