import Foundation

/// WHICH reply "the last reply" means, decided once and away from any view.
///
/// The app already pins a notion of the newest answer — `newestResultTurn`
/// (`Stores/ReadReceipt.swift`), newest by the ENGINE's sequence among the
/// states that leave a result. Speech reuses it rather than inventing a third:
/// a "Speak the last reply" that spoke a different turn from the one the read
/// receipt confirms would be two answers to one question.
///
/// WHAT of that turn is spoken: the LAST assistant message of the answering
/// response — the same cut `TurnView.split` draws as `closing`
/// (`Views/TranscriptViews.swift`), so what is heard is what is on screen.
/// `resultText` is the fallback for a turn that carries no assistant item at
/// all (a failure, an older snapshot).

/// What speech reads off a turn. Not `JournalTurn`, so the rule can be tested
/// in a line — the same reason `ReceiptTurn` exists.
struct SpeakableTurn: Equatable {
    var runId: EngineID
    var state: TurnState
    var sequence: Int
    /// The answering response's last assistant message, as raw Markdown.
    var closingProse: String
    /// The engine's own final text for the turn.
    var resultText: String
}

/// The Markdown of the newest settled answer, or nil when the session has
/// none to read — nothing has finished yet, or what finished said nothing.
///
/// RAW, NOT SPOKEN. `speakableText` walks the whole reply, and this is asked on
/// every render to decide whether the menu carries the item at all; the pass
/// runs once, when somebody actually taps it.
func lastReplySource(_ turns: [SpeakableTurn]) -> String? {
    let candidate = newestResultTurn(
        turns.map { ReceiptTurn(runId: $0.runId, state: $0.state, sequence: $0.sequence) }
    )
    guard let candidate, let turn = turns.last(where: { $0.runId == candidate.runId }) else { return nil }
    let source = turn.closingProse.isEmpty ? turn.resultText : turn.closingProse
    return source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : source
}

/// The same question of a real transcript. THE CANDIDATE IS CHOSEN FIRST, off
/// three cheap fields, and only that turn is cut into responses — this is asked
/// on every render, and cutting every turn to read one is work for nothing.
func lastReplySource(of turns: [JournalTurn]) -> String? {
    let candidate = newestResultTurn(
        turns.map { ReceiptTurn(runId: $0.runId, state: $0.state, sequence: $0.sequence) }
    )
    guard let candidate, let turn = turns.last(where: { $0.runId == candidate.runId }) else { return nil }
    return lastReplySource([turn.speakable])
}

extension JournalTurn {
    /// This turn as speech reads it. `splitAtMessageBoundaries` is the
    /// transcript's own cut: a message sent INTO a running turn opens a new
    /// response, and only the last response's final prose is the answer to the
    /// turn — an earlier one's is what it said about a steer.
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
