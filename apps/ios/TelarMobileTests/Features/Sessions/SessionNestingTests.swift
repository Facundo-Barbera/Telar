import Foundation
import Testing
@testable import TelarMobile

@Suite struct SessionNestingTests {
    private let host = UUID()

    private func row(_ id: String, activity: String = "idle", startedFrom: String? = nil) throws -> HostedSession {
        var object: [String: Any] = ["id": id, "projectId": "p", "title": id, "createdAt": 1000, "updatedAt": 1000,
            "activity": activity, "driver": "claude", "workspace": ["mode": "local", "path": "/tmp"]]
        if let startedFrom { object["startedFrom"] = ["sessionId": startedFrom] }
        return HostedSession(hostId: host, session: try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: object)))
    }

    private func key(_ id: String) -> ScopedSessionID { ScopedSessionID(hostId: host, sessionId: id) }

    private func ids(_ rows: [NestedRow]) -> [String] { rows.map { ($0.nested ? "  " : "") + $0.row.session.id } }

    @Test func childrenHangUnderTheirRootParent() throws {
        let rows = try [row("parent"), row("a", startedFrom: "parent"), row("other"), row("grandchild", startedFrom: "a"),
                        row("b")]
        let assignments = [key("b"): [SessionAssignment(fromSessionId: "parent", receivedAt: 5)]]
        let families = SessionNesting.families(rows, assignments: assignments)
        #expect(families.map(\.parent.session.id) == ["parent", "other"])
        #expect(families[0].children.map(\.session.id) == ["a", "grandchild", "b"])
        let open = SessionNesting.visible(families, expanded: [SessionNesting.foldKey(key("parent"))], selected: nil)
        #expect(ids(open) == ["parent", "  a", "  grandchild", "  b", "other"])
    }

    @Test func aSessionKeepsItsFirstParentWhenAnotherTasksItLater() throws {
        let rows = try [row("parent"), row("later"), row("child", startedFrom: "parent"), row("errand")]
        let assignments = [
            key("child"): [SessionAssignment(fromSessionId: "later", receivedAt: 9)],
            key("errand"): [SessionAssignment(fromSessionId: "later", receivedAt: 9), SessionAssignment(fromSessionId: "parent", receivedAt: 2)],
        ]
        let families = SessionNesting.families(rows, assignments: assignments)
        #expect(families.map(\.parent.session.id) == ["parent", "later"])
        #expect(families[0].children.map(\.session.id) == ["child", "errand"])
        #expect(families[1].children.isEmpty)
        let expanded = Set(["parent", "later"].map { SessionNesting.foldKey(key($0)) })
        #expect(SessionNesting.visible(families, expanded: expanded, selected: nil).count == rows.count)
    }

    @Test func foldedParentStillShowsWhatNeedsYouAndTheOpenChild() throws {
        let rows = try [row("parent"), row("quiet", startedFrom: "parent"), row("stuck", activity: "blocked", startedFrom: "parent"),
                        row("open", startedFrom: "parent")]
        let hoisted = try row("hoisted", activity: "blocked", startedFrom: "open")
        let families = SessionNesting.families(rows, assignments: [:], elsewhere: [hoisted])
        #expect(families[0].needsYou == 2)
        let folded = SessionNesting.visible(families, expanded: [], selected: key("open"))
        #expect(ids(folded) == ["parent", "  stuck", "  open"])
        #expect(folded[0].family?.children.count == 3)
    }

    @Test func aParentWithNothingUnderItHasNoToggle() throws {
        let rows = try [row("solo"), row("orphan", startedFrom: "gone")]
        let visible = SessionNesting.visible(SessionNesting.families(rows, assignments: [:]), expanded: [], selected: nil)
        #expect(ids(visible) == ["solo", "orphan"])
        #expect(visible.allSatisfy { $0.family == nil })
    }

    @Test func aCycleLeavesEachSessionAtTheTop() throws {
        let rows = try [row("a", startedFrom: "b"), row("b", startedFrom: "a"), row("self", startedFrom: "self")]
        #expect(SessionNesting.families(rows, assignments: [:]).map(\.parent.session.id) == ["a", "b", "self"])
    }

    @Test func olderEnginesWithoutProvenanceDecodeFlat() throws {
        let json = #"""
        {"sessions":[{"id":"a","projectId":"p","title":"A","createdAt":1,"updatedAt":1,"driver":"claude","workspace":{"mode":"local"}},
                     {"id":"b","projectId":"p","title":"B","createdAt":1,"updatedAt":1,"driver":"claude","workspace":{"mode":"local"},"startedFrom":null}],
         "projects":[]}
        """#
        let live = try JSONDecoder().decode(LiveSessions.self, from: Data(json.utf8))
        #expect(live.assignments.isEmpty)
        let rows = live.sessions.map { HostedSession(hostId: host, session: $0) }
        #expect(rows.allSatisfy { $0.session.startedFrom == nil })
        #expect(SessionNesting.families(rows, assignments: [:]).map(\.children.count) == [0, 0])
    }
}
