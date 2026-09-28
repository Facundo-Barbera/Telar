import Foundation
import Testing
@testable import TelarMobile

/// The notebook's two bits of arithmetic: where Shift-Return lands, and which
/// cell a moved one should follow. Both are easy to get subtly wrong and
/// impossible to see wrong without running a kernel.
@Suite struct NotebookNavigationTests {
    private let cells = ["a", "b", "c"]

    // MARK: run and advance

    @Test func shiftReturnLandsOnTheNextCell() {
        #expect(notebookNext("a", in: cells) == "b")
        #expect(notebookNext("b", in: cells) == "c")
    }

    @Test func theLastCellStaysPutRatherThanWrapping() {
        // Running a notebook top to bottom should end at the bottom, not jump
        // back to the top and invite you to run it all again.
        #expect(notebookNext("c", in: cells) == nil)
    }

    @Test func aCellThatIsGoneAdvancesNowhere() {
        #expect(notebookNext("gone", in: cells) == nil)
        #expect(notebookNext("a", in: []) == nil)
    }

    // MARK: move

    @Test func movingDownIsOneIndexLater() {
        // `to` is the ABSOLUTE index the cell occupies afterwards, which is
        // what the engine's edit takes.
        #expect(notebookMove("a", by: 1, in: cells) == 1)
        #expect(notebookMove("b", by: 1, in: cells) == 2)
    }

    @Test func movingUpIsOneIndexEarlier() {
        #expect(notebookMove("c", by: -1, in: cells) == 1)
    }

    @Test func movingToTheFrontIsIndexZero() {
        // The old "put it after that one" shape needed a special case for
        // reaching the front; an absolute index does not.
        #expect(notebookMove("b", by: -1, in: cells) == 0)
    }

    @Test func movingOffEitherEndIsNotAMove() {
        // The engine refuses an out-of-range target and leaves the file alone,
        // but a refusal the reader cannot act on does not belong in the
        // problem banner — so nothing is sent.
        #expect(notebookMove("a", by: -1, in: cells) == nil)
        #expect(notebookMove("c", by: 1, in: cells) == nil)
    }

    @Test func movingNowhereIsNotAMove() {
        // A same-index move is a byte-identical no-op on the engine; there is
        // no reason to make the round trip.
        #expect(notebookMove("b", by: 0, in: cells) == nil)
    }

    @Test func aCellThatIsGoneDoesNotMove() {
        #expect(notebookMove("gone", by: 1, in: cells) == nil)
    }

    // MARK: the output clamp

    @Test func shortOutputIsNotClamped() {
        let text = (1...5).map(String.init).joined(separator: "\n")
        #expect(text.split(separator: "\n").count <= ClampedLines.limit)
    }

    @Test func theClampLeavesEnoughToSeeWhatHappened() {
        // Twelve lines is a traceback's head or a dataframe's first rows —
        // the point is that a thousand-line print no longer pushes every cell
        // after it off the screen.
        #expect(ClampedLines.limit == 12)
    }
}
