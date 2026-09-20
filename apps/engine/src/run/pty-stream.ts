/**
 * REDACTION WHEN THE STREAM IS A TERMINAL RATHER THAN A PIPE.
 *
 * `stream.ts` is the line-based redactor, and its correctness rests on one
 * invariant `types.ts` enforces at the door: A SECRET MAY NOT CONTAIN A LINE
 * BREAK, so a complete line can never be changed by a byte that arrives after
 * it. A PTY takes two of its assumptions away.
 *
 * THERE IS NO LINE DISCIPLINE TO LEAN ON. A shell prompt, a progress bar, a
 * full-screen program: none of them end with `\n`, and a redactor that waits
 * for one either shows nothing or shows it late. So the forced-flush path — a
 * footnote in `stream.ts` — is the ONLY path here, and it has to be exact
 * rather than merely bounded.
 *
 * AND THE STREAM CARRIES ESCAPE SEQUENCES, which adds two rules the line
 * redactor never needed:
 *
 *   - A CUT MUST NOT LAND INSIDE ONE. Half of a `CSI 1;31 m` is not a shorter
 *     escape, it is a parser desync, and the emulator on the other end will eat
 *     whatever text follows it looking for a final byte.
 *   - THE SUBSTITUTION MUST NOT CHANGE THE WIDTH. `«redacted»` is a fine answer
 *     in a log pane and a bad one here: output positioned with `CSI H` is laid
 *     out in cells, and a replacement that is longer or shorter than what it
 *     replaced shifts every column after it. A redaction that scrambles a
 *     screen has not hidden a value, it has hidden the screen. So a secret is
 *     replaced by ONE MASK CELL PER CHARACTER — see `PTY_MASK`.
 *
 * WHAT IS KEPT FROM `stream.ts`, because it is the part that is easy to get
 * wrong twice: TEXT IS ONLY EMITTED ONCE NO LATER BYTE COULD CHANGE HOW IT IS
 * REDACTED. Scrubbing each arriving chunk is worse than doing nothing when two
 * secrets share a prefix — with `ABCD` and `ABCDEFGH` both secret, masking the
 * first chunk lets a bare `EFGH` through next, which is the tail of the longer
 * secret, published. The carry is therefore kept RAW, and the guarantee this
 * module actually offers is stronger and easier to test than "no secret
 * appears":
 *
 *   **Streaming the bytes in ANY slicing emits exactly what redacting the whole
 *   text at once would have emitted.**
 *
 * That holds because every cut lands outside every secret occurrence, so no
 * occurrence ever straddles one — and it is falsifiable against an arbitrary
 * slicing, which "the secret is absent" is not (empty output satisfies that).
 *
 * TWO HONEST LIMITS, both stated rather than papered over.
 *
 * A MASK CELL PER UTF-16 UNIT IS NOT A MASK CELL PER COLUMN. It is exact for
 * ASCII — which is what API tokens and keys are — and for astral characters,
 * where two surrogate units happen to match the two columns an emoji occupies.
 * It is off by one per character for BMP wide characters (CJK), which a real
 * `wcwidth` table would fix and a half-right one would only appear to.
 *
 * AND A TERMINAL IS WIDER THAN ITS CAPTURED OUTPUT. This module redacts what
 * the process writes. It cannot reach what a person TYPES into that tab, and it
 * cannot reach the emulator's own scrollback, which holds raw bytes on the
 * client. `docs/run-terminal.md` says so in the place a user will look.
 */

/** ESC. Everything in here begins with it. */
const ESC = "\x1b";
/** BEL, the lenient terminator xterm accepts for OSC in place of ST. */
const BEL = "\x07";

/**
 * How long a sequence may stay unterminated before we stop believing it is one.
 *
 * An OSC 52 clipboard write is genuinely long, so this is generous; what it
 * bounds is a process that writes a lone `ESC ]` and then a megabyte of text,
 * which would otherwise grow the carry until the daemon died. Past the ceiling
 * the bytes are ordinary text, which is the honest reading anyway.
 */
export const MAX_ESCAPE_CHARS = 8192;

/**
 * How much unemitted text is tolerated before escape integrity yields.
 *
 * SECRECY NEVER YIELDS — the overflow path still refuses to cut inside a secret
 * or to emit a partial one. What it gives up is waiting for a sequence to
 * finish, because memory is the one thing a misbehaving process can exhaust.
 */
export const MAX_HOLD_CHARS = 64 * 1024;

