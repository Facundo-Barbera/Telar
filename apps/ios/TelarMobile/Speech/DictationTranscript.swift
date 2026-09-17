import Foundation

/// WHAT THE TRANSCRIBER SAYS, TURNED INTO WHAT GOES IN THE COMPOSER (#544).
///
/// ── THE SAME RULE AS THE WEB'S, AND IT IS NOT A COINCIDENCE ─────────────────
/// `apps/web/lib/dictation/transcript.ts` and `interim.ts` are this file in
/// TypeScript. Both exist for one fact: a live transcription REVISES itself.
/// The service streams interim guesses — "recur", "record", "recording" — and
/// marks only some of them final.
///
/// The first cut showed those guesses in a line above the box and only merged a
/// phrase once it was settled. It reads as lag: you speak, the box stays empty,
/// and a sentence appears a beat after you stopped. So the words go INTO the
/// draft as they are heard and are rewritten in place until the service settles
/// them, which is what the desktop does and what every dictation people already
/// use does.
///
/// ── THE SPAN IS FRAGILE, AND THAT IS THE WHOLE PROBLEM ──────────────────────
/// The unconfirmed words occupy a run of the draft, and the draft is a `String`
/// this app owns but the PERSON is also typing into. They can type inside the
/// guess, delete it, or paste over it, and an offset range does not survive any
/// of that — writing through a stale one would eat text nobody dictated.
///
/// The guard is one comparison: `DictationDraftWriter` remembers the draft it
/// last wrote, and a draft that is not that one means somebody else wrote. The
/// span is then DROPPED and the next guess starts a fresh one. Deliberately
/// blunt: nothing here works out whether the edit was inside the span or before
/// it, because both answers end in the same place and the arithmetic of the
/// other would be a source of exactly the bug it avoids.

/// One frame off the live socket, as much of it as matters here. The service
/// also sends `Metadata`, `SpeechStarted` and `UtteranceEnd`; anything that is
/// not a `Results` with a channel on it is nothing to this.
struct DictationFrame: Decodable, Sendable {
    var type: String?
    var isFinal: Bool?
    var channel: Channel?

    struct Channel: Decodable, Sendable {
        var alternatives: [Alternative]?
    }
    struct Alternative: Decodable, Sendable {
        var transcript: String?
    }

    enum CodingKeys: String, CodingKey {
        case type
        case isFinal = "is_final"
        case channel
    }

    /// NEVER THROWS. A binary frame, a truncated one, a shape from a future
    /// version of the API — none is worth ending a recording over, and the
    /// person is mid-sentence. An unreadable frame is one with nothing in it.
    static func read(_ text: String) -> DictationFrame? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(DictationFrame.self, from: data)
    }
}

/// What one frame decided about the words on screen.
struct DictationWords: Equatable, Sendable {
    /// Everything the service currently believes this utterance says. It
    /// REPLACES the last guess rather than continuing it, which is the whole
    /// shape of an interim result.
    var text: String
    /// Settled. The words stop being the dictation's to rewrite and become
    /// ordinary text in somebody's draft.
    var final: Bool
}

enum DictationTranscript {
    /// One frame in, one decision out — or nothing at all.
    ///
    /// `nil` IS "THIS FRAME SAYS NOTHING ABOUT THE WORDS": a `Metadata` frame,
    /// an `UtteranceEnd`, a keep-alive. The draft must not be touched for one
    /// of those, which is a different thing from being told the utterance is
    /// now empty.
    ///
    /// A FINAL WITH NO WORDS IS STILL A FINAL. The service finalises the quiet
    /// at the end of an utterance, and the right answer is empty-and-settled —
    /// it takes the last unconfirmed guess back out of the box rather than
    /// leaving it sitting there for the person to delete.
    static func read(_ frame: DictationFrame) -> DictationWords? {
        if let type = frame.type, type != "Results" { return nil }
        guard let alternatives = frame.channel?.alternatives else { return nil }
        let said = (alternatives.first?.transcript ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return DictationWords(text: said, final: frame.isFinal == true)
    }

    /// Put a phrase into a draft the way a paste would land.
    ///
    /// SPACED ONLY WHERE A SPACE IS MISSING, so a dictation that continues a
    /// half-typed line reads as one sentence and one that follows another
    /// dictated phrase does not gain a double space. A draft ending in a
    /// newline is left alone — somebody who pressed return meant the break.
    ///
    /// AN EMPTY PHRASE CHANGES NOTHING, which is what makes this safe to call
    /// on every frame without the caller checking first.
    static func merge(draft: String, commit: String) -> String {
        let phrase = commit.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !phrase.isEmpty else { return draft }
        guard let last = draft.last else { return phrase }
        if last.isWhitespace { return draft + phrase }
        return draft + " " + phrase
    }
}

/// THE UNCONFIRMED RUN, AND WHO IS ALLOWED TO HAVE MOVED IT.
///
/// A value type rather than an object: it holds two facts and is owned by the
/// view that owns the draft, so there is nothing to keep alive and nothing to
/// leak when the screen goes away. Every rule in it is checked against a plain
/// `String` in `DictationTranscriptTests` — no microphone, no socket, no view.
struct DictationDraftWriter {
    /// Character offsets into the draft. Absent between utterances, and after
    /// anybody else has written.
    private var span: Range<Int>?

