import Foundation
import Testing
import UIKit
@testable import TelarMobile

@MainActor @Suite struct ProjectIconCacheTests {
    final class Clock { var now = Date(timeIntervalSince1970: 0) }

    private func settle(_ cache: ProjectIconCache) async {
        while cache.pending > 0 { await Task.yield() }
    }

    @Test func aFailedLoadIsRetriedOnceTheCooldownPasses() async throws {
        let clock = Clock()
        let cache = ProjectIconCache(root: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), now: { clock.now })
        let api = RecordingEngineAPI(eventPages: [], snapshots: [])
        let png = try #require(UIImage(systemName: "star")?.pngData())
        await api.answerIcons([nil, png])
        let host = UUID()

        cache.load(host: host, projectId: "p", icon: "sha-1", api: api)
        await settle(cache)
        #expect(cache.image(host: host, projectId: "p", icon: "sha-1") == nil)

        cache.load(host: host, projectId: "p", icon: "sha-1", api: api)
        await settle(cache)
        #expect(await api.recorded() == ["projectIcon(p)"])

        clock.now += ProjectIconCache.retryAfter + 1
        cache.load(host: host, projectId: "p", icon: "sha-1", api: api)
        await settle(cache)
        #expect(cache.image(host: host, projectId: "p", icon: "sha-1") != nil)
        #expect(await api.recorded() == ["projectIcon(p)", "projectIcon(p)"])
    }
}
