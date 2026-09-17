/**
 * WHAT DEEPGRAM SAYS, TURNED INTO WHAT GOES IN THE BOX (#544).
 *
 * ── ONE FRAME IN, ONE DECISION OUT ──────────────────────────────────────────
 * A live transcription REVISES itself. Deepgram streams interim guesses —
 * "recur", "record", "recording" — and marks only some of them final. This file
 * is the half that has rules about which frames are results and which results
 * are settled; `interim.ts` is the half that decides what to do to the draft
 * about it, and the socket around both is plumbing.
 *
 * THE SHAPE SAYS WHETHER IT IS SETTLED, rather than carrying a `commit` string
 * that is empty when it is not. The writer has to tell three cases apart — new
 * guess, settled phrase, and a finalised SILENCE that should take the guess
 * back out of the box — and a pair of strings could only ever describe two of
 * them. That ambiguity is what the earlier shape had, and it was invisible
 * while interim words lived in a caption nobody wrote to.
 *
 * ── WHY IT IS A PURE REDUCER AND NOT PART OF THE SOCKET ─────────────────────
 * A test can drive it with a list of frames and no microphone, no socket and no
 * browser.
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

/** What one frame decided about the words on screen. */
export type DictationWords = {
  /** Everything Deepgram currently believes this utterance says. It REPLACES
   *  the last guess rather than continuing it — that is the whole shape of an
   *  interim result. */
  text: string;
  /** Settled. The words stop being the dictation's to rewrite and become
   *  ordinary text in somebody's draft. */
  final: boolean;
};

/**
 * One frame in, one decision out — or nothing at all.
 *
 * `undefined` IS "THIS FRAME SAYS NOTHING ABOUT THE WORDS": a `Metadata` frame,
 * an `UtteranceEnd`, a keep-alive. The writer must not touch the draft for one
 * of those, which is different from being told the utterance is now empty.
 *
 * A FINAL WITH NO WORDS IS STILL A FINAL. Deepgram finalises the silence at the
 * end of an utterance, and the right answer is `{ text: "", final: true }` — it
 * settles the span at whatever was last guessed being removed, rather than
 * leaving an unconfirmed guess sitting in the box forever.
 */
export function readFrame(frame: DeepgramFrame): DictationWords | undefined {
  if (frame.type !== undefined && frame.type !== "Results") return undefined;
  const alternatives = frame.channel?.alternatives;
  if (alternatives === undefined) return undefined;
  return { text: alternatives[0]?.transcript?.trim() ?? "", final: frame.is_final === true };
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
