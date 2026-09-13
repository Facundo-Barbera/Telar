import Foundation
import Testing
@testable import TelarMobile

@Suite struct SidebarModelTests {
    private func row(host: UUID, id: String, project: String, activity: String = "working", pinned: Bool = false) throws -> HostedSession {
        let object: [String: Any] = ["id": id, "projectId": project, "title": id, "createdAt": 1000, "updatedAt": 1000,
            "activity": activity, "settledOverride": pinned ? "active" : NSNull(), "driver": "claude", "workspace": ["mode": "local", "path": "/tmp"]]
        return HostedSession(hostId: host, session: try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: object)))
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

    /// A DROP PUTS THE ROW ABOVE THE ONE IT LANDED ON, and gives back the WHOLE
    /// drawn list — so a row nobody had placed is placed by this drop rather
    /// than drifting back up the next time something happens to it.
    @Test func aDropPlacesEveryDrawnRowNotOnlyTheOneThatMoved() {
        #expect(SidebarModel.moved(["a", "b", "c"], dragged: "c", target: "a") == ["c", "a", "b"])
        #expect(SidebarModel.moved(["a", "b", "c"], dragged: "a", target: "c") == ["b", "a", "c"])
    }

    /// A DROP THAT NAMES NOTHING IN THIS BAND CHANGES NOTHING. The move is
    /// handed one band's drawn keys, so a row dropped on another group's row
    /// finds no anchor and the order comes back untouched — which is what keeps
    /// "move a conversation between projects" a different verb.
    @Test func aRowFromAnotherBandLeavesTheOrderAlone() {
        #expect(SidebarModel.moved(["a", "b"], dragged: "elsewhere", target: "a") == ["a", "b"])
        #expect(SidebarModel.moved(["a", "b"], dragged: "a", target: "elsewhere") == ["a", "b"])
        #expect(SidebarModel.moved(["a", "b"], dragged: "a", target: "a") == ["a", "b"])
    }

    /// ROWS THE RAIL IS NOT DRAWING KEEP THEIR SLOT — a conversation on a shelf,
    /// one filtered out, one on a Mac that is away. A drag that had nothing to
    /// do with them must not prune them from the Mac's document.
    @Test func aWriteKeepsTheRowsThisPhoneCannotSee() {
        // `hidden` sat between b and c and stays there; `tail` was last and stays last.
        #expect(SidebarModel.keepingUnseen(["c", "a", "b"], stored: ["a", "b", "hidden", "c", "tail"])
                == ["c", "a", "b", "hidden", "tail"])
        #expect(SidebarModel.keepingUnseen(["a"], stored: []) == ["a"])
        // Nothing drawn is still not licence to drop what is stored.
        #expect(SidebarModel.keepingUnseen([], stored: ["x", "y"]) == ["x", "y"])
    }

    /// A ROW'S DRAG CARRIES ITS BAND AND ITS MAC, and cannot be read as a
    /// group's: a row carried over a project header must not look like a group
    /// being dropped there.
    @Test func aRowDragNamesItsBandAndSurvivesARoundTrip() throws {
        let host = UUID()
        let ref = ScopedSessionID(hostId: host, sessionId: "session_1")
        let payload = SidebarModel.rowDragPayload(scope: "repo:github.com/owner/repo", row: ref)
        let read = try #require(SidebarModel.rowDrag(payload))
        #expect(read.scope == "repo:github.com/owner/repo")
        #expect(read.row == ref)
        // A group's own drag payload is its key, which is not one of these.
        #expect(SidebarModel.rowDrag("repo:github.com/owner/repo") == nil)
        #expect(SidebarModel.rowDrag("\(host.uuidString):project_1") == nil)
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
