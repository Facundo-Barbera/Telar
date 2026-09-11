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

    @Test func movingDownFollowsTheNeighbourItSwapsWith() {
        let landing = notebookMove("a", by: 1, in: cells)
        #expect(landing?.after == "b")
        #expect(landing?.index == 1)
    }

    @Test func movingUpFollowsTheCellTwoPlacesBack() {
        // The edit says "put this after that", so moving c up past b means
        // following a — not b, which is what it is swapping with.
        let landing = notebookMove("c", by: -1, in: cells)
        #expect(landing?.after == "a")
        #expect(landing?.index == 1)
    }

    @Test func movingToTheFrontFollowsNothing() {
        let landing = notebookMove("b", by: -1, in: cells)
        #expect(landing?.after == nil)
        #expect(landing?.index == 0)
    }

    @Test func movingOffEitherEndIsNotAMove() {
        #expect(notebookMove("a", by: -1, in: cells) == nil)
        #expect(notebookMove("c", by: 1, in: cells) == nil)
    }

    @Test func movingNowhereIsNotAMove() {
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
