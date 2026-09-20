import Foundation
import Testing
@testable import TelarMobile

/// OPENING THE AGENT ON ITS LAST PAGE — issue #580.
///
/// The screen opened at `cursor = 0` and walked FORWARD, up to twenty pages, so
/// a 584-row thread cost a dozen sequential requests and most of a megabyte
/// before the first line was drawn. What the phone wanted was the END.
///
/// What must not drift:
///
///   - the OPEN asks for the tail and nothing else — one request, no walk;
///   - it polls forward from the thread's TIP, not from the top of the window
///     it just read, or the first poll would replay the whole conversation;
///   - pulling down asks for `before = oldest held`, prepends, and cannot
///     duplicate a row already on screen;
///   - a pull does NOT move the tip, and a poll does NOT move the floor;
///   - reaching the beginning is a fact the pager holds, so a reader at the top
///     cannot spin on an empty read;
///   - a Mac too old to serve a window leaves what is on screen rather than
///     emptying it.
@Suite @MainActor struct AgentPagingTests {

    // ── THE DOUBLE ───────────────────────────────────────────────────────────

    /// Every read the transcript can make, recorded in order.
    enum Ask: Equatable {
        case tail(limit: Int)
        case before(Int, limit: Int)
        case after(Int)
    }

    /// A Mac with `count` rows on its thread, answering the three reads the way
    /// the engine does — ascending rows, the TIP as `cursor` on a window, and
    /// `oldest` only when the window found something.
    final class ThreadAPI: EngineAPI, @unchecked Sendable {
        private(set) var asks: [Ask] = []
        let count: Int
        /// Refuse every windowed read, the way a Mac too old to serve one does.
        let refuseWindows: Bool

        init(count: Int, refuseWindows: Bool = false) {
            self.count = count
            self.refuseWindows = refuseWindows
        }

        struct Unavailable: Error {}

        /// Every read with no default on the protocol. This double models the
        /// Agent's thread and nothing else — the same shape the other doubles
        /// in this suite take.
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

        private func row(_ id: Int) -> AgentRow {
            AgentRow(id: id, runId: "run_\(id)", at: id, kind: .userMessage, text: "message \(id)")
        }

        func agentThreadTail(limit: Int) async throws -> AgentThreadPage {
            asks.append(.tail(limit: limit))
            if refuseWindows { throw Unavailable() }
            let first = max(1, count - limit + 1)
            guard count > 0 else { return AgentThreadPage(rows: [], cursor: 0, more: false) }
            return AgentThreadPage(rows: (first...count).map(row), cursor: count, more: first > 1, oldest: first)
        }

        func agentThread(before: Int, limit: Int) async throws -> AgentThreadPage {
            asks.append(.before(before, limit: limit))
            if refuseWindows { throw Unavailable() }
            let last = before - 1
            guard last >= 1 else { return AgentThreadPage(rows: [], cursor: count, more: false) }
            let first = max(1, last - limit + 1)
            return AgentThreadPage(rows: (first...last).map(row), cursor: count, more: first > 1, oldest: first)
        }

        func agentThread(after: Int) async throws -> AgentThreadPage {
            asks.append(.after(after))
            guard after < count else { return AgentThreadPage(rows: [], cursor: after, more: false) }
            return AgentThreadPage(rows: ((after + 1)...count).map(row), cursor: count, more: false)
        }
    }

    // ── THE OPEN ─────────────────────────────────────────────────────────────

    @Test func openingAsksForTheTailAndNothingElse() async {
        let api = ThreadAPI(count: 584)
        let pager = AgentThreadPager()
        await pager.open(api, limit: 50)

        // ONE REQUEST. The walk from row 0 is the whole bug.
        #expect(api.asks == [.tail(limit: 50)])
        #expect(pager.rows.map(\.id) == Array(535...584))
        // THE TIP, so the first poll asks for what is new rather than for the
        // five hundred rows between the window's top and the end.
        #expect(pager.cursor == 584)
        #expect(pager.oldest == 535)
        #expect(pager.hasOlder)
    }

    @Test func aThreadShorterThanOnePageIsTheWholeOfIt() async {
        let api = ThreadAPI(count: 4)
        let pager = AgentThreadPager()
        await pager.open(api, limit: 50)

        #expect(pager.rows.map(\.id) == [1, 2, 3, 4])
        #expect(pager.cursor == 4)
        #expect(pager.oldest == 1)
        // NOTHING OLDER, said as a fact — the pull is not offered at all.
        #expect(!pager.hasOlder)
    }

    @Test func anEmptyThreadOffersNoBackwardCursor() async {
        let api = ThreadAPI(count: 0)
        let pager = AgentThreadPager()
        await pager.open(api, limit: 50)

        #expect(pager.rows.isEmpty)
        #expect(pager.cursor == 0)
        #expect(pager.oldest == nil)
        #expect(!pager.hasOlder)
    }

