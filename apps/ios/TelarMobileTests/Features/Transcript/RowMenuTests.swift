import Foundation
import Testing
@testable import TelarMobile

/// What a transcript row's long press is ABOUT — each item drawn only when the
/// row carries that datum. Pinned against the web's `rowPath`/`toolOutput`,
/// because the two menus are meant to be the same menu.
@Suite struct TranscriptRowMenuTests {
    private func item(_ id: EngineID, _ detail: ItemDetail, streamed: String = "") -> JournalItem {
        let item = Item(
            id: id, runId: "r1", sessionId: "s1", status: .completed, title: nil,
            detail: detail, startedAt: 0, completedAt: 1, taskId: nil
        )
        return JournalItem(item: item, streamedText: streamed, openedBy: 1)
    }

    @Test func aCommandRowOffersItsCommandAndItsOutput() {
        let row = item("i1", .commandExecution(CommandExecutionDetail(
            command: "bun test", cwd: "/repo", exitCode: 0, outputPreview: "12 pass", durationMs: 40
        )))
        #expect(row.rowCommand == "bun test")
        #expect(row.rowBody == "12 pass")
        #expect(row.rowBodyIsPatch == false)
        // Nothing to open or reference: a command is not a file.
        #expect(row.rowPath == nil)
    }

    @Test func aFileChangeOffersItsPatchUnderThePatchWording() {
        let row = item("i2", .fileChange(FileChangeDetail(
            path: "apps/a.ts", kind: "edit", renamedFrom: nil,
            unifiedDiff: "@@ -1 +1 @@\n-a\n+b", linesAdded: 1, linesRemoved: 1
        )))
        #expect(row.rowPath == "apps/a.ts")
        #expect(row.rowBody == "@@ -1 +1 @@\n-a\n+b")
        #expect(row.rowBodyIsPatch)
        #expect(row.rowCommand == nil)
    }

    @Test func aDeletedFileStillHasAPathWorthCopying() {
        // Only "Open file in the Editor" has nothing to open on one; the path
        // and the reference are as good as any other row's.
        let row = item("i3", .fileChange(FileChangeDetail(
            path: "gone.ts", kind: "delete", renamedFrom: nil,
            unifiedDiff: nil, linesAdded: nil, linesRemoved: 1
        )))
        #expect(row.rowPath == "gone.ts")
        #expect(row.rowBody == nil)
    }

    @Test func aReadOffersOnlyItsPath() {
        let row = item("i4", .fileRead(FileReadDetail(path: "docs/panel.md", fromLine: 1, toLine: 20)))
        #expect(row.rowPath == "docs/panel.md")
        #expect(row.rowCommand == nil && row.rowBody == nil)
    }

    @Test func streamedDeltasWinWhileTheRowIsLive() {
        // The engine only folds text into the item when it closes, so a row
        // mid-stream must copy what is on screen rather than the stale preview.
        let row = item("i5", .commandExecution(CommandExecutionDetail(
            command: "tail -f log", cwd: nil, exitCode: nil, outputPreview: "old", durationMs: nil
        )), streamed: "line one\nline two")
        #expect(row.rowBody == "line one\nline two")
    }

    @Test func aRowWithNothingToSayOffersNothing() {
        let row = item("i6", .assistantMessage(text: "hello"))
        #expect(row.rowCommand == nil && row.rowBody == nil && row.rowPath == nil)
    }
}

@Suite struct TableCellValueTests {
    @Test func copyWritesTheWholeValueNotTheRenderedOne() {
        #expect(tableCellValue(.string("a long, clipped value")) == "a long, clipped value")
        // A blank cell is DRAWN as `""` so it is distinguishable from a missing
        // one; copying it must give the empty string that is actually there.
        #expect(tableCellValue(.string("")) == "")
        #expect(tableCellValue(.null) == "null")
        #expect(tableCellValue(.bool(true)) == "true")
    }

    @Test func aWholeNumberKeepsItsIntegerShape() {
        #expect(tableCellValue(.number(3)) == "3")
        #expect(tableCellValue(.number(3.5)) == "3.5")
        #expect(tableCellValue(.number(-12)) == "-12")
    }
}