/**
 * ONE CELL, AND DELIBERATELY NOT `*`.
 *
 * The replacement has to occupy exactly one column so a run of them lines up
 * with what it replaced. `*` would do that too and is the password-field
 * convention, but it is also a glob, a wildcard and a footnote marker in
 * perfectly ordinary command output — so a masked run would read as if the
 * program had printed asterisks. A bullet does not occur by accident.
 */
export const PTY_MASK = "•";

/**
 * Where the escape sequence starting at `start` ends, or -1 if the text runs
 * out before it does.
 *
 * ONLY THE 7-BIT FORMS. node-pty hands us UTF-8, where the 8-bit C1 controls
 * (0x9B for CSI, 0x9D for OSC) cannot appear as bare bytes — they would be the
 * tail of a multi-byte character instead. Recognising them here would therefore
 * mean misreading real text as an escape, which is the more damaging mistake.
 *
 * AN ESC THAT CANNOT START A SEQUENCE STANDS ALONE, rather than swallowing the
 * rest of the stream. A parser that waits forever on `ESC` + garbage is how one
 * malformed byte stops all output.
 */
function escapeEnd(text: string, start: number): number {
  const kind = text[start + 1];
  if (kind === undefined) return -1;

  // CSI: parameter bytes, then intermediates, then one final byte.
  if (kind === "[") {
    let index = start + 2;
    while (index < text.length && isBetween(text, index, 0x30, 0x3f)) index += 1;
    while (index < text.length && isBetween(text, index, 0x20, 0x2f)) index += 1;
    if (index >= text.length) return -1;
    return isBetween(text, index, 0x40, 0x7e) ? index + 1 : start + 1;
  }

  // The string sequences — OSC, DCS, SOS, PM, APC — run until ST or BEL.
  if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
    for (let index = start + 2; index < text.length; index += 1) {
      if (text[index] === BEL) return index + 1;
      if (text[index] !== ESC) continue;
      // `ESC \` is ST. A trailing lone ESC could still become one, so the text
      // is incomplete rather than terminated.
      if (index + 1 >= text.length) return -1;
      if (text[index + 1] === "\\") return index + 2;
    }
    return -1;
  }

  // `ESC ( B`, `ESC # 8`: one or more intermediates, then a final byte.
  if (isBetween(text, start + 1, 0x20, 0x2f)) {
    let index = start + 2;
    while (index < text.length && isBetween(text, index, 0x20, 0x2f)) index += 1;
    return index >= text.length ? -1 : index + 1;
  }

  // `ESC 7`, `ESC M`, `ESC =`: two characters and done.
  return isBetween(text, start + 1, 0x30, 0x7e) ? start + 2 : start + 1;
}

function isBetween(text: string, index: number, low: number, high: number): boolean {
  const code = text.charCodeAt(index);
  return code >= low && code <= high;
}

export type EscapeScan = {
  /** `[start, end)` of every COMPLETE sequence, in order. */
  spans: Array<[number, number]>;
  /** Where a sequence begins that the text ends in the middle of, or -1. */
  pending: number;
};

/** Every escape sequence in `text`, and whether it ends mid-sequence. */
export function escapeScan(text: string): EscapeScan {
  const spans: Array<[number, number]> = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ESC) continue;
    const end = escapeEnd(text, index);
    if (end === -1) {
      // Past the ceiling we stop waiting and read the bytes as text; short of
      // it, this is where the emittable region has to stop.
      if (text.length - index <= MAX_ESCAPE_CHARS) return { spans, pending: index };
      continue;
    }
    // A lone ESC (`end === index + 1`) is a single ordinary character, not a
    // span a cut has to avoid.
    if (end > index + 1) spans.push([index, end]);
    index = end - 1;
  }
  return { spans, pending: -1 };
}

/**
 * The largest index at or below `limit` that splits neither a secret occurrence
 * nor a complete escape sequence.
 *
 * BACKWARDS, WHERE `stream.ts`'s `safeCut` GOES FORWARDS, and the difference is
 * the whole reason this is a separate function. There, a cut may be pushed past
 * the cap because a complete line behind it is already safe to emit. Here there
 * are no lines: everything above `limit` is unsettled, so a cut that moved
 * forward would emit text a later byte could still change.
 */