    // ── PULLING BACKWARD ─────────────────────────────────────────────────────

    @Test func pullingDownPrependsWithoutDuplicating() async {
        let api = ThreadAPI(count: 120)
        let pager = AgentThreadPager()
        await pager.open(api, limit: 50)
        await pager.older(api, limit: 50)

        #expect(api.asks == [.tail(limit: 50), .before(71, limit: 50)])
        // The two windows JOIN UP: 21…120, each row exactly once.
        #expect(pager.rows.map(\.id) == Array(21...120))
        #expect(Set(pager.rows.map(\.id)).count == pager.rows.count)
        #expect(pager.oldest == 21)
        #expect(pager.hasOlder)
        // A PULL DOES NOT MOVE THE TIP. History is not news.
        #expect(pager.cursor == 120)
    }

    @Test func pullingToTheBeginningStopsOfferingMore() async {
        let api = ThreadAPI(count: 120)
        let pager = AgentThreadPager()
        await pager.open(api, limit: 50)
        await pager.older(api, limit: 50)
        await pager.older(api, limit: 50)

        #expect(pager.rows.map(\.id) == Array(1...120))
        #expect(pager.oldest == 1)
        #expect(!pager.hasOlder)

        // AND THE PULL AT THE TOP IS A NO-OP RATHER THAN AN EMPTY READ MADE FOR
        // EVER: the window answered its own floor, so there is nowhere left to
        // ask about.
        let before = api.asks.count
        await pager.older(api, limit: 50)
        #expect(api.asks.count == before + 1)
        #expect(pager.rows.map(\.id) == Array(1...120))
        #expect(pager.oldest == nil)
        #expect(!pager.hasOlder)
    }

    @Test func aPullBeforeTheOpenAsksNothing() async {
        let api = ThreadAPI(count: 120)
        let pager = AgentThreadPager()
        // No floor yet, so there is no `before` to send.
        await pager.older(api, limit: 50)
        #expect(api.asks.isEmpty)
        #expect(pager.rows.isEmpty)
    }

    // ── THE POLL, UNCHANGED ──────────────────────────────────────────────────

    @Test func theForwardPollResumesFromTheTipAndLeavesTheFloorAlone() async {
        let api = ThreadAPI(count: 120)
        let pager = AgentThreadPager()
        await pager.open(api, limit: 50)
        await pager.older(api, limit: 50)
        await pager.poll(api, maxPages: 20)

        // FROM THE TIP, not from the top of the window the pull just added.
        #expect(api.asks.last == .after(120))
        #expect(pager.cursor == 120)
        // THE FLOOR IS UNTOUCHED: a row arriving at the end says nothing about
        // where the beginning is, and moving it to meet the tip would skip
        // everything in between.
        #expect(pager.oldest == 21)
        #expect(pager.rows.map(\.id) == Array(21...120))
    }

    @Test func aPollThatBringsNewRowsMovesOnlyTheTip() async {
        let api = ThreadAPI(count: 60)
        let pager = AgentThreadPager()
        await pager.open(api, limit: 50)
        #expect(pager.cursor == 60)
        #expect(pager.oldest == 11)

        // The Mac has moved on; the same pager polls it.
        let busier = ThreadAPI(count: 63)
        await pager.poll(busier, maxPages: 20)
        #expect(busier.asks == [.after(60)])
        #expect(pager.rows.map(\.id) == Array(11...63))
        #expect(pager.cursor == 63)
        #expect(pager.oldest == 11)
    }

    @Test func reopeningAgainstRowsAlreadyHeldCostsOneRequestAndNoDuplicates() async {
        let api = ThreadAPI(count: 120)
        let pager = AgentThreadPager()
        await pager.open(api, limit: 50)
        await pager.open(api, limit: 50)

        #expect(api.asks == [.tail(limit: 50), .tail(limit: 50)])
        #expect(pager.rows.map(\.id) == Array(71...120))
        #expect(pager.cursor == 120)
    }

    // ── A MAC THAT CANNOT ANSWER ─────────────────────────────────────────────

    @Test func aMacThatRefusesTheWindowLeavesWhatIsOnScreen() async {
        let api = ThreadAPI(count: 120)
        let pager = AgentThreadPager()
        await pager.open(api, limit: 50)

        let broken = ThreadAPI(count: 120, refuseWindows: true)
        await pager.open(broken, limit: 50)
        await pager.older(broken, limit: 50)

        // NOTHING IS LOST TO A FAILED READ. The next poll is three seconds away.
        #expect(pager.rows.map(\.id) == Array(71...120))
        #expect(pager.cursor == 120)
        #expect(pager.oldest == 71)
    }
}
