import Foundation
import Testing
@testable import TelarMobile

@Suite struct ReadReceiptRuleTests {
    private let open = ReceiptGate(foreground: true, atLatestResult: true, loading: false)
    private func turn(_ sequence: Int, _ state: TurnState = .completed) -> ReceiptTurn {
        ReceiptTurn(runId: "run_\(sequence)", state: state, sequence: sequence)
    }

    @Test func anAnswerOnScreenInAnActiveSceneIsConfirmed() {
        #expect(receiptToSend(candidate: turn(5), readSequence: nil, confirmedSequence: nil, gate: open) == turn(5))
        #expect(receiptToSend(candidate: turn(6), readSequence: 5, confirmedSequence: nil, gate: open) == turn(6))
    }

    @Test func everyHalfOfTheGateCanRefuseOnItsOwn() {
        #expect(receiptToSend(candidate: turn(5), readSequence: nil, confirmedSequence: nil,
                              gate: ReceiptGate(foreground: false, atLatestResult: true, loading: false)) == nil)
        #expect(receiptToSend(candidate: turn(5), readSequence: nil, confirmedSequence: nil,
                              gate: ReceiptGate(foreground: true, atLatestResult: false, loading: false)) == nil)
        #expect(receiptToSend(candidate: turn(5), readSequence: nil, confirmedSequence: nil,
                              gate: ReceiptGate(foreground: true, atLatestResult: true, loading: true)) == nil)
    }

    @Test func aSessionWithNoAnswerYetConfirmsNothing() {
        #expect(receiptToSend(candidate: nil, readSequence: nil, confirmedSequence: nil, gate: open) == nil)
    }

    @Test func anAlreadyReadAnswerIsNotReConfirmed() {
        #expect(receiptToSend(candidate: turn(5), readSequence: 5, confirmedSequence: nil, gate: open) == nil)
        #expect(receiptToSend(candidate: turn(5), readSequence: 9, confirmedSequence: nil, gate: open) == nil)
        #expect(receiptToSend(candidate: turn(5), readSequence: nil, confirmedSequence: 5, gate: open) == nil)
        #expect(receiptToSend(candidate: turn(6), readSequence: 5, confirmedSequence: 2, gate: open) == turn(6))
        #expect(receiptToSend(candidate: turn(6), readSequence: 2, confirmedSequence: 6, gate: open) == nil)
    }

    @Test func onlyTurnsThatLEFTAnAnswerAreCandidates() {
        #expect(isResultTurn(.completed) && isResultTurn(.failed) && isResultTurn(.stopped))
        for state: TurnState in [.queued, .claimed, .running, .steering, .steered, .discarded, .ambiguous, .unknown] {
            #expect(!isResultTurn(state))
        }
    }

    @Test func theNewestAnswerIsFoundBySequenceNotByPosition() {
        let turns = [turn(9), turn(3), turn(7)]
        #expect(newestResultTurn(turns) == turn(9))
        #expect(newestResultTurn([turn(4), turn(5, .running)]) == turn(4))
        #expect(newestResultTurn([turn(5, .running)]) == nil)
        #expect(newestResultTurn([]) == nil)
        #expect(newestResultTurn([turn(4), turn(5, .failed)]) == turn(5, .failed))
    }

    @Test func theRetryBudgetBacksOffAndStops() {
        #expect(receiptRetryDelayMs(attempt: 1) == 1_000)
        #expect(receiptRetryDelayMs(attempt: 2) == 2_000)
        #expect(receiptRetryDelayMs(attempt: 4) == 8_000)
        #expect(receiptRetryDelayMs(attempt: 40) == 8_000)
        #expect(receiptMaxAttempts == 3)
    }
}

@Suite struct ReadMarkFoldTests {
    private func mark(_ sequence: Int?, _ readAt: Timestamp? = nil) -> ReadMark {
        ReadMark(sequence: sequence, readAt: readAt)
    }

    @Test func aHigherAnswerMovesBothFields() {
        #expect(advancedReadMark(mark(4, 100), mark(5, 200)) == mark(5, 200))
        #expect(advancedReadMark(mark(nil, nil), mark(1, 200)) == mark(1, 200))
    }

    @Test func aLowerOrEqualAnswerLeavesTheRowAlone() {
        #expect(advancedReadMark(mark(5, 100), mark(5, 999)) == nil)
        #expect(advancedReadMark(mark(6, 100), mark(5, 999)) == nil)
        #expect(advancedReadMark(mark(6, 100), mark(nil, 999)) == nil)
    }

    @Test func anAnswerWithNoStampKeepsTheOneAlreadyThere() {
        #expect(advancedReadMark(mark(4, 100), mark(5, nil)) == mark(5, 100))
    }

    @Test func theSessionHelperReportsWhetherAnythingMoved() {
        var session = try! JSONDecoder().decode(Session.self, from: Data(#"""
        {"id":"s","title":"T","createdAt":1,"updatedAt":1000,"driver":"claude",
         "workspace":{"mode":"local","path":"/x"},"runtimeMode":"auto","detached":false,
         "activity":"idle","lastTurnSequence":7,"lastReadTurnSequence":4,"readAt":100}
        """#.utf8))
        #expect(Settling.showsUnreadMark(session))
        let refused = session.applyReadMark(mark(4, 900))
        #expect(!refused)
        #expect(session.readAt == 100)
        let moved = session.applyReadMark(mark(7, 900))
        #expect(moved)
        #expect(session.lastReadTurnSequence == 7)
        #expect(session.readAt == 900)
        #expect(!Settling.showsUnreadMark(session))
    }

    @Test func theInboxFoldTouchesOneRowInWhicheverBandHoldsIt() {
        func row(_ id: String, _ read: Int) -> Session {
            try! JSONDecoder().decode(Session.self, from: Data("""
            {"id":"\(id)","title":"T","createdAt":1,"updatedAt":1000,"driver":"claude",
             "workspace":{"mode":"local","path":"/x"},"runtimeMode":"auto","detached":false,
             "activity":"idle","lastTurnSequence":9,"lastReadTurnSequence":\(read)}
            """.utf8))
        }
        var sections = InboxSections()
        sections.active = [row("a", 1), row("b", 1)]
        sections.settled = [row("c", 1)]
        let folded = applyReadMark(sections, sessionId: "c", answer: mark(9, 500))
        #expect(folded.active.map(\.lastReadTurnSequence) == [1, 1])
        #expect(folded.settled.map(\.lastReadTurnSequence) == [9])
        #expect(folded.settled.count == 1 && folded.active.count == 2)
        #expect(applyReadMark(sections, sessionId: "zz", answer: mark(9, 500)) == sections)
    }
}