export function safeCutBack(text: string, secrets: readonly string[], limit: number): number {
  let cut = Math.max(0, Math.min(limit, text.length));
  if (cut === 0) return 0;
  const { spans } = escapeScan(text);
  // Pulling out of one region can land inside another, so this settles rather
  // than passing once. `cut` only ever shrinks and is bounded by 0, so it ends.
  for (let moved = true; moved && cut > 0; ) {
    moved = false;
    for (const [start, end] of spans) {
      if (cut > start && cut < end) {
        cut = start;
        moved = true;
      }
    }
    for (const secret of secrets) {
      if (!secret) continue;
      for (let index = text.indexOf(secret); index !== -1 && index < cut; index = text.indexOf(secret, index + 1)) {
        if (index + secret.length > cut) {
          cut = index;
          moved = true;
        }
      }
    }
  }
  return cut;
}

/**
 * How many trailing characters could still turn out to be the start of a
 * secret — the exact amount that must stay unemitted.
 *
 * `stream.ts` holds a fixed `longest - 1` because a line boundary already does
 * most of the work there. Here the hold is on every flush, so a fixed one would
 * cost a terminal the last hundred characters of every prompt. Asking the
 * question exactly costs a scan of the tail and usually answers zero.
 */
export function pendingSecretPrefix(text: string, secrets: readonly string[]): number {
  let hold = 0;
  for (const secret of secrets) {
    if (!secret) continue;
    const window = Math.min(secret.length - 1, text.length);
    // Ascending `start` means descending length, so the first match is the
    // longest and the loop can stop at it.
    for (let start = text.length - window; start < text.length; start += 1) {
      const length = text.length - start;
      if (length <= hold) break;
      if (text[start] !== secret[0]) continue;
      if (text.startsWith(secret.slice(0, length), start)) {
        hold = length;
        break;
      }
    }
  }
  return hold;
}

/**
 * Replace every secret with mask cells, ONE PER CHARACTER.
 *
 * `secrets` must be longest-first, as `secretValues` returns them: with `abc123`
 * and `abc123xyz` both secret, masking the short one first would leave the
 * longer one's tail on the line.
 *
 * THIS DELIBERATELY REACHES INSIDE ESCAPE SEQUENCES. A secret pasted into a
 * window title arrives as `OSC 0 ; …  BEL` and is as visible as any other text,
 * so refusing to touch string sequences would keep the framing and publish the
 * value. The cost is a pathological one worth naming: a secret whose value is
 * itself valid CSI parameter text (`1;31`) would mask those parameters, and the
 * emulator then discards that one sequence — a lost colour, not a desync,
 * because the final byte still terminates it.
 */
export function redactPtyText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(PTY_MASK.repeat(secret.length));
  }
  return out;
}

export type PtyRedactor = {
  /** Feed one arbitrary slice of the stream. */
  push(chunk: string): void;
  /** The stream ended: whatever is held is complete, so it can be emitted. */
  end(): void;
};

export type PtyRedactorOptions = {
  /** Unemitted characters tolerated before escape integrity yields. */
  maxHoldChars?: number;
};

/**
 * A redactor for a PTY's byte stream.
 *
 * `emit` receives text that has already been masked, in order, with every
 * escape sequence whole. Concatenating everything it emits — including the
 * `end()` flush — yields exactly `redactPtyText(everything pushed)`.
 */
export function createPtyRedactor(secrets: readonly string[], emit: (text: string) => void, options: PtyRedactorOptions = {}): PtyRedactor {
  const maxHold = options.maxHoldChars ?? MAX_HOLD_CHARS;
  let carry = "";

  /**
   * `safe` waits for a half-arrived escape; `overflow` stops waiting because
   * the buffer has grown past what a misbehaving process may cost us. NEITHER
   * gives up on a half-arrived secret — that hold is applied in both.
   */
  const flush = (mode: "safe" | "overflow"): void => {
    if (!carry) return;
    let limit = carry.length - pendingSecretPrefix(carry, secrets);
    if (mode === "safe") {
      const { pending } = escapeScan(carry);
      if (pending !== -1) limit = Math.min(limit, pending);
    }
    const cut = safeCutBack(carry, secrets, limit);
    if (cut <= 0) return;
    emit(redactPtyText(carry.slice(0, cut), secrets));
    carry = carry.slice(cut);
  };

  return {
    push(chunk: string): void {
      if (!chunk) return;
      carry += chunk;
      flush("safe");
      if (carry.length > maxHold) flush("overflow");
    },
    end(): void {
      // Nothing can arrive after the end, so a trailing secret prefix is not a
      // secret and a trailing half-escape is not a sequence. Both are text.
      if (carry) emit(redactPtyText(carry, secrets));
      carry = "";
    },
  };
}
