import Foundation
import Testing
@testable import TelarMobile

/// The cache is the first frame, and reading it is no longer the tap's cost:
/// both stores read and decode off the main thread and only assign there.
/// These pin that the frame still lands, and that the Mac's answer wins
/// over a cache read that finishes late.
private func tempCache() -> SnapshotCache {
    SnapshotCache(root: FileManager.default.temporaryDirectory.appending(path: "telar-restore-\(UUID().uuidString)"))
}

private let snapshotJSON = Data("""
{"cursor":7,"session":{"id":"s","projectId":"p","title":"Cached","state":"active",
  "createdAt":1,"updatedAt":2,"driver":"claude",
  "workspace":{"mode":"local","path":"/x"},"runtimeMode":"auto","detached":false},
 "turns":[{"runId":"run_1","sessionId":"s","sequence":1,"state":"completed","input":"hi","acceptedAt":1,"updatedAt":1}],
 "items":[{"id":"i_1","runId":"run_1","sessionId":"s","status":"completed","startedAt":1,"detail":{"type":"assistant_message","text":"hello"}}],
 "requests":[],"tasks":[]}
""".utf8)

private let inboxJSON = Data("""
{"sessions":[{"id":"s","projectId":"p","title":"Cached","state":"active","createdAt":1,"updatedAt":2,
  "driver":"claude","workspace":{"mode":"local","path":"/x"},"runtimeMode":"auto","detached":false,"activity":"working"}],
 "projects":[{"id":"p","name":"Proj"}]}
""".utf8)

/// Never reached: these tests exercise the cache path only.
private struct UnreachableAPI: EngineAPI {
    func health() async throws -> EngineHealth { fatalError("unused") }
    func liveSessions() async throws -> LiveSessions { fatalError("unused") }
    func session(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionSnapshot { fatalError("unused") }
    func events(_ id: EngineID, after: Int) async throws -> EventPage { fatalError("unused") }
    func projectIcon(_ projectId: EngineID, icon: String) async throws -> Data { fatalError("unused") }
    func submitTurn(_ id: EngineID, runId: String, input: String, attachments: [EngineID]?) async throws -> TurnSubmissionResult { fatalError("unused") }
    func stopSession(_ id: EngineID) async throws {}
    func stopTurn(_ id: EngineID, runId: String) async throws {}
    func resolveRequest(_ id: EngineID, requestId: EngineID, decision: RequestDecision, reason: String?, answers: [String: AnswerValue]?) async throws {}
    func patchSession(_ id: EngineID, patch: SessionPatch) async throws {}
    func markSessionRead(_ id: EngineID, runId: String) async throws -> Session { fatalError("unused") }
    func promoteTurn(_ id: EngineID, runId: String) async throws {}
    func createSession(projectId: EngineID, input: NewSessionInput) async throws -> Session { fatalError("unused") }
    func inboxPolicy() async throws -> InboxPolicy { InboxPolicy(autoSettleAfterHours: 72) }
    func uploadAttachment(_ id: EngineID, name: String, mediaType: String, data: Data) async throws -> TurnAttachment { fatalError("unused") }
    func models(driver: String) async throws -> ModelCatalogue { fatalError("unused") }
    func providerInstances() async throws -> [ProviderInstance] { [] }
    func sessionDiff(_ id: EngineID) async throws -> SessionDiff { fatalError("unused") }
    func filePatch(_ id: EngineID, path: String, untracked: Bool) async throws -> FilePatch { fatalError("unused") }
    func listDirectories(path: String?) async throws -> DirectoryListing { fatalError("unused") }
    func registerProject(name: String, root: String) async throws -> ProjectRef { fatalError("unused") }
    func projectGit(_ projectId: EngineID) async throws -> GitOverview { fatalError("unused") }
    func remoteStatus() async throws -> RemoteStatus { fatalError("unused") }
    func renameDevice(_ id: String, name: String) async throws -> RemoteDevice { fatalError("unused") }
    func setDeviceRole(_ id: String, role: String) async throws -> RemoteDevice { fatalError("unused") }
    func revokeDevice(_ id: String) async throws {}
    func revokeOtherDevices() async throws -> Int { 0 }
}

@Suite struct StoreRestoreTests {
    @Test @MainActor func aSessionOpensOnItsCachedSnapshotWithoutBlockingTheInitialiser() async {
        let host = HostID()
        let cache = tempCache()
        cache.writeSession(host: host, id: "s", data: snapshotJSON)
        let engine = SessionSyncEngine(api: UnreachableAPI(), sessionId: "s", cache: HostSnapshotCache(cache: cache, hostId: host))
        // The initialiser returns before the bytes are read: nothing yet.
        #expect(engine.turns.isEmpty)
        await engine.awaitPendingWork()
        #expect(engine.session?.title == "Cached")
        #expect(engine.turns.map(\.runId) == ["run_1"])
        #expect(engine.turns.first?.items.first?.text == "hello")
        #expect(engine.recordedAt != nil)
        #expect(engine.connection.isStale)
    }

    @Test @MainActor func anEmptyCacheStartsEmpty() async {
        let engine = SessionSyncEngine(api: UnreachableAPI(), sessionId: "s", cache: HostSnapshotCache(cache: tempCache(), hostId: HostID()))
        await engine.awaitPendingWork()
        #expect(engine.session == nil)
        #expect(engine.turns.isEmpty)
        #expect(engine.recordedAt == nil)
    }

    @Test @MainActor func theInboxOpensOnItsCachedRowsWithoutBlockingTheInitialiser() async {
        let host = HostID()
        let cache = tempCache()
        cache.writeInbox(host: host, data: inboxJSON)
        let store = InboxStore(api: UnreachableAPI(), hostId: host, cache: HostSnapshotCache(cache: cache, hostId: host))
        #expect(store.sections.isEmpty)
        await store.awaitPendingWork()
        #expect(store.sections.active.map(\.id) == ["s"])
        #expect(store.projectNames["p"] == "Proj")
        #expect(store.recordedAt != nil)
        // A copy is not a claim that the list is complete.
        #expect(!store.loaded)
    }
}
