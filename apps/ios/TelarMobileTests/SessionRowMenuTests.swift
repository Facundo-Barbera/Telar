import Foundation
import Testing
@testable import TelarMobile

/// THE PHONE'S MENU AGAINST THE MAC'S, in the one form the two can be compared
/// in: a list of ids and labels. `apps/web/lib/session-action-menu.ts` is the
/// list this is checked against — see #326 for the four verbs the phone was
/// missing and the three the two surfaces are allowed to differ on.
@Suite struct SessionRowMenuTests {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)
    private var stamp: Timestamp { Timestamp(now.timeIntervalSince1970 * 1000) }

    private func session(
        id: String = "s1",
        project: String? = "p1",
        title: String = "Wire the picker",
        activity: String = "idle",
        branch: String? = nil,
        pinned: Bool = false,
        archived: Bool = false,
        snoozedUntil: Timestamp? = nil
    ) throws -> Session {
        var workspace: [String: Any] = ["mode": branch == nil ? "local" : "worktree", "path": "/Users/me/code/telar"]
        if let branch { workspace["branch"] = branch }
        var object: [String: Any] = [
            "id": id, "title": title, "createdAt": 1000, "updatedAt": 1000,
            "activity": activity, "driver": "claude", "workspace": workspace,
            "state": archived ? "archived" : "active",
        ]
        if let project { object["projectId"] = project }
        if pinned { object["settledOverride"] = "active" }
        if let snoozedUntil {
            object["snoozedUntil"] = snoozedUntil
            object["snoozedAt"] = stamp
        }
        return try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func items(_ session: Session, projectName: String? = "Telar", settled: Bool = false, link: Bool = true) -> [SessionMenuItem] {
        SessionRowMenu.items(
            session: session, projectName: projectName, settled: settled,
            cockpitURL: link ? URL(string: "http://mini.local:3000/projects/p1/sessions/s1") : nil,
            now: now
        )
    }

    @Test func theOrderAndTheLabelsAreTheMacs() throws {
        let menu = items(try session())
        #expect(menu.map(\.id) == ["new-session", "pin", "settle", "snooze", "rename", "copy", "delete"])
        #expect(menu.map(\.label) == [
            "New session in Telar", "Pin to the list", "Settle", "Snooze", "Rename", "Copy", "Delete session",
        ])
        // Only the last row is destructive, so the eye lands on it last.
        #expect(menu.filter(\.destructive).map(\.id) == ["delete"])
        #expect(menu.allSatisfy { $0.disabled == nil })
    }

    @Test func newSessionNamesTheBranchAndIsCutFromIt() throws {
        let worktree = try session(branch: "telar/ios-menus")
        let item = try #require(items(worktree).first { $0.id == "new-session" })
        #expect(item.label == "New session on telar/ios-menus")
        #expect(item.verb == .newSession(projectId: "p1", baseRef: "telar/ios-menus"))

        // A local session runs on the project's own checkout, so it has no
        // branch of its own to attribute the sibling to.
        let local = try #require(items(try session()).first { $0.id == "new-session" })
        #expect(local.verb == .newSession(projectId: "p1", baseRef: nil))
    }

    @Test func aSessionWithNoProjectCannotSpawnASibling() throws {
        // The rail has no name for a session that belongs to no project, and
        // "this project" is the Mac's own fallback for exactly that.
        let item = try #require(items(try session(project: nil), projectName: nil).first { $0.id == "new-session" })
        #expect(item.label == "New session in this project")
        #expect(item.disabled == SessionRowMenu.noProject)
        #expect(item.verb == nil)
    }

    @Test func copyHoldsLinkPathBranchAndIdInThatOrder() throws {
        let worktree = try session(branch: "telar/ios-menus")
        let copy = try #require(items(worktree).first { $0.id == "copy" })
        #expect(copy.children?.map(\.label) == ["Link", "Path", "Branch", "Session ID"])
        #expect(copy.children?.map(\.verb) == [
            .copy("http://mini.local:3000/projects/p1/sessions/s1"),
            .copy("/Users/me/code/telar"),
            .copy("telar/ios-menus"),
            .copy("s1"),
        ])
    }

    @Test func branchIsOnlyAWorktreeSessionsAndTheLinkNeedsAnAddress() throws {
        let local = try #require(items(try session()).first { $0.id == "copy" })
        #expect(local.children?.map(\.label) == ["Link", "Path", "Session ID"])
        // No cockpit address for that Mac: a relative link is not a link, so
        // the row is absent rather than copying a path under the wrong name.
        let unreachable = try #require(items(try session(), link: false).first { $0.id == "copy" })
        #expect(unreachable.children?.map(\.label) == ["Path", "Session ID"])
    }

    @Test func togglesSwapInPlaceRatherThanShowingBothHalves() throws {
        let pinned = items(try session(pinned: true))
        #expect(pinned.first { $0.id == "pin" }?.label == "Unpin")
        #expect(pinned.first { $0.id == "pin" }?.verb == .pin(false))

        let settled = items(try session(), settled: true)
        #expect(settled.first { $0.id == "settle" }?.label == "Un-settle")
        #expect(settled.first { $0.id == "settle" }?.verb == .settle(false))
        // Coming back from settled is never refused — the gate is about
        // shelving a session somebody still needs.
        #expect(items(try session(activity: "working"), settled: true).first { $0.id == "settle" }?.disabled == nil)
    }

    @Test func aSnoozedRowOffersTheWakeAndSaysHowLongIsLeft() throws {
        let snoozed = try session(snoozedUntil: stamp + 2 * 3_600_000)
        let item = try #require(items(snoozed).first { $0.id == "snooze" })
        #expect(item.label == "Wake now")
        #expect(item.detail == "2h")
        #expect(item.verb == .snooze(nil))
        #expect(item.children == nil)
    }

    @Test func theSnoozeSubmenuCarriesThePresetsResolvedAgainstOneClock() throws {
        let item = try #require(items(try session()).first { $0.id == "snooze" })
        let presets = snoozePresets(now: now)
        #expect(item.children?.map(\.label) == presets.map(\.label))
        #expect(item.children?.compactMap(\.detail) == presets.map(\.when))
        #expect(item.children?.first?.verb == .snooze(presets.first?.until))
    }

    @Test func refusalsNameWhatToGoAndDo() throws {
        let blocked = items(try session(activity: "blocked"))
        #expect(blocked.first { $0.id == "settle" }?.disabled == SessionRowMenu.waiting)
        #expect(blocked.first { $0.id == "snooze" }?.disabled == SessionRowMenu.waiting)
        #expect(blocked.first { $0.id == "delete" }?.disabled == SessionRowMenu.waitingDelete)

        // A RUNNING SESSION IS SNOOZABLE and a blocked one is not — snoozing
        // only changes what you are shown, and hiding a question defeats it.
        let working = items(try session(activity: "working"))
        #expect(working.first { $0.id == "settle" }?.disabled == SessionRowMenu.running)
        #expect(working.first { $0.id == "snooze" }?.disabled == nil)
        #expect(working.first { $0.id == "delete" }?.disabled == SessionRowMenu.runningDelete)
    }

    @Test func theInboxVerbsAreAbsentOnAnArchivedSession() throws {
        let menu = items(try session(archived: true))
        #expect(menu.map(\.id) == ["new-session", "rename", "copy", "delete"])
        #expect(menu.first { $0.id == "rename" }?.disabled == SessionRowMenu.archived)
    }

    @Test func theWakeCountdownRoundsUpAndBottomsOutAtNow() {
        #expect(SessionRowMenu.wakeLabel(0, now: 1000) == "now")
        #expect(SessionRowMenu.wakeLabel(30_000, now: 0) == "1m")
        #expect(SessionRowMenu.wakeLabel(90_000, now: 0) == "2m")
        #expect(SessionRowMenu.wakeLabel(3_600_000 + 1, now: 0) == "2h")
        #expect(SessionRowMenu.wakeLabel(86_400_000 * 2, now: 0) == "2d")
    }
}
