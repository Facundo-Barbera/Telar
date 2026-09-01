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

    func session(_ id: EngineID) async throws -> SessionSnapshot {
        calls.append("session")
        return snapshots.removeFirst()
    }

    func events(_ id: EngineID, after: Int) async throws -> EventPage {
        calls.append("events(\(after))")
        return eventPages.removeFirst()
    }

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

private func snapshot() -> SessionSnapshot {
    try! JSONDecoder().decode(SessionSnapshot.self, from: Data("""
    {"session":{"id":"s","projectId":"p","title":"T","state":"active",
      "createdAt":1,"updatedAt":2,"driver":"claude",
      "workspace":{"mode":"local","path":"/x"},"runtimeMode":"auto","detached":false},
     "turns":[],"items":[],"requests":[],"tasks":[]}
    """.utf8))
}

@Suite struct SessionSyncTests {
    @Test func hydrateIssuesTheFourCallsInOrder() async throws {
        // events(0) → session (DISCARDED — it orders the reads) →
        // events(cursor) → session.
        let api = RecordingEngineAPI(
            eventPages: [
                page(#"{"events":[{"id":7,"at":1,"sessionId":"s","type":"turn.started"}],"cursor":7,"more":false}"#),
                page(#"{"events":[{"id":9,"at":2,"sessionId":"s","type":"turn.completed","resultText":"ok"}],"cursor":9,"more":false}"#),
            ],
            snapshots: [snapshot(), snapshot()]
        )
        let hydrated = try await hydrateSession(api, "s")
        #expect(await api.recorded() == ["events(0)", "session", "events(7)", "session"])
        #expect(hydrated.cursor == 9)
        #expect(hydrated.events.map(\.id) == [7, 9])
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

    @Test func cursorNeverRegressesOnAnEmptyPage() async throws {
        let api = RecordingEngineAPI(
            eventPages: [page(#"{"events":[],"cursor":0,"more":false}"#)],
            snapshots: []
        )
        let tail = try await tailSession(api, "s", after: 42)
        #expect(tail.cursor == 42)
    }
}
