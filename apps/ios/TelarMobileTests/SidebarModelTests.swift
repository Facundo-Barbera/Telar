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
        let result = SidebarModel(sessions: rows, names: { $0.session.projectId }, orders: [a: ["beta", "alpha"]])
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
