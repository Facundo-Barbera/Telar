/**
 * Redaction over a terminal's byte stream.
 *
 * THE GUARD THIS FILE IS BUILT AROUND IS NOT "THE SECRET IS ABSENT". That one
 * is satisfied by output that is empty, truncated or mangled — three states a
 * broken redactor reaches easily. What is asserted instead is an EQUALITY that
 * only the working thing produces:
 *
 *   streaming the bytes in any slicing emits exactly what redacting the whole
 *   text at once emits,
 *
 * plus, on the same outputs, that every escape sequence came through whole and
 * at the same offset it went in at — which is the machine-checkable form of
 * "the columns did not move".
 */
import { expect, test } from "bun:test";
import {
  createPtyRedactor,
  escapeScan,
  MAX_ESCAPE_CHARS,
  PTY_MASK,
  pendingSecretPrefix,
  redactPtyText,
  safeCutBack,
} from "../src/run/pty-stream";

/** Longest first, the order `secretValues` guarantees and this module needs. */
const order = (values: string[]): string[] => [...values].sort((a, b) => b.length - a.length);

/** Collect what a redactor emits for one slicing of `text`. */
function stream(text: string, secrets: string[], slices: number[], options?: { maxHoldChars?: number }): string[] {
  const out: string[] = [];
  const redactor = createPtyRedactor(secrets, (piece) => out.push(piece), options ?? {});
  let at = 0;
  for (const size of slices) {
    if (at >= text.length) break;
    redactor.push(text.slice(at, at + size));
    at += size;
  }
  if (at < text.length) redactor.push(text.slice(at));
  redactor.end();
  return out;
}

/** A tiny deterministic PRNG, so a property failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const CSI = "\x1b[";
const OSC = "\x1b]";
const BEL = "\x07";

// ── the width promise, stated as a number ────────────────────────────────────

test("a masked secret occupies exactly as many cells as the value it replaced", () => {
  const secrets = order(["sk-live-0123456789", "hunter2!"]);
  for (const secret of secrets) {
    expect(redactPtyText(secret, secrets)).toHaveLength(secret.length);
    expect(redactPtyText(secret, secrets)).toBe(PTY_MASK.repeat(secret.length));
  }
  // The whole-text form, which is what a screen actually sees: same length in,
  // same length out. `«redacted»` cannot satisfy this for either secret.
  const text = `TOKEN=sk-live-0123456789 PASS=hunter2! done`;
  expect(redactPtyText(text, secrets)).toHaveLength(text.length);
  expect(redactPtyText(text, secrets)).not.toContain("sk-live-0123456789");
  expect(redactPtyText(text, secrets)).not.toContain("hunter2!");
});

test("cursor-positioned output keeps its columns across a redaction", () => {
  const secrets = order(["s3cr3t-value"]);
  // Two rows written with absolute positioning, the secret on the first.
  const text = `${CSI}1;1Hkey=s3cr3t-value${CSI}2;1Hnext line`;
  const redacted = redactPtyText(text, secrets);
  expect(redacted).toHaveLength(text.length);
  // Every escape sequence is still at the offset it was written at — the thing
  // a length-changing substitution breaks.
  expect(escapeScan(redacted).spans).toEqual(escapeScan(text).spans);
  expect(redacted).toBe(`${CSI}1;1Hkey=${PTY_MASK.repeat(12)}${CSI}2;1Hnext line`);
});

// ── the prefix-sharing leak `stream.ts` was built against ────────────────────

test("two secrets sharing a prefix do not leak the longer one's tail", () => {
  const secrets = order(["ABCD", "ABCDEFGH"]);
  const emitted = stream("xx ABCDEFGH yy", secrets, [4, 4, 2, 2, 2]).join("");
  // The failure mode is a bare `EFGH` — the tail of the longer secret, left
  // behind after the shorter one was masked too early.
  expect(emitted).not.toContain("EFGH");
  expect(emitted).not.toContain("ABCD");
  expect(emitted).toBe(`xx ${PTY_MASK.repeat(8)} yy`);
});

test("a secret split one character at a time is never emitted in pieces", () => {
  const secrets = order(["correct-horse-battery"]);
  const text = `before correct-horse-battery after`;
  const emitted = stream(text, secrets, new Array(text.length).fill(1));
  const joined = emitted.join("");
  expect(joined).toBe(redactPtyText(text, secrets));
  // No single emitted piece may carry a fragment of the value either: the
  // concatenation being clean is not enough if a consumer reads chunks.
  for (const piece of emitted) {
    for (let length = 4; length <= 21; length += 1) {
      expect(piece).not.toContain(secrets[0]!.slice(0, length));
    }
  }
});

// ── escapes: never cut inside one, never reshape one ─────────────────────────

test("a chunk that ends mid-escape holds the escape back rather than cutting it", () => {
  const emitted = stream(`hello${CSI}1;31`, [], [5, 2, 2, 2]);
  const joined = emitted.join("");
  expect(joined).toBe(`hello${CSI}1;31`);
  // Everything before the end() flush is whole; only the final flush may carry
  // the unterminated remainder, because nothing can arrive after it.
  for (const piece of emitted.slice(0, -1)) {
    expect(escapeScan(piece).pending).toBe(-1);
  }
  expect(emitted[0]).toBe("hello");
});

test("safeCutBack refuses every offset inside a CSI sequence", () => {
  const text = `ab${CSI}1;31mcd`;
  const span = escapeScan(text).spans[0]!;
  expect(span).toEqual([2, 9]);
  // Asked to cut at each interior offset, it pulls back to the sequence's start
  // — asserted for every one of them, so a check that happened to miss the
  // middle cannot pass.
  for (let at = span[0] + 1; at < span[1]; at += 1) {
    expect(safeCutBack(text, [], at)).toBe(span[0]);
  }
  expect(safeCutBack(text, [], span[0])).toBe(span[0]);
  expect(safeCutBack(text, [], span[1])).toBe(span[1]);
});

test("safeCutBack refuses every offset inside a secret", () => {
  const secrets = order(["topsecret"]);
  const text = `aa topsecret bb`;
  for (let at = 4; at < 12; at += 1) expect(safeCutBack(text, secrets, at)).toBe(3);
  expect(safeCutBack(text, secrets, 3)).toBe(3);
  expect(safeCutBack(text, secrets, 12)).toBe(12);
});

/**
 * THE ONE ARRANGEMENT IN WHICH THE ESCAPE CLAUSE IN `safeCutBack` CARRIES THE
 * STREAM, and it is worth staging deliberately because ordinary output never
 * reaches it: the held tail only lands inside a sequence when a secret's own
 * first characters are also that sequence's parameter text.
 *
 * This is the pathological case the module's header names. The sequence itself
 * does not survive — its final byte is inside the secret — but what must never
 * happen is a TRUNCATED one going out, because a consumer's parser would then
 * eat the text that follows looking for a final byte.
 */
