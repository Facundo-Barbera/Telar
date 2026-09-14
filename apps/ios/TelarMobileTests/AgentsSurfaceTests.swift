import Foundation
import Testing
@testable import TelarMobile

/// THE AGENTS TAB'S TWO DERIVATIONS — issue #390. The Mac exports the same two
/// for the same reason: what a row SAYS, and which section it lands in, is a
/// decision, and a decision made inside a view that owns two network reads is
/// one nothing can put a case to without a server.
@Suite struct AgentsSurfaceTests {
    private func session(
        _ id: String, activity: String = "idle", startedFrom: String? = nil,
        title: String? = nil, createdAt: Int = 1000
    ) throws -> Session {
        var object: [String: Any] = [
            "id": id, "projectId": "p", "title": title ?? id, "createdAt": createdAt, "updatedAt": createdAt,
            "activity": activity, "driver": "claude", "workspace": ["mode": "local", "path": "/tmp"],
        ]
        if let startedFrom { object["startedFrom"] = ["sessionId": startedFrom] }
        return try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// THE FOUR RELATIONSHIPS, IN THE ORDER THE SECTION DRAWS THEM — outstanding
    /// work, then what came back, then what merely started here, then what this
    /// conversation only watches.
    @Test func groupsDelegatesByRelationshipInTheDesktopsOrder() throws {
        let rows = try [
            session("finished"),
            session("kid", startedFrom: "coord"),
            session("working", activity: "working"),
            session("watched"),
            session("stranger"),
            session("coord"),
        ]
        let assignments: [EngineID: [SessionAssignment]] = [
            "working": [SessionAssignment(fromSessionId: "coord", scope: "the parser", receivedAt: 20)],
            "finished": [SessionAssignment(fromSessionId: "coord", scope: "the tests", outcome: "completed", endedAt: 30)],
            // Somebody else's delegate is nobody's business here.
            "stranger": [SessionAssignment(fromSessionId: "other", scope: "not ours", receivedAt: 40)],
        ]
        let following = [Subscription(id: "sub_1", subscriberSessionId: "coord", targetSessionId: "watched")]
        let delegates = delegatesOf(rows, assignments: assignments, coordinator: "coord", following: following)

        #expect(delegates.map(\.id) == ["working", "finished", "kid", "watched"])
        #expect(delegates.map(\.kind) == [.assigned, .finished, .started, .followed])
        #expect(delegates[0].scope == "the parser")
        #expect(delegates[0].at == 20)
        #expect(delegates[1].outcome == "completed")
        #expect(delegates[1].at == 30)
        // A session that merely started here is dated by its own creation.
        #expect(delegates[2].at == 1000)
        #expect(delegates[3].subscriptionIds == ["sub_1"])
    }

    /// ONE ROW PER CONVERSATION. A delegate that is ALSO followed is one
    /// relationship to a reader and two facts about it: the errand names the
    /// row and the subscription rides along on it.
    @Test func aFollowedDelegateIsOneRowCarryingItsSubscriptions() throws {
        let rows = try [session("worker", activity: "working"), session("coord")]
        let assignments: [EngineID: [SessionAssignment]] = [
            "worker": [SessionAssignment(fromSessionId: "coord", receivedAt: 5)],
        ]
        let following = [
            Subscription(id: "sub_1", subscriberSessionId: "coord", targetSessionId: "worker"),
            // Followed twice — two events, or a one-shot beside a standing one.
            Subscription(id: "sub_2", subscriberSessionId: "coord", targetSessionId: "worker"),
            // A subscription on a session the live list does not hold is not a row.
            Subscription(id: "sub_3", subscriberSessionId: "coord", targetSessionId: "archived"),
        ]
        let delegates = delegatesOf(rows, assignments: assignments, coordinator: "coord", following: following)
        #expect(delegates.count == 1)
        #expect(delegates[0].kind == .assigned)
        #expect(delegates[0].subscriptionIds == ["sub_1", "sub_2"])
    }

    /// OUTSTANDING IS NOT "UN-ENDED". An `unresolved` assignment's carrier is
    /// gone, so its state is unknown — counting it as outstanding is how a
    /// paged-out delegate looks busy forever. It is not the live errand, and
    /// the row falls through to whatever else it is.
    @Test func anUnresolvedErrandIsNeverTheOutstandingOne() throws {
        let rows = try [session("worker"), session("coord")]
        let assignments: [EngineID: [SessionAssignment]] = [
            "worker": [
                SessionAssignment(fromSessionId: "coord", scope: "gone", unresolved: true, receivedAt: 1),
                SessionAssignment(fromSessionId: "coord", scope: "the tests", outcome: "failed", endedAt: 9),
            ],
        ]
        let delegates = delegatesOf(rows, assignments: assignments, coordinator: "coord")
        #expect(delegates.map(\.kind) == [.finished])
        #expect(delegates[0].scope == "the tests")
        #expect(delegates[0].outcome == "failed")
    }

    /// THE ERRAND A ROW REPORTS IS THE ONE THAT IS TRUE NOW: the OUTSTANDING
    /// one when there is one, and otherwise the most recent that ENDED — never
    /// the first historical one that happened to carry a scope, which would
    /// show the words of a task finished last week.
    @Test func theRowNamesTheCurrentErrandNotTheFirstOne() throws {
        let rows = try [session("worker", activity: "working"), session("coord")]
        let assignments: [EngineID: [SessionAssignment]] = [
            "worker": [
                SessionAssignment(fromSessionId: "coord", scope: "last week", outcome: "completed", receivedAt: 1, endedAt: 2),
                SessionAssignment(fromSessionId: "coord", scope: "yesterday", outcome: "stopped", receivedAt: 3, endedAt: 4),
                SessionAssignment(fromSessionId: "coord", scope: "right now", receivedAt: 5),
            ],
        ]
        let assigned = delegatesOf(rows, assignments: assignments, coordinator: "coord")
        #expect(assigned.map(\.scope) == ["right now"])

        // With nothing outstanding, the LAST ended one is the answer.
        let ended: [EngineID: [SessionAssignment]] = [
            "worker": assignments["worker"]!.dropLast(),
        ]
        let finished = delegatesOf(rows, assignments: ended, coordinator: "coord")
        #expect(finished.map(\.scope) == ["yesterday"])
        #expect(finished[0].outcome == "stopped")
    }

    /// A DETACHED ERRAND ENDED NOTHING. "Continue independently" is the reader
    /// saying this is nobody's work any more, so it neither makes a delegate
    /// row nor a "Working for" one — and provenance survives it, because
    /// `startedFrom` is permanent and detaching is not about where a
    /// conversation came from.
    @Test func detachedIsNotAFinishedErrandOnEitherSide() throws {
        let rows = try [session("worker", startedFrom: "coord"), session("coord")]
        let assignments: [EngineID: [SessionAssignment]] = [
            "worker": [SessionAssignment(fromSessionId: "coord", scope: "was ours", outcome: "detached", endedAt: 7)],
        ]
        let delegates = delegatesOf(rows, assignments: assignments, coordinator: "coord")
        #expect(delegates.map(\.kind) == [.started])
        #expect(coordinatorsOf(rows, assignments: assignments, of: "worker").isEmpty)
    }

    /// THE INVERSE, FOLDED STRAIGHT OFF THIS SESSION'S OWN ASSIGNMENTS:
    /// outstanding first, then the finished ones newest-first.
    @Test func coordinatorsAreOutstandingFirstThenNewest() throws {
        let rows = try [session("coord_a", title: "Planner"), session("worker")]
        let assignments: [EngineID: [SessionAssignment]] = [
            "worker": [
                SessionAssignment(fromSessionId: "coord_a", scope: "old", outcome: "completed", receivedAt: 1, endedAt: 10),
                SessionAssignment(fromSessionId: "coord_b", scope: "newer", outcome: "failed", receivedAt: 2, endedAt: 20),
                SessionAssignment(fromSessionId: "coord_a", scope: "live", receivedAt: 5),
            ],
        ]
        let employers = coordinatorsOf(rows, assignments: assignments, of: "worker")
        #expect(employers.map(\.scope) == ["live", "newer", "old"])
        #expect(employers[0].outstanding)
        // The coordinator's own row when the list still holds it, and its bare
        // id when it does not — a link built from that id would 404.
        #expect(employers[0].session?.title == "Planner")
        #expect(employers[1].session == nil)
        #expect(employers[1].sessionId == "coord_b")
        #expect(employers.map(\.id).count == Set(employers.map(\.id)).count)
    }

    /// A conversation is never its own delegate, whatever the record says.
    @Test func theCoordinatorIsNeverAmongItsOwnDelegates() throws {
        let rows = try [session("coord", startedFrom: "coord")]
        let assignments: [EngineID: [SessionAssignment]] = [
            "coord": [SessionAssignment(fromSessionId: "coord", receivedAt: 1)],
        ]
        #expect(delegatesOf(rows, assignments: assignments, coordinator: "coord").isEmpty)
    }

    /// WHAT THE TRAILING WORD SAYS. A live row reports its own ACTIVITY; a
    /// finished one reports the OUTCOME — and an outstanding errand on a
    /// session between turns still reads as work in hand, because "Idle" there
    /// would contradict the section the row is sitting in.
    @Test func aRowsWordIsItsActivityUntilTheErrandEnds() throws {
        let idle = try session("a")
        let working = try session("b", activity: "working")
        let blocked = try session("c", activity: "blocked")
        #expect(delegateState(RelatedDelegate(session: working, kind: .assigned, subscriptionIds: [])) == ("Working", .live))
        #expect(delegateState(RelatedDelegate(session: blocked, kind: .assigned, subscriptionIds: [])) == ("Needs you", .attention))
        #expect(delegateState(RelatedDelegate(session: idle, kind: .assigned, subscriptionIds: [])) == ("Working", .quiet))
        #expect(delegateState(RelatedDelegate(session: idle, kind: .started, subscriptionIds: [])) == ("Idle", .quiet))
        #expect(delegateState(RelatedDelegate(session: idle, kind: .finished, outcome: "completed", subscriptionIds: [])) == ("Done", .done))
        #expect(delegateState(RelatedDelegate(session: idle, kind: .finished, outcome: "failed", subscriptionIds: [])) == ("Failed", .danger))
        // A delegate that is working AGAIN is describing itself, not the errand.
        #expect(delegateState(RelatedDelegate(session: working, kind: .finished, subscriptionIds: [])) == ("Working", .live))
        // An outcome this build has never heard of is the engine's own word,
        // never a dropped row — the reason `outcome` stays a `String`.
        #expect(outcomeLabel("abandoned") == "abandoned")
        #expect(outcomeTone("abandoned") == .quiet)
    }

    /// THE SECOND LINE. A scope where there is one, the relationship's own word
    /// where there is not, and nothing at all rather than a lone bullet.
    @Test func theDetailLineNamesTheErrandOrTheRelationship() throws {
        let row = try session("a")
        let scoped = RelatedDelegate(session: row, kind: .assigned, scope: "the parser", subscriptionIds: [])
        #expect(delegateDetail(scoped, now: 0) == "the parser")
        #expect(delegateDetail(RelatedDelegate(session: row, kind: .started, subscriptionIds: []), now: 0) == "started from here")
        #expect(delegateDetail(RelatedDelegate(session: row, kind: .followed, subscriptionIds: []), now: 0) == "following")
        #expect(delegateDetail(RelatedDelegate(session: row, kind: .assigned, subscriptionIds: []), now: 0) == nil)
        // An engine that stamped no time costs the age, never the line.
        let dated = RelatedDelegate(session: row, kind: .assigned, scope: "x", at: 1000, subscriptionIds: [])
        #expect(delegateDetail(dated, now: 2000)?.hasPrefix("x · ") == true)
    }

    /// AN ERRAND WHOSE CARRIER IS GONE SAYS SO. "Unknown" is not "finished" and
    /// not "working for" — the row says the state is unknown rather than
    /// picking one of the two it cannot support.
    @Test func anUnresolvedErrandReportsThatItIsUnknown() throws {
        let rows = try [session("coord"), session("worker")]
        let assignments: [EngineID: [SessionAssignment]] = [
            "worker": [SessionAssignment(fromSessionId: "coord", scope: "gone", unresolved: true, receivedAt: 3)],
        ]
        let entry = try #require(coordinatorsOf(rows, assignments: assignments, of: "worker").first)
        #expect(!entry.outstanding)
        #expect(entry.unresolved)
        #expect(coordinatorState(entry) == ("Unknown", .quiet))
        #expect(coordinatorDetail(entry)?.hasPrefix("gone · state unknown") == true)
        #expect(coordinatorState(RelatedCoordinator(sessionId: "c", outstanding: true, unresolved: false, id: "0:c")) == ("Working for", .live))
    }

    /// THE ORDINARY ANSWER IS EMPTY, and it is not a failure: most conversations
    /// are nobody's coordinator and nobody's delegate.
    @Test func aConversationWithNoRelationshipsHasNoRows() throws {
        let rows = try [session("a"), session("b")]
        #expect(delegatesOf(rows, assignments: [:], coordinator: "a").isEmpty)
        #expect(coordinatorsOf(rows, assignments: [:], of: "a").isEmpty)
    }
}
