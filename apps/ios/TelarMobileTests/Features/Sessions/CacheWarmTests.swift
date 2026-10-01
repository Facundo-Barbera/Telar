import Foundation
import Testing
@testable import TelarMobile

private func tempCache() -> SnapshotCache {
    SnapshotCache(root: FileManager.default.temporaryDirectory.appending(path: "telar-warm-\(UUID().uuidString)"))
}

private func liveBody(_ title: String) -> Data {
    Data("""
    {"sessions":[{"id":"s","projectId":"p","title":"\(title)","state":"active","createdAt":1,"updatedAt":2,
      "driver":"claude","workspace":{"mode":"local","path":"/x"},"runtimeMode":"auto","detached":false,"activity":"working"}],
     "projects":[{"id":"p","name":"Proj"}],"inbox":{"autoSettleAfterHours":72},"revision":4,"settledCount":284}
    """.utf8)
}

private actor WarmingInboxAPI: EngineAPI {
    private(set) var reads = 0
    private(set) var sentTags: [String?] = []

    private var answers: [LiveSessionsRead]

    init(answers: [LiveSessionsRead]) { self.answers = answers }

    func recorded() -> (reads: Int, tags: [String?]) { (reads, sentTags) }

    func liveSessions() async throws -> LiveSessions {
        fatalError("the cache must not cost a second read of the live list")
    }

    func liveSessions(matching etag: String?, since: Int?, all: Bool) async throws -> LiveSessionsRead {
        reads += 1
        sentTags.append(etag)
        return answers.count > 1 ? answers.removeFirst() : answers[0]
    }

    func health() async throws -> EngineHealth { fatalError("unused") }
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
    func sessionSkills(_ id: EngineID) async throws -> ProviderSkills { .empty }
    func projectSkills(_ projectId: EngineID, driver: String?) async throws -> ProviderSkills { .empty }
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

private actor WarmingSessionAPI: EngineAPI {
    private(set) var windows: [Int?] = []
    let body: Data

    init(body: Data) { self.body = body }

    func recorded() -> [Int?] { windows }

    func session(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionSnapshot {
        fatalError("the cache must not cost a second, unwindowed read of the history")
    }

    func sessionRead(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionRead {
        windows.append(window?.turns)
        return SessionRead(snapshot: try JSONDecoder().decode(SessionSnapshot.self, from: body), data: body)
    }

    func events(_ id: EngineID, after: Int) async throws -> EventPage {
        try JSONDecoder().decode(EventPage.self, from: Data(#"{"events":[],"cursor":7,"more":false}"#.utf8))
    }

    func health() async throws -> EngineHealth { fatalError("unused") }
    func liveSessions() async throws -> LiveSessions { fatalError("unused") }
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
    func sessionSkills(_ id: EngineID) async throws -> ProviderSkills { .empty }
    func projectSkills(_ projectId: EngineID, driver: String?) async throws -> ProviderSkills { .empty }
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

private let sessionBody = Data("""
{"cursor":7,"session":{"id":"s","projectId":"p","title":"Windowed","state":"active",
  "createdAt":1,"updatedAt":2,"driver":"claude",
  "workspace":{"mode":"local","path":"/x"},"runtimeMode":"auto","detached":false},
 "turns":[{"runId":"run_1","sessionId":"s","sequence":1,"state":"completed","input":"hi","acceptedAt":1,"updatedAt":1}],
 "items":[],"requests":[],"tasks":[]}
""".utf8)

@Suite struct CacheWarmTests {
    @Test @MainActor func theInboxRecordsThePollsOwnBytesAndReadsOnce() async {
        let host = HostID()
        let cache = tempCache()
        let body = liveBody("Live")
        let api = WarmingInboxAPI(answers: [LiveSessionsRead(live: try! JSONDecoder().decode(LiveSessions.self, from: body), etag: "v1", data: body)])
        let store = InboxStore(api: api, hostId: host, cache: HostSnapshotCache(cache: cache, hostId: host))
        await store.awaitPendingWork()

        await store.refresh()
        await store.awaitPendingWork()

        #expect(store.sections.active.map(\.id) == ["s"])

        #expect(cache.readInbox(host: host)?.data == body)

        #expect(await api.recorded().reads == 1)
    }

    @Test @MainActor func aNotModifiedTickKeepsTheCopyItAlreadyHas() async {
        let host = HostID()
        let cache = tempCache()
        let seeded = liveBody("Recorded earlier")
        cache.writeInbox(host: host, data: seeded)
        let api = WarmingInboxAPI(answers: [LiveSessionsRead(live: nil, etag: "v1", data: nil)])
        let store = InboxStore(api: api, hostId: host, cache: HostSnapshotCache(cache: cache, hostId: host))
        await store.awaitPendingWork()

        await store.refresh()
        await store.awaitPendingWork()

        #expect(cache.readInbox(host: host)?.data == seeded)

        #expect(store.lastError == nil)
        #expect(store.loaded)
    }

    @Test @MainActor func theTagEarnedIsTheTagSentNext() async {
        let host = HostID()
        let body = liveBody("Live")
        let live = try! JSONDecoder().decode(LiveSessions.self, from: body)
        let api = WarmingInboxAPI(answers: [
            LiveSessionsRead(live: live, etag: "v1", data: body),
            LiveSessionsRead(live: nil, etag: "v1", data: nil),
        ])
        let store = InboxStore(api: api, hostId: host, cache: HostSnapshotCache(cache: tempCache(), hostId: host))
        await store.awaitPendingWork()

        await store.refresh()
        await store.refresh()

        #expect(await api.recorded().tags == [nil, "v1"])
    }

    @Test @MainActor func anUnchangedAnswerIsNotRecordedOverTheRows() async {
        let host = HostID()
        let cache = tempCache()
        let seeded = liveBody("Recorded earlier")
        cache.writeInbox(host: host, data: seeded)
        let empty = Data(#"{"sessions":[],"projects":[],"unchanged":true}"#.utf8)
        let api = WarmingInboxAPI(answers: [
            LiveSessionsRead(live: try! JSONDecoder().decode(LiveSessions.self, from: empty), etag: "v1", data: empty),
        ])
        let store = InboxStore(api: api, hostId: host, cache: HostSnapshotCache(cache: cache, hostId: host))
        await store.awaitPendingWork()

        await store.refresh()
        await store.awaitPendingWork()

        #expect(cache.readInbox(host: host)?.data == seeded)
    }

    @Test @MainActor func aSessionRecordsTheWindowTheScreenOpenedOn() async {
        let host = HostID()
        let cache = tempCache()
        let api = WarmingSessionAPI(body: sessionBody)
        let engine = SessionSyncEngine(api: api, sessionId: "s", cache: HostSnapshotCache(cache: cache, hostId: host))
        await engine.awaitPendingWork()

        await engine.refresh()
        await engine.awaitPendingWork()

        #expect(engine.session?.title == "Windowed")
        #expect(cache.readSession(host: host, id: "s")?.data == sessionBody)

        #expect(await api.recorded() == [initialTurns])
    }
}
