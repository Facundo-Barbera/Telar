import Foundation
import Testing
@testable import TelarMobile

@Suite struct SessionNestingTests {
    private let host = UUID()

    private func row(_ id: String, activity: String = "idle", startedFrom: String? = nil, pinned: Bool = false, project: String = "p", activityAt: Int? = nil) throws -> HostedSession {
        var object: [String: Any] = ["id": id, "projectId": project, "title": id, "createdAt": 1000, "updatedAt": 1000,
            "activity": activity, "driver": "claude", "workspace": ["mode": "local", "path": "/tmp"],
            "settledOverride": pinned ? "active" : NSNull()]
        if let startedFrom { object["startedFrom"] = ["sessionId": startedFrom] }
        if let activityAt { object["activityAt"] = activityAt }
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

    private func orchestra() throws -> ([HostedSession], [ScopedSessionID: [SessionAssignment]]) {
        let rows = try [row("orchestrator", pinned: true), row("builder"), row("stuck", activity: "blocked"), row("mine", project: "q")]
        let assignments = [key("builder"): [SessionAssignment(fromSessionId: "orchestrator", receivedAt: 1)],
                           key("stuck"): [SessionAssignment(fromSessionId: "orchestrator", receivedAt: 2)]]
        return (rows, assignments)
    }

    @Test func groupedModeKeepsEveryRowInItsOwnSection() throws {
        let (rows, _) = try orchestra()
        let model = SidebarModel(sessions: rows, names: { $0.session.projectId })
        #expect(model.attention.map(\.session.id) == ["stuck"])
        #expect(model.pinned.map(\.session.id) == ["orchestrator"])
        #expect(model.projects.map { $0.sessions.map(\.session.id) } == [["builder"], ["mine"]])
    }

    @Test func flatModeHangsChildrenUnderAPinnedParentAsCompactRows() throws {
        let (rows, assignments) = try orchestra()
        let folded = SessionNesting.flat(rows, assignments: assignments, expanded: [], selected: nil)
        #expect(ids(folded.pinned) == ["orchestrator", "  stuck"])
        #expect(folded.pinned[0].family?.needsYou == 1)
        #expect(ids(folded.rows) == ["mine"])
        let open = SessionNesting.flat(rows, assignments: assignments, expanded: [SessionNesting.foldKey(key("orchestrator"))], selected: nil)
        #expect(ids(open.pinned) == ["orchestrator", "  builder", "  stuck"])
    }

    @Test func flatModeListsPinnedInTheirArrangedOrderThenNewestActivity() throws {
        let rows = try [row("old-but-busy", activityAt: 9000), row("quiet"), row("middle", activityAt: 5000),
                        row("pin-a", pinned: true), row("pin-b", pinned: true)]
        let rail = SessionNesting.flat(rows, layouts: [host: SidebarLayout(pinnedOrder: ["pin-b", "pin-a"])], assignments: [:], expanded: [], selected: nil)
        #expect(ids(rail.pinned) == ["pin-b", "pin-a"])
        #expect(ids(rail.rows) == ["old-but-busy", "middle", "quiet"])
    }

    @Test func flatModeListsNewestActivityFirstAndLeavesOrphansInPlace() throws {
        let rows = try [row("old"), row("builder", startedFrom: "settled"), row("new", activityAt: 5000)]
        let rail = SessionNesting.flat(rows, assignments: [:], expanded: [], selected: nil)
        #expect(rail.pinned.isEmpty)
        #expect(ids(rail.rows) == ["new", "builder", "old"])
    }

    @Test func aBlockedSessionStaysInTheFlatListWithItsChildren() throws {
        let rows = try [row("parent", activity: "blocked"), row("child", startedFrom: "parent")]
        let rail = SessionNesting.flat(rows, assignments: [:], expanded: [SessionNesting.foldKey(key("parent"))], selected: nil)
        #expect(ids(rail.rows) == ["parent", "  child"])
    }

    @Test func aPinnedChildStaysTopLevelWhereThePersonPutIt() throws {
        let rows = try [row("parent"), row("child", startedFrom: "parent", pinned: true)]
        let rail = SessionNesting.flat(rows, assignments: [:], expanded: [], selected: nil)
        #expect(ids(rail.pinned) == ["child"])
        #expect(ids(rail.rows) == ["parent"])
        #expect(rail.rows[0].family == nil)
    }

    @Test func aProjectlessSessionIsListedInTheFlatRail() throws {
        let rows = try [row("loose", project: "")]
        #expect(ids(SessionNesting.flat(rows, assignments: [:], expanded: [], selected: nil).rows) == ["loose"])
    }

    @Test func theModesReadProjectAndNone() {
        #expect(SidebarMode(rawValue: "flat") == .flat)
        #expect(SidebarMode(rawValue: "tree") == nil)
        #expect(SidebarMode.allCases.map(\.label) == ["Project", "None"])
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
