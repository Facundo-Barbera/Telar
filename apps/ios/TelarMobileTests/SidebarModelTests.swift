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
