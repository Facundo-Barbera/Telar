import Foundation
import Testing
@testable import TelarMobile

/// The "should this render confirm anything" rule, on the cases the web's
/// session-read-receipt.test.ts pins. Every one of these is a way to claim a
/// human saw an answer they did not.
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
        // Backgrounded, in the switcher, or under a locked screen.
        #expect(receiptToSend(candidate: turn(5), readSequence: nil, confirmedSequence: nil,
                              gate: ReceiptGate(foreground: false, atLatestResult: true, loading: false)) == nil)
        // Scrolled up, re-reading an older answer.
        #expect(receiptToSend(candidate: turn(5), readSequence: nil, confirmedSequence: nil,
                              gate: ReceiptGate(foreground: true, atLatestResult: false, loading: false)) == nil)
        // Mid-hydrate, or showing a cached photograph of an absent Mac.
        #expect(receiptToSend(candidate: turn(5), readSequence: nil, confirmedSequence: nil,
                              gate: ReceiptGate(foreground: true, atLatestResult: true, loading: true)) == nil)
    }

    @Test func aSessionWithNoAnswerYetConfirmsNothing() {
        #expect(receiptToSend(candidate: nil, readSequence: nil, confirmedSequence: nil, gate: open) == nil)
    }

    @Test func anAlreadyReadAnswerIsNotReConfirmed() {
        // The engine's own high-water mark…
        #expect(receiptToSend(candidate: turn(5), readSequence: 5, confirmedSequence: nil, gate: open) == nil)
        #expect(receiptToSend(candidate: turn(5), readSequence: 9, confirmedSequence: nil, gate: open) == nil)
        // …and the local one, which is what stops a re-render sending a second
        // copy during the round trip the first one is still making.
        #expect(receiptToSend(candidate: turn(5), readSequence: nil, confirmedSequence: 5, gate: open) == nil)
        // The higher of the two wins, in both directions.
        #expect(receiptToSend(candidate: turn(6), readSequence: 5, confirmedSequence: 2, gate: open) == turn(6))
        #expect(receiptToSend(candidate: turn(6), readSequence: 2, confirmedSequence: 6, gate: open) == nil)
    }

    @Test func onlyTurnsThatLEFTAnAnswerAreCandidates() {
        // The engine refuses a receipt for anything else, so the client must
        // never name one: steering words on their way into a running turn, a
        // dismissed recovery, and a question for a human are not answers.
        #expect(isResultTurn(.completed) && isResultTurn(.failed) && isResultTurn(.stopped))
        for state: TurnState in [.queued, .claimed, .running, .steering, .steered, .discarded, .ambiguous, .unknown] {
            #expect(!isResultTurn(state))
        }
    }

    @Test func theNewestAnswerIsFoundBySequenceNotByPosition() {
        // A transcript is not always in sequence order — a page of older turns
        // merges in above, and a failed turn can sit after a completed one.
        let turns = [turn(9), turn(3), turn(7)]
        #expect(newestResultTurn(turns) == turn(9))
        // A running turn below the newest answer does not become the candidate,
        // which is the case that would otherwise confirm an answer that does
        // not exist yet.
        #expect(newestResultTurn([turn(4), turn(5, .running)]) == turn(4))
        #expect(newestResultTurn([turn(5, .running)]) == nil)
        #expect(newestResultTurn([]) == nil)
        // A failure IS an answer — you read it the same way.
        #expect(newestResultTurn([turn(4), turn(5, .failed)]) == turn(5, .failed))
    }

    @Test func theRetryBudgetBacksOffAndStops() {
        #expect(receiptRetryDelayMs(attempt: 1) == 1_000)
        #expect(receiptRetryDelayMs(attempt: 2) == 2_000)
        #expect(receiptRetryDelayMs(attempt: 4) == 8_000)
        // Capped: a phone off the tailnet is not worth an unbounded wait.
        #expect(receiptRetryDelayMs(attempt: 40) == 8_000)
        #expect(receiptMaxAttempts == 3)
    }
}

/// The fold that puts a receipt's answer back into a surface that is already
/// holding a session — the transcript's own copy and, since the dot outlived
/// the read on the iPad, the sidebar's row too.
@Suite struct ReadMarkFoldTests {
    private func mark(_ sequence: Int?, _ readAt: Timestamp? = nil) -> ReadMark {
        ReadMark(sequence: sequence, readAt: readAt)
    }

    @Test func aHigherAnswerMovesBothFields() {
        #expect(advancedReadMark(mark(4, 100), mark(5, 200)) == mark(5, 200))
        // Nothing read yet is the same question with a zero on one side.
        #expect(advancedReadMark(mark(nil, nil), mark(1, 200)) == mark(1, 200))
    }

    @Test func aLowerOrEqualAnswerLeavesTheRowAlone() {
        // The stamp belongs to the sequence it arrived with, so a refused
        // sequence refuses its `readAt` too — keeping it would claim a read at
        // a time that never happened.
        #expect(advancedReadMark(mark(5, 100), mark(5, 999)) == nil)
        #expect(advancedReadMark(mark(6, 100), mark(5, 999)) == nil)
        // A slow receipt for turn 5 landing after a poll already reported 6.
        #expect(advancedReadMark(mark(6, 100), mark(nil, 999)) == nil)
    }

    @Test func anAnswerWithNoStampKeepsTheOneAlreadyThere() {
        // The mark moved, so the old stamp is the best true thing known about
        // WHEN — clearing it would lose the inactivity clock's baseline.
        #expect(advancedReadMark(mark(4, 100), mark(5, nil)) == mark(5, 100))
    }

    @Test func theSessionHelperReportsWhetherAnythingMoved() {
        var session = try! JSONDecoder().decode(Session.self, from: Data(#"""
        {"id":"s","title":"T","createdAt":1,"updatedAt":1000,"driver":"claude",
         "workspace":{"mode":"local","path":"/x"},"runtimeMode":"auto","detached":false,
         "activity":"idle","lastTurnSequence":7,"lastReadTurnSequence":4,"readAt":100}
        """#.utf8))
        #expect(Settling.showsUnreadMark(session))
        // Called outside `#expect`: the macro re-evaluates its expression with
        // the captured value made immutable, which a mutating member cannot be
        // called on.
        let refused = session.applyReadMark(mark(4, 900))
        #expect(!refused)
        #expect(session.readAt == 100)
        let moved = session.applyReadMark(mark(7, 900))
        #expect(moved)
        #expect(session.lastReadTurnSequence == 7)
        #expect(session.readAt == 900)
        // …and the dot the whole exercise is about is now out.
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
        // Only the named row moves, and it moves inside the band it was in —
        // re-banding here would let the row jump shelves under the reader.
        #expect(folded.active.map(\.lastReadTurnSequence) == [1, 1])
        #expect(folded.settled.map(\.lastReadTurnSequence) == [9])
        #expect(folded.settled.count == 1 && folded.active.count == 2)
        // A session this store does not list changes nothing at all.
        #expect(applyReadMark(sections, sessionId: "zz", answer: mark(9, 500)) == sections)
    }
}