    /// THE UNCONFIRMED RUN AS IT STANDS, for whoever draws it (#561).
    ///
    /// A reader rather than a second copy: the rules that move this span are
    /// all in `write`, so an indicator that tracked it separately would be a
    /// second answer to a question that has one. `nil` is exactly when there is
    /// nothing to dim.
    var unconfirmed: Range<Int>? { span }
    /// The draft this writer last produced — the whole of the "did somebody
    /// else type?" test.
    private var committed: String?

    init() {}

    /// Forget the span without touching the draft. Called when a dictation
    /// ends: whatever was heard is the person's draft now, including a guess
    /// the service never got to settle — they said it, and they can edit it.
    mutating func forget() {
        span = nil
        committed = nil
    }

    /// The draft this frame's words leave behind.
    mutating func write(_ words: DictationWords, into draft: String) -> String {
        // SOMEBODY ELSE WROTE, so the offsets mean nothing now. Dropping the
        // span is the whole recovery: the guess already in the box becomes
        // ordinary text, and the next one opens a span at the end.
        if span != nil, draft != committed { span = nil }

        if let live = span {
            let next = Self.replacing(draft, live, with: words.text)
            committed = next
            span = words.final ? nil : live.lowerBound ..< (live.lowerBound + words.text.count)
            return next
        }

        // NOTHING TO OPEN A SPAN WITH. An empty interim is silence being heard
        // and an empty final is that silence being settled; writing either
        // would be a spurious space in somebody's message.
        guard !words.text.isEmpty else { return draft }
        let next = merged(draft, words.text)
        committed = next
        // A FINAL NEVER LEAVES A SPAN BEHIND: the words are the person's now.
        // `merge` appends, so the phrase is the tail of what came back.
        span = words.final ? nil : (next.count - words.text.count) ..< next.count
        return next
    }

    private func merged(_ draft: String, _ text: String) -> String {
        DictationTranscript.merge(draft: draft, commit: text)
    }

    /// Swap a run of a string by character offset, clamped at both ends — the
    /// draft can have shrunk under a span that was live a frame ago.
    private static func replacing(_ text: String, _ range: Range<Int>, with replacement: String) -> String {
        let count = text.count
        let start = min(max(0, range.lowerBound), count)
        let end = min(max(start, range.upperBound), count)
        let lower = text.index(text.startIndex, offsetBy: start)
        let upper = text.index(text.startIndex, offsetBy: end)
        return text.replacingCharacters(in: lower ..< upper, with: replacement)
    }
}

/// THE WRITER, SOMEWHERE A SOCKET CALLBACK CAN REACH IT.
///
/// The span is not drawn, so it must not be `@State`: a mutation per interim
/// frame would re-render the whole composer several times a second to no
/// visible effect. But the frames arrive in a closure that outlives the render
/// that made it, and a `struct` captured there would be a copy nobody's next
/// frame could see. One main-actor reference is the smallest thing that is both
/// — the rules stay in the value type, where a test can drive them.
@MainActor final class DictationDraftBox {
    private var writer = DictationDraftWriter()

    init() {}

    /// The run still being revised, for the composer to draw dimmer (#561).
    /// Read after each write rather than published: the box is not observable,
    /// and the one caller is already in the middle of the frame that moved it.
    var unconfirmed: Range<Int>? { writer.unconfirmed }

    func write(_ words: DictationWords, into draft: String) -> String {
        writer.write(words, into: draft)
    }

    func forget() {
        writer.forget()
    }
}