test("a secret that begins with a sequence's parameters never emits half of one", () => {
  const secrets = order(["31mSECRET"]);
  const out: string[] = [];
  const redactor = createPtyRedactor(secrets, (piece) => out.push(piece));
  redactor.push(`${CSI}31m`);
  // Nothing may go out yet: the only cut the secret hold allows is inside the
  // CSI, so the whole sequence has to wait.
  expect(out).toEqual([]);
  redactor.push("SECRET done");
  redactor.end();
  expect(out.join("")).toBe(redactPtyText(`${CSI}31mSECRET done`, secrets));
  expect(out.join("")).toBe(`${CSI}${PTY_MASK.repeat(9)} done`);
  for (const piece of out) expect(escapeScan(piece).pending).toBe(-1);
});

test("a secret inside a window title is masked and the OSC framing survives", () => {
  const secrets = order(["sk-live-abcdef"]);
  const text = `${OSC}0;build sk-live-abcdef${BEL}done`;
  const emitted = stream(text, secrets, [3, 5, 7, 4, 6]).join("");
  expect(emitted).not.toContain("sk-live-abcdef");
  expect(emitted).toBe(`${OSC}0;build ${PTY_MASK.repeat(14)}${BEL}done`);
  // The sequence is still a sequence, at the same offsets, with its terminator.
  expect(escapeScan(emitted).spans).toEqual(escapeScan(text).spans);
  expect(emitted.endsWith(`${BEL}done`)).toBe(true);
});

test("an escape that can never terminate does not hold the stream forever", () => {
  const secrets = order(["tinytoken"]);
  // A lone `ESC ]` and then a great deal of text with no ST and no BEL.
  const text = `tinytoken start${OSC}${"x".repeat(MAX_ESCAPE_CHARS + 500)}`;
  const emitted = stream(text, secrets, [8, 8, 8], { maxHoldChars: 1024 }).join("");
  expect(emitted).toBe(redactPtyText(text, secrets));
  expect(emitted).not.toContain("tinytoken");
  expect(emitted.startsWith(`${PTY_MASK.repeat(9)} start`)).toBe(true);
});

test("the overflow flush still refuses to split a secret", () => {
  const secrets = order(["a".repeat(64)]);
  const out: string[] = [];
  const redactor = createPtyRedactor(secrets, (piece) => out.push(piece), { maxHoldChars: 32 });
  // An unterminated OSC pins the safe path, so every flush here is the overflow
  // one; the secret then arrives four characters at a time through it.
  redactor.push(OSC);
  for (let i = 0; i < 64; i += 4) redactor.push("a".repeat(4));
  redactor.push(BEL);
  redactor.end();
  const joined = out.join("");
  expect(joined).toBe(`${OSC}${PTY_MASK.repeat(64)}${BEL}`);
  for (const piece of out) expect(piece).not.toContain("aaaa");
});

