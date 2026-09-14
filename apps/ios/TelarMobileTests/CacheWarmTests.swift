import Foundation
import Testing
@testable import TelarMobile

/// THE CACHE IS WARMED BY THE READ THAT EARNED IT (#499).
///
/// Both stores used to poll the Mac and then immediately read the same record
/// AGAIN to have bytes to write with. The inbox re-pulled the whole live list —
/// 318 KB on the owner's store, behind a poll that runs every three seconds
/// while anything is live — and an open session re-pulled its UNWINDOWED
/// history, up to 4.5 MB, behind a hydrate that had deliberately asked for ten
/// turns. Both reads were of rows the store had just been handed.
///
/// THE DOUBLES REFUSE THE SECOND READ RATHER THAN COUNTING IT. `liveSessions()`
/// and the unwindowed `session` are what the old warms called, so they trap
/// here: a regression cannot pass this suite by being merely cheaper.
private func tempCache() -> SnapshotCache {
    SnapshotCache(root: FileManager.default.temporaryDirectory.appending(path: "telar-warm-\(UUID().uuidString)"))
}

/// A live list with one active row, and the policy riding along so the store
/// has no reason to make the once-a-minute policy read beside it.
private func liveBody(_ title: String) -> Data {
    Data("""
    {"sessions":[{"id":"s","projectId":"p","title":"\(title)","state":"active","createdAt":1,"updatedAt":2,
      "driver":"claude","workspace":{"mode":"local","path":"/x"},"runtimeMode":"auto","detached":false,"activity":"working"}],
     "projects":[{"id":"p","name":"Proj"}],"inbox":{"autoSettleAfterHours":72},"revision":4,"settledCount":284}
    """.utf8)
}

/// Answers the conditional live read and nothing else.
private actor WarmingInboxAPI: EngineAPI {
    private(set) var reads = 0
    private(set) var sentTags: [String?] = []
    /// What the next reads answer, in order; the last one repeats.
    private var answers: [LiveSessionsRead]

    init(answers: [LiveSessionsRead]) { self.answers = answers }

    func recorded() -> (reads: Int, tags: [String?]) { (reads, sentTags) }

    /// THE SECOND READ THE OLD `remember` MADE. Nothing should reach this.
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

/// Answers the windowed snapshot read, and traps the unwindowed one.
private actor WarmingSessionAPI: EngineAPI {
    private(set) var windows: [Int?] = []
    let body: Data

    init(body: Data) { self.body = body }

    func recorded() -> [Int?] { windows }

    /// WHAT THE OLD WARM CALLED, with no window at all — the whole run.
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
        // The bytes on disk are the poll's own, not a second read's.
        #expect(cache.readInbox(host: host)?.data == body)
        // ONE request for the tick. The old warm made a second.
        #expect(await api.recorded().reads == 1)
    }

    /// A 304 carries no body, so there is nothing new to record — and what is
    /// already on disk is still the last thing this Mac actually said.
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
        // A tick that succeeded is a tick that succeeded.
        #expect(store.lastError == nil)
        #expect(store.loaded)
    }

    /// The tag earned on one tick is what the next one asks with — otherwise
    /// every poll is a full read and the 304 above never happens.
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

    /// An `unchanged` answer carries no rows, so recording it would replace the
    /// phone's copy with emptiness — the one thing the cache exists not to show.
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

    /// The cached first frame is the frame the reader last saw: ten turns, not
    /// the whole run. The double traps the unwindowed read outright.
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
        // One read, and it carried the window hydrate asked for.
        #expect(await api.recorded() == [initialTurns])
    }
}
