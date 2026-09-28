import Foundation
import Testing
@testable import TelarMobile

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
        #expect(delegates[2].at == 1000)
        #expect(delegates[3].subscriptionIds == ["sub_1"])
    }

    @Test func aFollowedDelegateIsOneRowCarryingItsSubscriptions() throws {
        let rows = try [session("worker", activity: "working"), session("coord")]
        let assignments: [EngineID: [SessionAssignment]] = [
            "worker": [SessionAssignment(fromSessionId: "coord", receivedAt: 5)],
        ]
        let following = [
            Subscription(id: "sub_1", subscriberSessionId: "coord", targetSessionId: "worker"),
            Subscription(id: "sub_2", subscriberSessionId: "coord", targetSessionId: "worker"),
            Subscription(id: "sub_3", subscriberSessionId: "coord", targetSessionId: "archived"),
        ]
        let delegates = delegatesOf(rows, assignments: assignments, coordinator: "coord", following: following)
        #expect(delegates.count == 1)
        #expect(delegates[0].kind == .assigned)
        #expect(delegates[0].subscriptionIds == ["sub_1", "sub_2"])
    }

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

        let ended: [EngineID: [SessionAssignment]] = [
            "worker": assignments["worker"]!.dropLast(),
        ]
        let finished = delegatesOf(rows, assignments: ended, coordinator: "coord")
        #expect(finished.map(\.scope) == ["yesterday"])
        #expect(finished[0].outcome == "stopped")
    }

    @Test func detachedIsNotAFinishedErrandOnEitherSide() throws {
        let rows = try [session("worker", startedFrom: "coord"), session("coord")]
        let assignments: [EngineID: [SessionAssignment]] = [
            "worker": [SessionAssignment(fromSessionId: "coord", scope: "was ours", outcome: "detached", endedAt: 7)],
        ]
        let delegates = delegatesOf(rows, assignments: assignments, coordinator: "coord")
        #expect(delegates.map(\.kind) == [.started])
        #expect(coordinatorsOf(rows, assignments: assignments, of: "worker").isEmpty)
    }

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
        #expect(employers[0].session?.title == "Planner")
        #expect(employers[1].session == nil)
        #expect(employers[1].sessionId == "coord_b")
        #expect(employers.map(\.id).count == Set(employers.map(\.id)).count)
    }

    @Test func theCoordinatorIsNeverAmongItsOwnDelegates() throws {
        let rows = try [session("coord", startedFrom: "coord")]
        let assignments: [EngineID: [SessionAssignment]] = [
            "coord": [SessionAssignment(fromSessionId: "coord", receivedAt: 1)],
        ]
        #expect(delegatesOf(rows, assignments: assignments, coordinator: "coord").isEmpty)
    }

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
        #expect(delegateState(RelatedDelegate(session: working, kind: .finished, subscriptionIds: [])) == ("Working", .live))
        #expect(outcomeLabel("abandoned") == "abandoned")
        #expect(outcomeTone("abandoned") == .quiet)
    }

    @Test func theDetailLineNamesTheErrandOrTheRelationship() throws {
        let row = try session("a")
        let scoped = RelatedDelegate(session: row, kind: .assigned, scope: "the parser", subscriptionIds: [])
        #expect(delegateDetail(scoped, now: 0) == "the parser")
        #expect(delegateDetail(RelatedDelegate(session: row, kind: .started, subscriptionIds: []), now: 0) == "started from here")
        #expect(delegateDetail(RelatedDelegate(session: row, kind: .followed, subscriptionIds: []), now: 0) == "following")
        #expect(delegateDetail(RelatedDelegate(session: row, kind: .assigned, subscriptionIds: []), now: 0) == nil)
        let dated = RelatedDelegate(session: row, kind: .assigned, scope: "x", at: 1000, subscriptionIds: [])
        #expect(delegateDetail(dated, now: 2000)?.hasPrefix("x · ") == true)
    }

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

    @Test func aConversationWithNoRelationshipsHasNoRows() throws {
        let rows = try [session("a"), session("b")]
        #expect(delegatesOf(rows, assignments: [:], coordinator: "a").isEmpty)
        #expect(coordinatorsOf(rows, assignments: [:], of: "a").isEmpty)
    }
}
