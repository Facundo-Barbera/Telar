import Foundation
import Testing
@testable import TelarMobile

@Suite struct SidebarModelTests {
    private func row(host: UUID, id: String, project: String?, activity: String = "working", pinned: Bool = false, startedFrom: String? = nil, createdAt: Int = 1000, updatedAt: Int = 1000) throws -> HostedSession {
        var object: [String: Any] = ["id": id, "projectId": project ?? NSNull(), "title": id, "createdAt": createdAt, "updatedAt": updatedAt,
            "activity": activity, "settledOverride": pinned ? "active" : NSNull(), "driver": "claude", "workspace": ["mode": "local", "path": "/tmp"]]
        if let startedFrom { object["startedFrom"] = ["sessionId": startedFrom] }
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
    @Test func projectlessRowsAreNeverGrouped() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "loose", project: nil), row(host: host, id: "blank", project: ""), row(host: host, id: "kept", project: "p")]
        let result = SidebarModel(sessions: rows, names: { $0.session.projectId })
        #expect(result.projects.map(\.projectId) == ["p"])
    }

    @Test func unplacedGroupsWithOneNameSortByTheirMac() throws {
        let studio = UUID(), mini = UUID()
        let rows = try [row(host: studio, id: "a", project: "p1"), row(host: mini, id: "b", project: "p2")]
        let names = [studio: "Studio", mini: "mini"]
        let result = SidebarModel(sessions: rows, names: { _ in "Telar" }, hostNames: { names[$0] })
        #expect(result.projects.map(\.hostId) == [mini, studio])
    }

    @Test func groupRowsAreNewestCreatedFirstWithStableTies() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "b", project: "p"), row(host: host, id: "old", project: "p", createdAt: 10),
                        row(host: host, id: "a", project: "p"), row(host: host, id: "touched", project: "p", updatedAt: 5000)]
        let merged = mergeInbox([(host, InboxSections(active: rows.map(\.session)))], filter: nil)
        #expect(merged.active.map(\.session.id) == ["touched", "a", "b", "old"])
    }

    @Test func respectsProjectOrderAndKeepsSameProjectOnDifferentMacsSeparate() throws {
        let a = UUID(), b = UUID()
        let rows = try [row(host: a, id: "a", project: "alpha"), row(host: a, id: "b", project: "beta"), row(host: b, id: "a", project: "alpha")]
        let result = SidebarModel(sessions: rows, names: { $0.session.projectId }, layouts: [a: SidebarLayout(projectOrder: ["beta", "alpha"])])
        #expect(result.projects.count == 3)
        #expect(result.projects.filter { $0.hostId == a }.map(\.projectId) == ["beta", "alpha"])
    }

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

    @Test func aProjectWithNothingLeftToShowDoesNotRenderAHeader() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "blocked", project: "p", activity: "blocked"),
                        row(host: host, id: "pinned", project: "p", pinned: true)]
        let result = SidebarModel(sessions: rows, names: { _ in "Project" })
        #expect(result.projects.isEmpty)
    }

    @Test func honoursSessionOrderInsideAGroupAndLeavesUnplacedRowsWhereTheyWere() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "a", project: "p"), row(host: host, id: "b", project: "p"), row(host: host, id: "c", project: "p")]
        let layouts = [host: SidebarLayout(sessionOrder: ["p": ["c", "a"]])]
        let group = try #require(SidebarModel(sessions: rows, names: { _ in "Project" }, layouts: layouts).projects.first)
        #expect(group.sessions.map(\.session.id) == ["c", "a", "b"])
    }

    @Test func honoursPinnedOrder() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "a", project: "p", pinned: true),
                        row(host: host, id: "b", project: "p", pinned: true),
                        row(host: host, id: "c", project: "p", pinned: true)]
        let layouts = [host: SidebarLayout(pinnedOrder: ["c", "b"])]
        #expect(SidebarModel(sessions: rows, names: { _ in "Project" }, layouts: layouts).pinned.map(\.session.id) == ["c", "b", "a"])
    }

    @Test func aRankFromOneMacNeverPlacesAnotherMacsRow() throws {
        let a = UUID(), b = UUID()
        let rows = try [row(host: a, id: "shared", project: "p", pinned: true), row(host: b, id: "shared", project: "p", pinned: true)]
        let pinned = SidebarModel(sessions: rows, names: { _ in "Project" }, layouts: [a: SidebarLayout(pinnedOrder: ["shared"])]).pinned
        #expect(pinned.count == 2)

        #expect(pinned.map(\.hostId) == [a, b])
    }

    @Test func noArrangementLeavesTheRecencyOrderAlone() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "a", project: "p"), row(host: host, id: "b", project: "p")]
        let layouts = [host: SidebarLayout(projectOrder: ["p"])]
        let group = try #require(SidebarModel(sessions: rows, names: { _ in "Project" }, layouts: layouts).projects.first)
        #expect(group.sessions.map(\.session.id) == ["a", "b"])
    }

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

        #expect(group.places.map(\.hostId) == [a, b])
        #expect(group.places.map(\.projectId) == ["project_here", "project_there"])
    }

    @Test func projectsWithNoRepositoryStayOneGroupPerMac() throws {
        let a = UUID(), b = UUID()
        let rows = try [row(host: a, id: "one", project: "scratch"), row(host: b, id: "two", project: "scratch")]
        let result = SidebarModel(sessions: rows, names: { _ in "scratch" })
        #expect(result.projects.count == 2)
        #expect(Set(result.projects.map(\.id)) == ["\(a.uuidString):scratch", "\(b.uuidString):scratch"])
    }

    @Test func twoRepositoriesAreTwoGroupsHoweverTheyAreNamed() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "one", project: "p1"), row(host: host, id: "two", project: "p2")]
        let remotes = ["p1": "github.com/owner/repo", "p2": "github.com/owner/other"]
        let result = SidebarModel(sessions: rows, names: { _ in "Telar" }, remotes: { remotes[$0.session.projectId ?? ""] })
        #expect(result.projects.count == 2)
    }

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

        #expect(group.sessions.map(\.session.id) == ["a2", "a1", "b1"])
    }

    @Test func placedGroupsComeFirstAndTheRestSortByName() throws {
        let a = UUID(), b = UUID()
        let rows = try [row(host: a, id: "one", project: "zulu"), row(host: b, id: "two", project: "alpha"),
                        row(host: a, id: "three", project: "mike")]
        let names = ["zulu": "Zulu", "alpha": "Alpha", "mike": "Mike"]
        let result = SidebarModel(sessions: rows, names: { names[$0.session.projectId ?? ""] },
                                  layouts: [a: SidebarLayout(projectOrder: ["zulu"])])
        #expect(result.projects.map(\.name) == ["Zulu", "Alpha", "Mike"])
    }

    @Test func aMoveWritesEveryRowInTheBandNotOnlyTheOneThatMoved() throws {
        let host = UUID()
        let band = try [row(host: host, id: "a", project: "p"), row(host: host, id: "b", project: "p"),
                        row(host: host, id: "c", project: "p")]
        let up = try #require(SidebarModel.reordered(band, offsets: [2], to: 0))
        #expect(up.host == host)
        #expect(up.ids == ["c", "a", "b"])
        let down = try #require(SidebarModel.reordered(band, offsets: [0], to: 3))
        #expect(down.ids == ["b", "c", "a"])
    }

    @Test func aMoveThatChangesNothingIsRefusedAndADelegateMovesLikeAnyRow() throws {
        let host = UUID()
        let band = try [row(host: host, id: "coord", project: "p"),
                        row(host: host, id: "kid", project: "p", startedFrom: "coord"),
                        row(host: host, id: "other", project: "p")]
        #expect(SidebarModel.reordered(band, offsets: [0], to: 0) == nil)
        #expect(SidebarModel.reordered(band, offsets: [1], to: 1) == nil)

        let moved = try #require(SidebarModel.reordered(band, offsets: [1], to: 0))
        #expect(moved.ids == ["kid", "coord", "other"])
    }

    @Test func aMoveInsideAMergedGroupWritesOnlyTheMovedRowsMac() throws {
        let a = UUID(), b = UUID()
        let band = try [row(host: a, id: "a1", project: "p"), row(host: b, id: "b1", project: "p"),
                        row(host: a, id: "a2", project: "p")]
        let move = try #require(SidebarModel.reordered(band, offsets: [2], to: 0))
        #expect(move.host == a)
        #expect(move.ids == ["a2", "a1"])
    }

    @Test func aWriteKeepsTheRowsThisPhoneCannotSee() {
        #expect(SidebarModel.keepingUnseen(["c", "a", "b"], stored: ["a", "away", "b", "quiet"])
                == ["c", "a", "away", "b", "quiet"])

        #expect(SidebarModel.keepingUnseen(["b", "a"], stored: ["x", "a", "b"]) == ["x", "b", "a"])
        #expect(SidebarModel.keepingUnseen(["a"], stored: []) == ["a"])

        #expect(SidebarModel.keepingUnseen([], stored: ["x", "y"]) == ["x", "y"])
    }

    @Test func everyRelatedConversationIsARowOfItsOwnGroup() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "coord", project: "p"),
                        row(host: host, id: "assigned", project: "p"),
                        row(host: host, id: "done", project: "p"),
                        row(host: host, id: "started", project: "p", startedFrom: "coord")]
        let group = try #require(SidebarModel(sessions: rows, names: { _ in "Project" }).projects.first)
        #expect(group.sessions.map(\.session.id) == ["coord", "assigned", "done", "started"])
    }

    @Test func aFollowedRowIsNotWithheldFromItsProjectGroup() throws {
        let host = UUID()
        let rows = try [row(host: host, id: "coord", project: "p", pinned: true),
                        row(host: host, id: "watched", project: "p"),
                        row(host: host, id: "other", project: "p")]
        let model = SidebarModel(sessions: rows, names: { _ in "Project" })
        #expect(model.pinned.map(\.session.id) == ["coord"])
        #expect(model.projects.flatMap(\.sessions).map(\.session.id) == ["watched", "other"])
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
