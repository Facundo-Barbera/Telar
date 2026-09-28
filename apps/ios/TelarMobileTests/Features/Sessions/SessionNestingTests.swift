import Foundation
import Testing
@testable import TelarMobile

@Suite struct SessionNestingTests {
    private let host = UUID()

    private func row(_ id: String, activity: String = "idle", startedFrom: String? = nil, pinned: Bool = false, project: String = "p") throws -> HostedSession {
        var object: [String: Any] = ["id": id, "projectId": project, "title": id, "createdAt": 1000, "updatedAt": 1000,
            "activity": activity, "driver": "claude", "workspace": ["mode": "local", "path": "/tmp"],
            "settledOverride": pinned ? "active" : NSNull()]
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
        let families = SessionNesting.families(rows, assignments: [:])
        #expect(families[0].needsYou == 1)
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

    @Test func aPinnedParentTakesItsChildrenOutOfTheirProjectGroup() throws {
        let rows = try [row("orchestrator", pinned: true), row("builder"), row("stuck", activity: "blocked"), row("mine")]
        let assignments = [key("builder"): [SessionAssignment(fromSessionId: "orchestrator", receivedAt: 1)],
                           key("stuck"): [SessionAssignment(fromSessionId: "orchestrator", receivedAt: 2)]]
        let model = SidebarModel(sessions: rows, names: { _ in "Telar" })
        let folded = SessionNesting.bands(model, assignments: assignments, expanded: [], selected: nil)
        #expect(folded.attention.isEmpty)
        #expect(ids(folded.pinned) == ["orchestrator", "  stuck"])
        #expect(folded.pinned[0].family?.needsYou == 1)
        #expect(folded.projects.map { ids($0.rows) } == [["mine"]])
        let open = SessionNesting.bands(model, assignments: assignments, expanded: [SessionNesting.foldKey(key("orchestrator"))], selected: nil)
        #expect(ids(open.pinned) == ["orchestrator", "  stuck", "  builder"])
    }

    @Test func aChildWhoseParentIsNotListedStaysInItsGroup() throws {
        let rows = try [row("builder", startedFrom: "settled"), row("other")]
        let bands = SessionNesting.bands(SidebarModel(sessions: rows, names: { _ in "Telar" }), assignments: [:], expanded: [], selected: nil)
        #expect(bands.projects.map { ids($0.rows) } == [["builder", "other"]])
    }

    @Test func aGroupLeftEmptyByNestingIsNotDrawn() throws {
        let rows = try [row("parent", pinned: true), row("child", startedFrom: "parent", project: "q")]
        let bands = SessionNesting.bands(SidebarModel(sessions: rows, names: { $0.session.projectId }), assignments: [:], expanded: [], selected: nil)
        #expect(bands.projects.isEmpty)
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
