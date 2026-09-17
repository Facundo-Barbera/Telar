import Foundation

/// WHAT THE TRANSCRIBER SAYS, TURNED INTO WHAT GOES IN THE COMPOSER (#544).
///
/// ── THE SAME RULE AS THE WEB'S, AND IT IS NOT A COINCIDENCE ─────────────────
/// `apps/web/lib/dictation/transcript.ts` is this file in TypeScript, and both
/// exist for one constraint: a live transcription REVISES itself. Deepgram
/// streams interim guesses — "recur", "record", "recording" — and marks only
/// some of them final. Writing every guess into the box puts all three in
/// somebody's message.
///
/// So interim text is SHOWN and only a final is COMMITTED. On the web that is
/// forced by `window.telar.dictate`, which inserts and cannot retract. Here the
/// composer's draft is a `String` this app owns and could be rewritten freely —
/// so the rule is a CHOICE rather than a constraint, and it is made the same
/// way on purpose: a person dictating the same sentence into the phone and into
/// the desktop must not watch their words behave differently.
///
/// ── AND THE DRAFT IS NOT ALWAYS EMPTY ───────────────────────────────────────
/// The reason this is a merge rather than an assignment: dictation starts at
/// whatever the box already holds, which is frequently something half-typed. So
/// the committed phrase is APPENDED, spaced the way a paste is, and what the
/// person typed is never overwritten. `merge` is that, and it is the whole of
/// what this file has rules about.

/// One frame off the live socket, as much of it as matters here. The service
/// also sends `Metadata`, `SpeechStarted` and `UtteranceEnd`; anything that is
/// not a `Results` with words in it is nothing to this.
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

/// What one frame decided.
struct DictationStep: Equatable, Sendable {
    /// Words the service committed to, ready for the composer. Empty unless
    /// this frame finalised something.
    var commit: String = ""
    /// Its current guess at what is still being said. Shown, never committed.
    var interim: String = ""

    static let nothing = DictationStep()
}

enum DictationTranscript {
    /// One frame in, one decision out.
    ///
    /// `commit` IS WHAT THIS FRAME FINALISED, not everything said so far — the
    /// caller appends it and forgets it. Accumulating here and re-appending the
    /// whole utterance each time is how a dictation says everything twice.
    ///
    /// A FINALISED SILENCE COMMITS NOTHING. The service finalises the quiet at
    /// the end of an utterance, and a blank commit is a spurious space in
    /// somebody's message.
    static func step(_ frame: DictationFrame) -> DictationStep {
        if let type = frame.type, type != "Results" { return .nothing }
        let said = (frame.channel?.alternatives?.first?.transcript ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard frame.isFinal == true else { return DictationStep(commit: "", interim: said) }
        return said.isEmpty ? .nothing : DictationStep(commit: said, interim: "")
    }

    /// Put a committed phrase into a draft the way a paste would land.
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
