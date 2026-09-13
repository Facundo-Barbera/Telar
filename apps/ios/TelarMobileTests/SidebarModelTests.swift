import Foundation
import Testing
@testable import TelarMobile

@Suite struct SidebarModelTests {
    private func row(host: UUID, id: String, project: String, activity: String = "working", pinned: Bool = false, startedFrom: String? = nil) throws -> HostedSession {
        var object: [String: Any] = ["id": id, "projectId": project, "title": id, "createdAt": 1000, "updatedAt": 1000,
            "activity": activity, "settledOverride": pinned ? "active" : NSNull(), "driver": "claude", "workspace": ["mode": "local", "path": "/tmp"]]
        if let startedFrom { object["startedFrom"] = ["sessionId": startedFrom] }
        return HostedSession(hostId: host, session: try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: object)))
    }
    private func assignment(from: String, scope: String? = nil, outcome: String? = nil) -> SessionAssignment {
        SessionAssignment(fromSessionId: from, scope: scope, outcome: outcome)
    }
    private func subscription(to target: String, from subscriber: String = "coord") -> Subscription {
        Subscription(id: "sub_\(subscriber)_\(target)", subscriberSessionId: subscriber, targetSessionId: target)
    }
    @Test func attentionOutranksPinsAndRowsAppearExactlyOnce() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "a", project: "p", activity: "blocked", pinned: true), row(host: host, id: "b", project: "p", pinned: true), row(host: host, id: "c", project: "p")]
        let result = SidebarModel(sessions: rows, names: { _ in "Project" })
        #expect(result.attention.map(\.session.id) == ["a"])
        #expect(result.pinned.map(\.session.id) == ["b"])
        #expect(result.projects.flatMap(\.sessions).map(\.session.id) == ["c"])
    }
    @Test func respectsProjectOrderAndKeepsSameProjectOnDifferentMacsSeparate() throws {
        let a = UUID(), b = UUID()
        let rows = try [row(host: a, id: "a", project: "alpha"), row(host: a, id: "b", project: "beta"), row(host: b, id: "a", project: "alpha")]
        let result = SidebarModel(sessions: rows, names: { $0.session.projectId }, layouts: [a: SidebarLayout(projectOrder: ["beta", "alpha"])])
        #expect(result.projects.count == 3)
        #expect(result.projects.filter { $0.hostId == a }.map(\.projectId) == ["beta", "alpha"])
    }
    /// THE HEADER'S COUNT IS THE ROWS UNDER IT, NOT THE PROJECT'S SESSIONS —
    /// the desktop's `shown` (project-group.tsx). The two differ exactly when a
    /// project has work in the bands above: a blocked row is showing under
    /// "Needs you" and a pinned one above the list, so counting them here would
    /// promise rows the group cannot produce when it is opened.
    @Test func projectCountIsTheRowsItShowsNotEveryRowItOwns() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "blocked", project: "p", activity: "blocked"),
                        row(host: host, id: "pinned", project: "p", pinned: true),
                        row(host: host, id: "one", project: "p"),
                        row(host: host, id: "two", project: "p")]
        let result = SidebarModel(sessions: rows, names: { _ in "Project" })
        let group = try #require(result.projects.first)
        #expect(result.projects.count == 1)
        #expect(group.sessions.count == 2)
        #expect(group.sessions.map(\.session.id) == ["one", "two"])
    }

    /// A project whose every row was lifted away is not an empty group with a
    /// "0" beside it — it is not a group at all.
    @Test func aProjectWithNothingLeftToShowDoesNotRenderAHeader() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "blocked", project: "p", activity: "blocked"),
                        row(host: host, id: "pinned", project: "p", pinned: true)]
        let result = SidebarModel(sessions: rows, names: { _ in "Project" })
        #expect(result.projects.isEmpty)
    }

    /// THE ROWS INSIDE A GROUP, arranged on the Mac and drawn here (#306). The
    /// phone read `projectOrder` only, so a conversation dragged within its
    /// group showed on the phone in default order — the desktop's own rule is
    /// `orderSessions`: placed rows first, unplaced ones after in the order
    /// they arrived.
    @Test func honoursSessionOrderInsideAGroupAndLeavesUnplacedRowsWhereTheyWere() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "a", project: "p"), row(host: host, id: "b", project: "p"), row(host: host, id: "c", project: "p")]
        let layouts = [host: SidebarLayout(sessionOrder: ["p": ["c", "a"]])]
        let group = try #require(SidebarModel(sessions: rows, names: { _ in "Project" }, layouts: layouts).projects.first)
        #expect(group.sessions.map(\.session.id) == ["c", "a", "b"])
    }

    /// The pinned band is one band, so it is one list — and it is arranged by
    /// the same partition.
    @Test func honoursPinnedOrder() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "a", project: "p", pinned: true),
                        row(host: host, id: "b", project: "p", pinned: true),
                        row(host: host, id: "c", project: "p", pinned: true)]
        let layouts = [host: SidebarLayout(pinnedOrder: ["c", "b"])]
        #expect(SidebarModel(sessions: rows, names: { _ in "Project" }, layouts: layouts).pinned.map(\.session.id) == ["c", "b", "a"])
    }

    /// AN ARRANGEMENT IS ONE MAC'S. Two Macs can mint the same session id, and
    /// each writes its own document; a rank read from the wrong Mac's list
    /// would place a row by a decision nobody made about it. The band still
    /// draws every row exactly once, in a stable order — `sort` is not stable
    /// in Swift, and both rows here claim rank 0.
    @Test func aRankFromOneMacNeverPlacesAnotherMacsRow() throws {
        let a = UUID(), b = UUID()
        let rows = try [row(host: a, id: "shared", project: "p", pinned: true), row(host: b, id: "shared", project: "p", pinned: true)]
        let pinned = SidebarModel(sessions: rows, names: { _ in "Project" }, layouts: [a: SidebarLayout(pinnedOrder: ["shared"])]).pinned
        #expect(pinned.count == 2)
        // The placed row (host a's) comes first; host b's was never named by
        // host a's document and falls in after it, where it arrived.
        #expect(pinned.map(\.hostId) == [a, b])
    }

    /// A document written before the row arrangements existed, or by a Mac that
    /// has none, leaves the list exactly as the merge produced it.
    @Test func noArrangementLeavesTheRecencyOrderAlone() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "a", project: "p"), row(host: host, id: "b", project: "p")]
        let layouts = [host: SidebarLayout(projectOrder: ["p"])]
        let group = try #require(SidebarModel(sessions: rows, names: { _ in "Project" }, layouts: layouts).projects.first)
        #expect(group.sessions.map(\.session.id) == ["a", "b"])
    }

    /// TWO MACS' CHECKOUTS OF ONE REPOSITORY ARE ONE GROUP (#331), because that
    /// is what they are to the person looking at them. The ids are minted per
    /// engine, so the fold is on `Project.remoteUrl` — and the group then has to
    /// carry BOTH Macs' registrations, since a New conversation built from one
    /// of them opens nothing on the other.
    @Test func twoMacsCheckoutsOfOneRepositoryFoldIntoOneGroupCarryingBothPlaces() throws {
        let a = UUID(), b = UUID()
        let rows = try [row(host: a, id: "one", project: "project_here"), row(host: b, id: "two", project: "project_there")]
        let result = SidebarModel(sessions: rows, names: { _ in "Telar" },
                                  remotes: { _ in "github.com/owner/repo" },
                                  hostNames: { $0 == a ? "Laptop" : "Mini" })
        let group = try #require(result.projects.first)
        #expect(result.projects.count == 1)
        #expect(group.id == "repo:github.com/owner/repo")
        #expect(group.sessions.map(\.session.id) == ["one", "two"])
        // Named order, so a badge list does not re-shuffle itself between polls.
        #expect(group.places.map(\.hostId) == [a, b])
        #expect(group.places.map(\.projectId) == ["project_here", "project_there"])
    }

    /// THE ABSENCE OF A REPOSITORY IS NEVER AN ANSWER. Two originless folders
    /// both called `scratch` are two projects, and folding them on their name
    /// would be a worse failure than the one #331 fixes — so a row that cannot
    /// name a repository keeps the per-Mac key it always had.
    @Test func projectsWithNoRepositoryStayOneGroupPerMac() throws {
        let a = UUID(), b = UUID()
        let rows = try [row(host: a, id: "one", project: "scratch"), row(host: b, id: "two", project: "scratch")]
        let result = SidebarModel(sessions: rows, names: { _ in "scratch" })
        #expect(result.projects.count == 2)
        #expect(Set(result.projects.map(\.id)) == ["\(a.uuidString):scratch", "\(b.uuidString):scratch"])
    }

    /// A DIFFERENT REPOSITORY IS A DIFFERENT GROUP, even under one name.
    @Test func twoRepositoriesAreTwoGroupsHoweverTheyAreNamed() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "one", project: "p1"), row(host: host, id: "two", project: "p2")]
        let remotes = ["p1": "github.com/owner/repo", "p2": "github.com/owner/other"]
        let result = SidebarModel(sessions: rows, names: { _ in "Telar" }, remotes: { remotes[$0.session.projectId ?? ""] })
        #expect(result.projects.count == 2)
    }

    /// A MERGED GROUP IS KEYED `repo:…` IN EVERY MAC'S OWN DOCUMENT, and each
    /// row is still ranked by ITS OWN Mac's list: the two documents are two
    /// decisions, and reading one Mac's rank for the other's row would place it
    /// by a decision nobody made about it.
    @Test func aMergedGroupReadsEachMacsRowOrderUnderTheRepositoryKey() throws {
        let a = UUID(), b = UUID()
        let rows = try [row(host: a, id: "a1", project: "p_here"), row(host: a, id: "a2", project: "p_here"),
                        row(host: b, id: "b1", project: "p_there")]
        let key = "repo:github.com/owner/repo"
        let layouts = [a: SidebarLayout(projectOrder: [key], sessionOrder: [key: ["a2", "a1"]]),
                       b: SidebarLayout(projectOrder: [key])]
        let group = try #require(SidebarModel(sessions: rows, names: { _ in "Telar" },
                                              remotes: { _ in "github.com/owner/repo" },
                                              layouts: layouts).projects.first)
        #expect(group.layoutKey == key)
        // Host a placed its two; host b never named its own, so it falls in after.
        #expect(group.sessions.map(\.session.id) == ["a2", "a1", "b1"])
    }

    /// A GROUP NOBODY PLACED FALLS IN AFTER THE PLACED ONES, alphabetically —
    /// the desktop's `orderProjectGroups`. The rail stopped being a block per
    /// Mac when a group could span two of them.
    @Test func placedGroupsComeFirstAndTheRestSortByName() throws {
        let a = UUID(), b = UUID()
        let rows = try [row(host: a, id: "one", project: "zulu"), row(host: b, id: "two", project: "alpha"),
                        row(host: a, id: "three", project: "mike")]
        let names = ["zulu": "Zulu", "alpha": "Alpha", "mike": "Mike"]
        let result = SidebarModel(sessions: rows, names: { names[$0.session.projectId ?? ""] },
                                  layouts: [a: SidebarLayout(projectOrder: ["zulu"])])
        #expect(result.projects.map(\.name) == ["Zulu", "Alpha", "Mike"])
    }

    /// A MOVE GIVES BACK THE WHOLE BAND, not only the row that moved — so a row
    /// nobody had placed is placed by this gesture rather than drifting back up
    /// the next time something happens to it. `.onMove`'s `destination` counts
    /// in the list BEFORE the lift, which is what the downward case pins.
    @Test func aMoveWritesEveryRowInTheBandNotOnlyTheOneThatMoved() throws {
        let host = UUID()
        let band = try [row(host: host, id: "a", project: "p"), row(host: host, id: "b", project: "p"),
                        row(host: host, id: "c", project: "p")].map { SidebarRow(row: $0) }.drawn
        let up = try #require(SidebarModel.reordered(band, offsets: [2], to: 0))
        #expect(up.host == host)
        #expect(up.ids == ["c", "a", "b"])
        let down = try #require(SidebarModel.reordered(band, offsets: [0], to: 3))
        #expect(down.ids == ["b", "c", "a"])
    }

    /// A GESTURE THAT RESOLVED TO WHERE THE ROW ALREADY WAS COSTS NO WRITE, and
    /// neither does one the List should never have started: a child is drawn
    /// where its coordinator is, so lifting one would offer to take a row out of
    /// its own tree.
    @Test func aMoveThatChangesNothingAndAMoveOfAChildAreBothRefused() throws {
        let host = UUID()
        let coordinator = try row(host: host, id: "coord", project: "p")
        let child = try row(host: host, id: "kid", project: "p", startedFrom: "coord")
        let band = ([SidebarRow(row: coordinator, children: [SidebarChild(row: child)]),
                     SidebarRow(row: try row(host: host, id: "other", project: "p"))]).drawn
        #expect(band.map(\.isChild) == [false, true, false])
        // Index 1 is the child. The List will not lift it; nor will this.
        #expect(SidebarModel.reordered(band, offsets: [1], to: 0) == nil)
        // Dropped BETWEEN a coordinator and its child is no move at all, which
        // is exactly what it looks like on screen.
        #expect(SidebarModel.reordered(band, offsets: [2], to: 1) == nil)
        #expect(SidebarModel.reordered(band, offsets: [0], to: 0) == nil)
    }

    /// ONE MAC'S ROWS COME BACK, AND ONLY THAT MAC'S. A merged group draws two
    /// Macs' conversations and no document could hold both, so the other Mac's
    /// rows are spacers: the moved row lands where it was dropped among its own,
    /// and the other Mac's arrangement is not touched.
    @Test func aMoveInsideAMergedGroupWritesOnlyTheMovedRowsMac() throws {
        let a = UUID(), b = UUID()
        let band = try [row(host: a, id: "a1", project: "p"), row(host: b, id: "b1", project: "p"),
                        row(host: a, id: "a2", project: "p")].map { SidebarRow(row: $0) }.drawn
        let move = try #require(SidebarModel.reordered(band, offsets: [2], to: 0))
        #expect(move.host == a)
        #expect(move.ids == ["a2", "a1"])
    }

    /// ROWS THE RAIL IS NOT DRAWING KEEP THEIR SLOT — a conversation on a shelf,
    /// one filtered out, one on a Mac that is away. A move that had nothing to
    /// do with them must not prune them from the Mac's document.
    ///
    /// A SLOT IS RELATIVE TO THE STORED KEY IT FOLLOWED, which is the desktop's
    /// own rule and the only one available: an undrawn key has no position of
    /// its own once the drawn ones have moved. The two cases below are
    /// `moveProjectGroup`'s in `session-groups.test.ts`, run through this half
    /// of the same arithmetic.
    @Test func aWriteKeepsTheRowsThisPhoneCannotSee() {
        #expect(SidebarModel.keepingUnseen(["c", "a", "b"], stored: ["a", "away", "b", "quiet"])
                == ["c", "a", "away", "b", "quiet"])
        // A stored key whose every neighbour moved still lands somewhere sane —
        // after the last stored key that IS drawn before it.
        #expect(SidebarModel.keepingUnseen(["b", "a"], stored: ["x", "a", "b"]) == ["x", "b", "a"])
        #expect(SidebarModel.keepingUnseen(["a"], stored: []) == ["a"])
        // Nothing drawn is still not licence to drop what is stored.
        #expect(SidebarModel.keepingUnseen([], stored: ["x", "y"]) == ["x", "y"])
    }

    /// A COORDINATOR THAT DELEGATED TO TWO SESSIONS DRAWS BOTH UNDER IT (#333),
    /// and neither is drawn beside it — the whole of #324's shape. The scope the
    /// coordinator actually named beats the bare state, because it says WHICH
    /// work and "working" is then implied by there being any.
    @Test func delegatesAreDrawnUnderTheirCoordinatorWithTheirStateAsAHint() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "coord", project: "p"),
                        row(host: host, id: "one", project: "p"),
                        row(host: host, id: "two", project: "p")]
        let assignments: [ScopedSessionID: [SessionAssignment]] = [
            ScopedSessionID(hostId: host, sessionId: "one"): [assignment(from: "coord", scope: "the parser")],
            ScopedSessionID(hostId: host, sessionId: "two"): [assignment(from: "coord")],
        ]
        let group = try #require(SidebarModel(sessions: rows, names: { _ in "Project" }, assignments: assignments).projects.first)
        #expect(group.rows.map(\.row.session.id) == ["coord"])
        #expect(group.rows.first?.children.map(\.row.session.id) == ["one", "two"])
        #expect(group.rows.first?.children.map(\.hint) == ["the parser", "working"])
        // The count is untouched by the tree: a nested row is still a row this
        // group is showing.
        #expect(group.sessions.count == 3)
    }

    /// FINISHED IS NOT GONE. A session that completed a task stays under its
    /// coordinator until the human settles it — dropping it the moment its run
    /// ended would hide the result the delegation was for. A `detached` outcome
    /// ended nothing and is not a finish.
    @Test func aFinishedDelegateStaysUnderItsCoordinatorAndSaysSo() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "coord", project: "p"),
                        row(host: host, id: "done", project: "p"),
                        row(host: host, id: "loose", project: "p")]
        let assignments: [ScopedSessionID: [SessionAssignment]] = [
            ScopedSessionID(hostId: host, sessionId: "done"): [assignment(from: "coord", outcome: "completed")],
            ScopedSessionID(hostId: host, sessionId: "loose"): [assignment(from: "coord", outcome: "detached")],
        ]
        let tree = SidebarModel.tree(rows, assignments: assignments)
        #expect(tree.first?.children.map(\.row.session.id) == ["done"])
        #expect(tree.first?.children.map(\.hint) == ["finished"])
        #expect(tree.map(\.row.session.id) == ["coord", "loose"])
    }

    /// PROVENANCE HANGS TOO, AND HAS NO STATE TO HINT: "started from here" is a
    /// fact about the edge, and the elbow is now that fact.
    @Test func aSessionStartedFromAnotherHangsUnderItWithNoHint() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "coord", project: "p"),
                        row(host: host, id: "child", project: "p", startedFrom: "coord")]
        let tree = SidebarModel.tree(rows)
        #expect(tree.map(\.row.session.id) == ["coord"])
        #expect(tree.first?.children.map(\.row.session.id) == ["child"])
        #expect(tree.first?.children.first?.hint == nil)
    }

    /// ONE LEVEL, AND FIRST POSITION WINS. Two coordinators delegating to one
    /// session is one row under the FIRST of them, and a chain of delegations
    /// reads as a list under its head rather than a staircase down the rail.
    @Test func theTreeIsOneLevelDeepAndNeverClaimsARowTwice() throws {
        let host = UUID()
        let contested = try [row(host: host, id: "a", project: "p"), row(host: host, id: "b", project: "p"),
                             row(host: host, id: "shared", project: "p")]
        let both: [ScopedSessionID: [SessionAssignment]] = [
            ScopedSessionID(hostId: host, sessionId: "shared"): [assignment(from: "a"), assignment(from: "b")],
        ]
        let claimed = SidebarModel.tree(contested, assignments: both)
        #expect(claimed.map(\.row.session.id) == ["a", "b"])
        #expect(claimed.first?.children.map(\.row.session.id) == ["shared"])
        #expect(claimed.last?.children.isEmpty == true)

        // A chain: head → middle → tail. `middle` hangs off `head`, and `tail`
        // does NOT become a third rung under it — a child is never given a
        // child of its own, so the deeper row stays at the list's own level.
        let chain = try [row(host: host, id: "head", project: "p"),
                         row(host: host, id: "middle", project: "p", startedFrom: "head"),
                         row(host: host, id: "tail", project: "p", startedFrom: "middle")]
        let tree = SidebarModel.tree(chain)
        #expect(tree.map(\.row.session.id) == ["head", "tail"])
        #expect(tree.first?.children.map(\.row.session.id) == ["middle"])
        #expect(tree.last?.children.isEmpty == true)
    }

    /// SAME MAC ONLY. `fromSessionId` and `startedFrom` are bare ids, meaningful
    /// only inside the engine that stamped them — a coordinator on one Mac must
    /// never gather a stranger from another that happens to share an id.
    @Test func aCoordinatorNeverGathersARowFromAnotherMac() throws {
        let a = UUID(), b = UUID()
        let rows = try [row(host: a, id: "coord", project: "p"), row(host: b, id: "worker", project: "p")]
        let assignments: [ScopedSessionID: [SessionAssignment]] = [
            ScopedSessionID(hostId: b, sessionId: "worker"): [assignment(from: "coord")],
        ]
        let tree = SidebarModel.tree(rows, assignments: assignments)
        #expect(tree.map(\.row.session.id) == ["coord", "worker"])
        #expect(tree.allSatisfy { $0.children.isEmpty })
    }

    /// A ROW A PINNED CONVERSATION FOLLOWS IS DRAWN UNDER IT AND NOWHERE ELSE —
    /// the desktop's `withholdFollowedRows`. Following is a relationship you
    /// asked for; the project group is where the row lives anyway, so the
    /// coordinator keeps the copy rather than the rail claiming two
    /// conversations where there is one.
    @Test func aFollowedRowIsDrawnUnderItsPinnedCoordinatorAndNotInItsProjectGroup() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "coord", project: "p", pinned: true),
                        row(host: host, id: "watched", project: "p"),
                        row(host: host, id: "other", project: "p")]
        let following: [ScopedSessionID: [Subscription]] = [
            // Two subscriptions to one target — different events, or a `once`
            // beside a standing one — are one row, not two.
            ScopedSessionID(hostId: host, sessionId: "coord"): [subscription(to: "watched"), subscription(to: "watched")],
        ]
        let model = SidebarModel(sessions: rows, names: { _ in "Project" }, following: following)
        #expect(model.pinnedRows.map(\.row.session.id) == ["coord"])
        #expect(model.pinnedRows.first?.children.map(\.row.session.id) == ["watched"])
        #expect(model.projects.flatMap(\.sessions).map(\.session.id) == ["other"])
    }

    @Test func deepLinksRoundTripAndRejectMalformedOrForeignLinks() {
        let ref = ScopedSessionID(hostId: UUID(), sessionId: "session / ? &= ü")
        #expect(ScopedSessionID(url: ref.url) == ref)
        #expect(ScopedSessionID(url: URL(string: "https://session?host=bad&id=x")!) == nil)
        #expect(ScopedSessionID(url: URL(string: "telar://session?host=bad&id=x")!) == nil)
        #expect(ScopedSessionID(url: URL(string: "telar://session?host=\(ref.hostId)&id=")!) == nil)
    }
    @Test func unpinAndWakeEncodeNullInsteadOfOmittingFields() throws {
        let patch = SessionPatch(clearSettledOverride: true, clearSnooze: true)
        let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
        #expect(json["settledOverride"] is NSNull)
        #expect(json["snoozedUntil"] is NSNull)
        #expect(json["title"] == nil)
    }
}
