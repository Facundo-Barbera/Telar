import Testing
@testable import TelarMobile

@Suite struct SessionActionsMenuTests {
    @Test func theHeaderNamesProjectMacAndWorkspace() {
        let worktree = SessionWorkspace(mode: "worktree", branch: "fix-login")
        #expect(SessionActionsMenu.detail(project: "Telar", host: "mini", workspace: worktree) == "Telar · mini · Worktree · fix-login")
    }

    @Test func missingPartsAreLeftOut() {
        #expect(SessionActionsMenu.detail(project: nil, host: "", workspace: SessionWorkspace(mode: "local")) == "Checkout")
        #expect(SessionActionsMenu.detail(project: "Telar", host: nil, workspace: SessionWorkspace(mode: "local", branch: "main")) == "Telar · Checkout · main")
    }

    @Test func usageReadsInThousandsOrMillions() {
        let small = UsageSnapshot(tokens: .init(input: 1500, output: 500, cacheRead: 0, cacheCreate: 0), costUsd: 0.5)
        #expect(SessionActionsMenu.usageLine(small) == "2k tokens · $0.50")
    }
}
