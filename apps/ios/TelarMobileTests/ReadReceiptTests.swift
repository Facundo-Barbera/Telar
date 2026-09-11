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
