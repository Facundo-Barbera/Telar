import Foundation
import Testing
@testable import TelarMobile

@Suite struct NotebookNavigationTests {
    private let cells = ["a", "b", "c"]

    @Test func shiftReturnLandsOnTheNextCell() {
        #expect(notebookNext("a", in: cells) == "b")
        #expect(notebookNext("b", in: cells) == "c")
    }

    @Test func theLastCellStaysPutRatherThanWrapping() {
        #expect(notebookNext("c", in: cells) == nil)
    }

    @Test func aCellThatIsGoneAdvancesNowhere() {
        #expect(notebookNext("gone", in: cells) == nil)
        #expect(notebookNext("a", in: []) == nil)
    }

    @Test func movingDownIsOneIndexLater() {
        #expect(notebookMove("a", by: 1, in: cells) == 1)
        #expect(notebookMove("b", by: 1, in: cells) == 2)
    }

    @Test func movingUpIsOneIndexEarlier() {
        #expect(notebookMove("c", by: -1, in: cells) == 1)
    }

    @Test func movingToTheFrontIsIndexZero() {
        #expect(notebookMove("b", by: -1, in: cells) == 0)
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

    @Test func shortOutputIsNotClamped() {
        let text = (1...5).map(String.init).joined(separator: "\n")
        #expect(text.split(separator: "\n").count <= ClampedLines.limit)
    }

    @Test func theClampLeavesEnoughToSeeWhatHappened() {
        #expect(ClampedLines.limit == 12)
    }
}
