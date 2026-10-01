import Foundation
import Testing
@testable import TelarMobile

private func tempCache() -> SnapshotCache {
    SnapshotCache(root: FileManager.default.temporaryDirectory.appending(path: "telar-shelf-\(UUID().uuidString)"))
}

private func body(_ rows: [(id: String, settled: Bool)]) -> Data {
    let now = Int(Date().timeIntervalSince1970 * 1000)
    let sessions = rows.map { row in
        """
        {"id":"\(row.id)","projectId":"p","title":"\(row.id)","state":"active","createdAt":\(now),"updatedAt":\(now),
         "driver":"claude","workspace":{"mode":"local","path":"/x"},"activity":"idle"\(row.settled ? #","settledOverride":"settled""# : "")}
        """
    }
    return Data(#"{"sessions":[\#(sessions.joined(separator: ","))],"projects":[{"id":"p","name":"Proj"}],"settledCount":1}"#.utf8)
}

private func read(_ data: Data, etag: String?) -> LiveSessionsRead {
    LiveSessionsRead(live: try! JSONDecoder().decode(LiveSessions.self, from: data), etag: etag, data: data)
}

private actor ShelfAPI: EngineAPI {
    private var lists: [LiveSessionsRead]
    private let shelfAnswer: LiveSessionsRead
    private(set) var shelfTags: [String?] = []

    init(lists: [LiveSessionsRead], shelf: LiveSessionsRead) {
        self.lists = lists
        self.shelfAnswer = shelf
    }

    func recordedShelfTags() -> [String?] { shelfTags }

    func liveSessions(matching etag: String?, since: Int?, all: Bool) async throws -> LiveSessionsRead {
        precondition(!all, "the list is read without the shelf")
        return lists.count > 1 ? lists.removeFirst() : lists[0]
    }

    func settledShelf(matching etag: String?) async throws -> LiveSessionsRead {
        shelfTags.append(etag)
        return etag == shelfAnswer.etag ? LiveSessionsRead(live: nil, etag: etag, data: nil) : shelfAnswer
    }

    func liveSessions() async throws -> LiveSessions { fatalError("unused") }
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

@Suite struct SettledShelfTests {
    @Test func anEmptyShelfAndAStaleOneAreRead_aFreshOneOnlyWhenTheListMoved() {
        var shelf = SettledShelf()
        #expect(shelf.needsRead(listChanged: false))
        shelf.absorb(read(body([("done", true)]), etag: "s1"))
        #expect(!shelf.needsRead(listChanged: false))
        #expect(shelf.needsRead(listChanged: true))
        shelf.stale = true
        #expect(shelf.needsRead(listChanged: false))
    }

    @Test func aNotModifiedAnswerKeepsTheRowsAndTheTag() {
        var shelf = SettledShelf()
        shelf.absorb(read(body([("done", true)]), etag: "s1"))
        let changed = shelf.absorb(LiveSessionsRead(live: nil, etag: "s1", data: nil))
        #expect(!changed)
        #expect(shelf.etag == "s1")
        #expect(shelf.merged(into: []).map(\.id) == ["done"])
    }

    @Test func theListsOwnCopyOfARowWins() {
        var shelf = SettledShelf()
        shelf.absorb(read(body([("done", true), ("open", true)]), etag: "s1"))
        let list = try! JSONDecoder().decode(LiveSessions.self, from: body([("open", false)])).sessions
        let merged = shelf.merged(into: list)
        #expect(merged.map(\.id) == ["open", "done"])
        #expect(merged.first?.settledOverride == nil)
    }

    @Test func aRecordRestoresTheRowsAndTheTag() {
        var shelf = SettledShelf()
        let data = body([("done", true)])
        shelf.absorb(read(data, etag: "s1"))
        let restored = SettledShelf.restored(shelf.record(data)!)
        #expect(restored?.etag == "s1")
        #expect(restored?.merged(into: []).map(\.id) == ["done"])
        #expect(restored?.stale == true)
    }

    @Test @MainActor func theShelfOpensOnLastLaunchsRowsAndAsksWithTheirTag() async {
        let host = HostID()
        let cache = tempCache()
        var earlier = SettledShelf()
        let shelfBody = body([("done", true)])
        earlier.absorb(read(shelfBody, etag: "s1"))
        cache.writeShelf(host: host, data: earlier.record(shelfBody)!)
        let api = ShelfAPI(lists: [read(body([("open", false)]), etag: "l1")], shelf: read(shelfBody, etag: "s1"))
        let store = InboxStore(api: api, hostId: host, cache: HostSnapshotCache(cache: cache, hostId: host))
        await store.refresh()

        await store.showSettled()

        #expect(store.sections.settled.map(\.id) == ["done"])
        #expect(store.sections.active.map(\.id) == ["open"])
        #expect(await api.recordedShelfTags() == ["s1"])
    }

    @Test @MainActor func anOpenShelfIsReadAgainOnlyWhenTheListMovesOrARowIsSettled() async {
        let host = HostID()
        let list = read(body([("open", false)]), etag: "l1")
        let api = ShelfAPI(
            lists: [list, LiveSessionsRead(live: nil, etag: "l1", data: nil), list],
            shelf: read(body([("done", true)]), etag: "s1")
        )
        let store = InboxStore(api: api, hostId: host, cache: HostSnapshotCache(cache: tempCache(), hostId: host))

        await store.showSettled()
        await store.refresh()
        #expect(await api.recordedShelfTags() == [nil])

        await store.refresh()
        #expect(await api.recordedShelfTags() == [nil, "s1"])

        await store.setSettled("open", true)
        #expect(await api.recordedShelfTags() == [nil, "s1", "s1"])
    }
}
