/**
 * WHAT DEEPGRAM SAYS, TURNED INTO WHAT GOES IN THE BOX (#544).
 *
 * ── THE CONSTRAINT THAT SHAPES ALL OF THIS ──────────────────────────────────
 * `window.telar.dictate` INSERTS. It cannot retract, and it must not learn how:
 * it writes through the composer's own `insertAtCaret`, and an API that could
 * also reach back and delete what it last wrote would be an API that could
 * delete what the PERSON last typed — the composer is a live box, and a
 * dictation is not the only thing going into it.
 *
 * A live transcription is the opposite shape. Deepgram streams interim guesses
 * that it revises — "recur", "record", "recording" — and only some of them are
 * marked final. Inserting every one of those would put all three in the box.
 *
 * SO INTERIM TEXT IS SHOWN, NOT INSERTED. The unconfirmed words live in the
 * button's own caption where they can be replaced freely, and only a FINAL
 * lands in the composer, once, through `dictate`. That is also the behaviour
 * `dictate` was designed for: "focus and the caret are left after the text, so
 * a second call continues the sentence" (docs/page-api.md).
 *
 * ── WHY THIS IS A PURE REDUCER AND NOT PART OF THE SOCKET ───────────────────
 * It is the half that has rules — which frames are results, which results are
 * final, what spacing a committed phrase needs — and it is the half a test can
 * drive with a list of frames and no microphone, no socket and no browser. The
 * socket code around it is plumbing.
 */

/** One frame off the live socket, as much of it as matters here. Deepgram sends
 *  `Metadata`, `SpeechStarted` and `UtteranceEnd` frames too; everything that
 *  is not a `Results` with words in it is nothing to this reducer. */
export type DeepgramFrame = {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
};

export type DictationTranscript = {
  /** Words Deepgram has committed to, ready to go into the composer. Empty
   *  unless the last frame finalised something. */
  commit: string;
  /** Its current guess at what is still being said. Shown, never inserted. */
  interim: string;
};

export const EMPTY_TRANSCRIPT: DictationTranscript = { commit: "", interim: "" };

/**
 * One frame in, one decision out.
 *
 * `commit` IS WHAT THIS FRAME FINALISED, not everything said so far. The caller
 * inserts it and forgets it — accumulating here and re-inserting the whole
 * utterance each time is how a dictation ends up saying everything twice.
 *
 * AN EMPTY FINAL CLEARS THE PREVIEW AND COMMITS NOTHING. Deepgram finalises
 * silence at the end of an utterance, and a blank insertion is a spurious space
 * in somebody's message.
 */
export function readFrame(frame: DeepgramFrame): DictationTranscript {
  if (frame.type !== undefined && frame.type !== "Results") return EMPTY_TRANSCRIPT;
  const said = frame.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
  if (!frame.is_final) return { commit: "", interim: said };
  return said ? { commit: said, interim: "" } : EMPTY_TRANSCRIPT;
}

/**
 * Parse a raw socket message into a frame, or nothing.
 *
 * NEVER THROWS. A binary frame, a keep-alive, a shape from a future version of
 * the API — none of them is worth ending a dictation over, and the person is
 * mid-sentence. An unreadable frame is simply one with nothing in it.
 */
export function parseFrame(data: unknown): DeepgramFrame | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? (parsed as DeepgramFrame) : undefined;
  } catch {
    return undefined;
  }
}