// ── the equality that cannot be satisfied by a broken redactor ───────────────

test("any slicing of a stream emits exactly what redacting it whole emits", () => {
  const secrets = order(["sk-live-9f2c4a", "sk-live-9f2c4a-extended-suffix", "pw:hunter2"]);
  const text = [
    `${CSI}2J${CSI}1;1H`,
    `$ deploy --token sk-live-9f2c4a\r\n`,
    `${CSI}32mok${CSI}0m using sk-live-9f2c4a-extended-suffix\r\n`,
    `${OSC}0;telar — pw:hunter2${BEL}`,
    `${CSI}?25l`,
    `progress ███ 50%\r`,
    `progress ██████ 100%\r\n`,
    `${CSI}?25h$ `,
  ].join("");
  const whole = redactPtyText(text, secrets);
  const wholeSpans = escapeScan(text).spans;

  let checked = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    const next = rng(seed);
    const slices: number[] = [];
    for (let i = 0; i < text.length; i += 1) slices.push(1 + Math.floor(next() * 11));
    const emitted = stream(text, secrets, slices);
    // 1. The whole-text equality.
    expect(emitted.join("")).toBe(whole);
    // 2. Every sequence still starts and ends where it did — no cut reshaped
    //    one, and no substitution moved a column.
    expect(escapeScan(emitted.join("")).spans).toEqual(wholeSpans);
    // 3. No piece handed to a consumer ends inside a sequence, except the last
    //    (and this text ends outside one, so not even that).
    for (const piece of emitted) expect(escapeScan(piece).pending).toBe(-1);
    checked += 1;
  }
  // A count the skipped/absent state cannot produce.
  expect(checked).toBe(200);
  for (const secret of secrets) expect(whole).not.toContain(secret);
  expect(whole).toHaveLength(text.length);
});

// ── the small pieces, asserted directly ──────────────────────────────────────

test("escapeScan reads the sequence shapes a PTY actually emits", () => {
  expect(escapeScan(`${CSI}0m`).spans).toEqual([[0, 4]]);
  expect(escapeScan(`${CSI}38;5;196m`).spans).toEqual([[0, 11]]);
  expect(escapeScan(`${CSI}?25l`).spans).toEqual([[0, 6]]);
  expect(escapeScan(`${OSC}0;title${BEL}`).spans).toEqual([[0, 10]]);
  // ST rather than BEL.
  expect(escapeScan(`${OSC}0;title\x1b\\`).spans).toEqual([[0, 11]]);
  // Two-character sequences: save cursor, reverse index, charset select.
  expect(escapeScan("\x1b7").spans).toEqual([[0, 2]]);
  expect(escapeScan("\x1bM").spans).toEqual([[0, 2]]);
  expect(escapeScan("\x1b(B").spans).toEqual([[0, 3]]);
  // Incomplete: the text ends before the final byte / terminator.
  expect(escapeScan(`${CSI}1;3`).pending).toBe(0);
  expect(escapeScan(`ab${OSC}0;ti`).pending).toBe(2);
  expect(escapeScan(`ab${OSC}0;ti\x1b`).pending).toBe(2);
  // An ESC that cannot begin a sequence is one ordinary character, not a span.
  expect(escapeScan("\x1b\x01ab").spans).toEqual([]);
  expect(escapeScan("\x1b\x01ab").pending).toBe(-1);
});

test("pendingSecretPrefix holds exactly the tail that could still become a secret", () => {
  const secrets = order(["ABCD", "ABCDEFGH"]);
  expect(pendingSecretPrefix("xx", secrets)).toBe(0);
  expect(pendingSecretPrefix("xxA", secrets)).toBe(1);
  expect(pendingSecretPrefix("xxABCDEF", secrets)).toBe(6);
  // A complete secret is not a prefix of itself: it is ready to be masked.
  expect(pendingSecretPrefix("xxABCDEFGH", secrets)).toBe(0);
  // `ABCD` is complete, but it is also a proper prefix of the longer one, so it
  // must be held — this is the leak case, read off the helper directly.
  expect(pendingSecretPrefix("xxABCD", secrets)).toBe(4);
  expect(pendingSecretPrefix("anything", [])).toBe(0);
});

test("a stream with no secrets is passed through byte for byte", () => {
  const text = `${CSI}1;1H${OSC}0;t${BEL}plain ${CSI}31mred${CSI}0m\r\n$ `;
  const emitted = stream(text, [], [1, 3, 5, 2, 9, 4]);
  expect(emitted.join("")).toBe(text);
  // And with nothing to hold back, nothing is held: the last push empties the
  // carry, so end() has nothing left to flush.
  expect(emitted.join("")).toHaveLength(text.length);
});
