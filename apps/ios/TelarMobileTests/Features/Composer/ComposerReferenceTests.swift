import Foundation
import Testing
@testable import TelarMobile

/// The reference text every "Insert as a reference" row writes, and how it
/// lands in a draft. Pinned against the web's `drag-reference.ts`, which is
/// the format the agent on the other end was trained on.
@Suite struct ComposerReferenceTests {
    @Test func aFileIsItsPathInBackticks() {
        #expect(ComposerReference.file("apps/web/lib/auth.ts") == "`apps/web/lib/auth.ts`")
        #expect(ComposerReference.file("README.md") == "`README.md`")
    }

    @Test func aDirectoryKeepsExactlyOneTrailingSlash() {
        #expect(ComposerReference.directory("apps/engine") == "`apps/engine/`")
        #expect(ComposerReference.directory("apps/engine/") == "`apps/engine/`")
        #expect(ComposerReference.directory("apps/engine///") == "`apps/engine/`")
    }

    @Test func insertingSpacesTheWayAPersonWouldHaveTyped() {
        // An empty box takes no lead, and every insert leaves room after it.
        #expect(ComposerReference.insert("`a.ts`", into: "") == "`a.ts` ")
        // A word before it is not welded to it…
        #expect(ComposerReference.insert("`a.ts`", into: "fix") == "fix `a.ts` ")
        // …and a space already there is not doubled.
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
        // Slashes on either side collapse to exactly one.
        #expect(workspaceFilePath("/Users/x/repo/", "/apps/a.ts") == "/Users/x/repo/apps/a.ts")
    }

    @Test func withoutARootThereIsNoAbsolutePath() {
        // Which is what HIDES "Copy path" rather than copying a relative path
        // under an absolute label.
        #expect(workspaceFilePath(nil, "apps/a.ts") == nil)
        #expect(workspaceFilePath("", "apps/a.ts") == nil)
        #expect(workspaceFilePath("/Users/x/repo", "") == nil)
    }
}
