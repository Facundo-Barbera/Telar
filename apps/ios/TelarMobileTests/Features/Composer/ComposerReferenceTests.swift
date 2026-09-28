import Foundation
import Testing
@testable import TelarMobile

@Suite struct ComposerReferenceTests {
    @Test func aFileIsItsPathInBackticks() {
        #expect(ComposerReference.file("apps/web/src/lib/auth.ts") == "`apps/web/src/lib/auth.ts`")
        #expect(ComposerReference.file("README.md") == "`README.md`")
    }

    @Test func aDirectoryKeepsExactlyOneTrailingSlash() {
        #expect(ComposerReference.directory("apps/engine") == "`apps/engine/`")
        #expect(ComposerReference.directory("apps/engine/") == "`apps/engine/`")
        #expect(ComposerReference.directory("apps/engine///") == "`apps/engine/`")
    }

    @Test func insertingSpacesTheWayAPersonWouldHaveTyped() {
        #expect(ComposerReference.insert("`a.ts`", into: "") == "`a.ts` ")
        #expect(ComposerReference.insert("`a.ts`", into: "fix") == "fix `a.ts` ")
        #expect(ComposerReference.insert("`a.ts`", into: "fix ") == "fix `a.ts` ")
        #expect(ComposerReference.insert("`a.ts`", into: "fix\n") == "fix\n`a.ts` ")
    }

    @Test func insertsStack() {
        var draft = ""
        draft = ComposerReference.insert(ComposerReference.file("a.ts"), into: draft)
        draft = ComposerReference.insert(ComposerReference.file("b.ts"), into: draft)
        #expect(draft == "`a.ts` `b.ts` ")
    }
}

@Suite struct WorkspacePathTests {
    @Test func joinsTheCheckoutRootToARelativePath() {
        #expect(workspaceFilePath("/Users/x/repo", "apps/a.ts") == "/Users/x/repo/apps/a.ts")
        #expect(workspaceFilePath("/Users/x/repo/", "/apps/a.ts") == "/Users/x/repo/apps/a.ts")
    }

    @Test func withoutARootThereIsNoAbsolutePath() {
        #expect(workspaceFilePath(nil, "apps/a.ts") == nil)
        #expect(workspaceFilePath("", "apps/a.ts") == nil)
        #expect(workspaceFilePath("/Users/x/repo", "") == nil)
    }
}
