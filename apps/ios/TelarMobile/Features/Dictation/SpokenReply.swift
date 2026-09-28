import Foundation

struct SpeakableTurn: Equatable {
    var runId: EngineID
    var state: TurnState
    var sequence: Int

    var closingProse: String

    var resultText: String
}

func lastReplySource(_ turns: [SpeakableTurn]) -> String? {
    let candidate = newestResultTurn(
        turns.map { ReceiptTurn(runId: $0.runId, state: $0.state, sequence: $0.sequence) }
    )
    guard let candidate, let turn = turns.last(where: { $0.runId == candidate.runId }) else { return nil }
    let source = turn.closingProse.isEmpty ? turn.resultText : turn.closingProse
    return source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : source
}

func lastReplySource(of turns: [JournalTurn]) -> String? {
    let candidate = newestResultTurn(
        turns.map { ReceiptTurn(runId: $0.runId, state: $0.state, sequence: $0.sequence) }
    )
    guard let candidate, let turn = turns.last(where: { $0.runId == candidate.runId }) else { return nil }
    return lastReplySource([turn.speakable])
}

extension JournalTurn {
    var speakable: SpeakableTurn {
        let answering = splitAtMessageBoundaries(items).last
        let closing = answering?.items.last { item in
            if case .assistantMessage = item.detail { return true }
            return false
        }
        return SpeakableTurn(
            runId: runId, state: state, sequence: sequence,
            closingProse: closing?.text ?? "", resultText: resultText
        )
    }
}
