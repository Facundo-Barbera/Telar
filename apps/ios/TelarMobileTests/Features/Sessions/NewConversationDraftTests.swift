import Foundation
import Testing
@testable import TelarMobile

@Suite struct NewConversationDraftTests {
    private let host = UUID()
    private func target(_ id: String) -> NewConversationTarget {
        NewConversationTarget(hostId: host, hostName: "mini", project: ProjectRef(id: id, name: id))
    }

    @Test func changingProjectDropsTheBranchChoicesButKeepsTheMode() {
        var draft = NewConversationDraft(target: target("a"), envMode: "worktree", baseRef: "origin/main", branchName: "fix")
        draft.retarget(target("a"))
        #expect(draft.baseRef == "origin/main" && draft.branchName == "fix")
        draft.retarget(target("b"))
        #expect(draft.target?.project.id == "b")
        #expect(draft.baseRef == nil && draft.branchName.isEmpty && draft.envMode == "worktree")
    }

    @Test func theCheckoutHasNoBranchChoices() {
        var draft = NewConversationDraft(target: target("a"), baseRef: "origin/dev", branchName: "x")
        #expect(draft.workspaceLabel == "New worktree · x")
        draft.branchName = ""
        #expect(draft.workspaceLabel == "New worktree · dev")
        draft.setMode("local")
        #expect(draft.baseRef == nil && draft.workspaceLabel == "Current checkout")
    }

    @Test func theCreateInputCarriesModeBranchAndASeededTitle() {
        let worktree = NewConversationDraft(target: target("a"), envMode: "worktree", baseRef: "origin/main", branchName: "fix")
            .input(driver: "codex", prompt: "fix   the\nlogin", imageNames: [])
        #expect(worktree.title == "fix the login" && worktree.driver == "codex")
        #expect(worktree.envMode == "worktree" && worktree.baseRef == "origin/main" && worktree.branchName == "fix")

        let local = NewConversationDraft(target: target("a"), envMode: "local", baseRef: "origin/main", branchName: "fix")
            .input(driver: "claude", prompt: "", imageNames: ["shot.png"])
        #expect(local.title == "shot.png" && local.envMode == "local" && local.baseRef == nil && local.branchName == nil)
    }

    @Test func theLastProjectAndModeAreRemembered() throws {
        let defaults = try #require(UserDefaults(suiteName: "new-conversation-\(UUID())"))
        let memory = NewConversationMemory(defaults: defaults)
        #expect(memory.lastTarget == nil && memory.lastMode == "worktree")
        memory.remember(NewConversationDraft(target: target("a"), envMode: "local"))
        #expect(memory.lastTarget == target("a").id && memory.lastMode == "local")
    }
}
