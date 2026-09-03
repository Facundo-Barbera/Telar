import Foundation
import Testing
@testable import TelarMobile

/// Records the exact call sequence and replays canned responses — the hydrate
/// ordering is load-bearing and this is the test that stops it being
/// "optimised" away.
actor RecordingEngineAPI: EngineAPI {
    private(set) var calls: [String] = []
    var eventPages: [EventPage]
    var snapshots: [SessionSnapshot]

    init(eventPages: [EventPage], snapshots: [SessionSnapshot]) {
        self.eventPages = eventPages
        self.snapshots = snapshots
    }

    func recorded() -> [String] { calls }

    func health() async throws -> EngineHealth { fatalError("unused") }
    func liveSessions() async throws -> LiveSessions { fatalError("unused") }

    func session(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionSnapshot {
        // The window is part of the recorded shape: a hydrate that silently
        // dropped it would fetch the whole history again.
        if let window {
            let before = window.before.map { ",before:\($0)" } ?? ""
            calls.append("session(turns:\(window.turns)\(before))")
        } else {
            calls.append("session")
        }
        return snapshots.removeFirst()
    }

    func events(_ id: EngineID, after: Int) async throws -> EventPage {
        calls.append("events(\(after))")
        return eventPages.removeFirst()
    }

    func sessionData(_ id: EngineID) async throws -> Data { fatalError("unused") }
    func liveSessionsData() async throws -> Data { fatalError("unused") }

    func submitTurn(_ id: EngineID, runId: String, input: String, attachments: [EngineID]?) async throws -> TurnSubmissionResult { fatalError("unused") }
    func stop(_ id: EngineID, runId: String?) async throws {}
    func resolveRequest(_ id: EngineID, requestId: EngineID, decision: RequestDecision, reason: String?, answers: [String: AnswerValue]?) async throws {}
    func patchSession(_ id: EngineID, patch: SessionPatch) async throws {}
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

private func page(_ json: String) -> EventPage {
    try! JSONDecoder().decode(EventPage.self, from: Data(json.utf8))
}

private func snapshot(cursor: Int? = nil, turns: String = "[]", items: String = "[]", page: String? = nil) -> SessionSnapshot {
    let stamp = cursor.map { "\"cursor\":\($0)," } ?? ""
    let paged = page.map { "\"page\":\($0)," } ?? ""
    return try! JSONDecoder().decode(SessionSnapshot.self, from: Data("""
    {\(stamp)\(paged)"session":{"id":"s","projectId":"p","title":"T","state":"active",
      "createdAt":1,"updatedAt":2,"driver":"claude",
      "workspace":{"mode":"local","path":"/x"},"runtimeMode":"auto","detached":false},
     "turns":\(turns),"items":\(items),"requests":[],"tasks":[]}
    """.utf8))
}

private func turnJSON(_ runId: String, _ sequence: Int, state: String = "completed") -> String {
    #"{"runId":"\#(runId)","sessionId":"s","sequence":\#(sequence),"state":"\#(state)","input":"T\#(sequence)","acceptedAt":1,"updatedAt":1}"#
}

private func itemJSON(_ id: String, _ runId: String) -> String {
    #"{"id":"\#(id)","runId":"\#(runId)","sessionId":"s","status":"completed","startedAt":1,"detail":{"type":"assistant_message","text":"\#(id)"}}"#
}

@Suite struct SessionSyncTests {
    @Test func hydrateOpensOnTheSnapshotAndTailsFromItsCursor() async throws {
        // session (stamped 7) → events(7). Never events(0).
        let api = RecordingEngineAPI(
            eventPages: [
                page(#"{"events":[{"id":9,"at":2,"sessionId":"s","type":"turn.completed","resultText":"ok"}],"cursor":9,"more":false}"#),
            ],
            snapshots: [snapshot(cursor: 7)]
        )
        let hydrated = try await hydrateSession(api, "s")
        #expect(await api.recorded() == ["session", "events(7)"])
        #expect(hydrated.cursor == 9)
        #expect(hydrated.events.map(\.id) == [9])
    }

    @Test func aQuietSessionKeepsTheSnapshotCursor() async throws {
        let api = RecordingEngineAPI(
            eventPages: [page(#"{"events":[],"cursor":0,"more":false}"#)],
            snapshots: [snapshot(cursor: 7)]
        )
        let hydrated = try await hydrateSession(api, "s")
        #expect(hydrated.cursor == 7)
    }

    @Test func anOlderEngineWithoutTheStampIsAskedWhereTheJournalEnds() async throws {
        let api = RecordingEngineAPI(
            eventPages: [
                page(#"{"events":[{"id":7,"at":1,"sessionId":"s","type":"turn.started"}],"cursor":7,"more":false}"#),
                page(#"{"events":[],"cursor":7,"more":false}"#),
            ],
            snapshots: [snapshot()]
        )
        let hydrated = try await hydrateSession(api, "s")
        #expect(await api.recorded() == ["session", "events(0)", "events(7)"])
        #expect(hydrated.cursor == 7)
    }

    @Test func tailFetchesSnapshotOnlyOnQueueChangingEvents() async throws {
        // A page of pure deltas: NO snapshot call.
        let deltas = RecordingEngineAPI(
            eventPages: [
                page(#"{"events":[{"id":11,"at":1,"sessionId":"s","runId":"r","type":"content.delta","itemId":"i","stream":"assistant_text","text":"x"}],"cursor":11,"more":false}"#),
            ],
            snapshots: []
        )
        let quiet = try await tailSession(deltas, "s", after: 10)
        #expect(quiet.snapshot == nil)
        #expect(quiet.cursor == 11)
        #expect(await deltas.recorded() == ["events(10)"])

        // turn.completed and request.opened both earn one.
        for eventJSON in [
            #"{"id":12,"at":1,"sessionId":"s","runId":"r","type":"turn.completed","resultText":""}"#,
            #"{"id":12,"at":1,"sessionId":"s","runId":"r","type":"request.opened"}"#,
        ] {
            let api = RecordingEngineAPI(
                eventPages: [page(#"{"events":[\#(eventJSON)],"cursor":12,"more":false}"#)],
                snapshots: [snapshot()]
            )
            let tail = try await tailSession(api, "s", after: 10)
            #expect(tail.snapshot != nil)
        }
    }

    @Test func theWindowRidesThroughHydrateAndTheTailCompanionSnapshot() async throws {
        let api = RecordingEngineAPI(
            eventPages: [page(#"{"events":[],"cursor":7,"more":false}"#)],
            snapshots: [snapshot(cursor: 7, page: #"{"before":"run_4","more":true}"#)]
        )
        let hydrated = try await hydrateSession(api, "s", window: SnapshotWindow(turns: 10))
        #expect(await api.recorded() == ["session(turns:10)", "events(7)"])
        #expect(hydrated.snapshot.page?.before == "run_4")
        #expect(hydrated.snapshot.page?.more == true)

        let tailAPI = RecordingEngineAPI(
            eventPages: [page(#"{"events":[{"id":12,"at":1,"sessionId":"s","runId":"r","type":"turn.completed","resultText":""}],"cursor":12,"more":false}"#)],
            snapshots: [snapshot()]
        )
        _ = try await tailSession(tailAPI, "s", after: 10, window: SnapshotWindow(turns: 10))
        #expect(await tailAPI.recorded() == ["events(10)", "session(turns:10)"])
    }

    @Test func loadOlderTurnsAsksForOnePageAboveTheCursor() async throws {
        let api = RecordingEngineAPI(
            eventPages: [],
            snapshots: [snapshot(turns: "[\(turnJSON("run_1", 1))]", page: #"{"before":null,"more":false}"#)]
        )
        let older = try await loadOlderTurns(api, "s", before: "run_5")
        #expect(await api.recorded() == ["session(turns:20,before:run_5)"])
        #expect(older.turns.map(\.runId) == ["run_1"])
        // JSON null `before` decodes as nil — the session's start.
        #expect(older.page?.before == nil)
        #expect(older.page?.more == false)
    }

    @Test func mergeOlderPagePrependsWithoutDuplicatingTheOverlap() async throws {
        // Current holds run_2..run_3; the older page overlaps on run_2.
        let current = snapshot(
            turns: "[\(turnJSON("run_2", 2, state: "completed")),\(turnJSON("run_3", 3))]",
            items: "[\(itemJSON("i_2", "run_2"))]"
        )
        let olderSnapshot = snapshot(
            turns: "[\(turnJSON("run_1", 1)),\(turnJSON("run_2", 2, state: "running"))]",
            items: "[\(itemJSON("i_1", "run_1")),\(itemJSON("i_2", "run_2"))]"
        )
        let older = OlderPage(
            turns: olderSnapshot.turns, items: olderSnapshot.items,
            tasks: [], page: SnapshotPage(before: nil, more: false)
        )
        let merged = mergeOlderPage(current: current, page: older)
        // Oldest-first after merge, no duplicate for the overlap — and the
        // CURRENT row wins it (the fresher read of a settling turn).
        #expect(merged.turns.map(\.runId) == ["run_1", "run_2", "run_3"])
        #expect(merged.turns[1].state == .completed)
        #expect(merged.items.map(\.id) == ["i_1", "i_2"])
    }

    @Test func cursorNeverRegressesOnAnEmptyPage() async throws {
        let api = RecordingEngineAPI(
            eventPages: [page(#"{"events":[],"cursor":0,"more":false}"#)],
            snapshots: []
        )
        let tail = try await tailSession(api, "s", after: 42)
        #expect(tail.cursor == 42)
    }
}
