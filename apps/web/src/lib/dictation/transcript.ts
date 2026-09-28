/**
 * Pure reducer from Deepgram frames to draft edits; `interim.ts` applies them.
 * Interim results replace the last guess rather than extend it.
 */

/** `Metadata`, `SpeechStarted` and `UtteranceEnd` frames also arrive; only `Results` with words matter. */
export type DeepgramFrame = {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
};

export type DictationWords = {
  /** Replaces the last guess rather than continuing it. */
  text: string;
  final: boolean;
};

/**
 * `undefined` means the frame says nothing about the words (leave the draft
 * alone). A final with no words is still a final: it clears the last guess.
 */
export function readFrame(frame: DeepgramFrame): DictationWords | undefined {
  if (frame.type !== undefined && frame.type !== "Results") return undefined;
  const alternatives = frame.channel?.alternatives;
  if (alternatives === undefined) return undefined;
  return { text: alternatives[0]?.transcript?.trim() ?? "", final: frame.is_final === true };
}

/** Never throws; an unreadable frame is treated as empty. */
export function parseFrame(data: unknown): DeepgramFrame | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? (parsed as DeepgramFrame) : undefined;
  } catch {
    return undefined;
  }
}
