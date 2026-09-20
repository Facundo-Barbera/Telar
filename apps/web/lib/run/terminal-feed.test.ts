/**
 * A RUN'S BYTES, AGAINST A REAL XTERM.JS — not a stub of one.
 *
 * WHY THIS IS NOT "THE TEXT APPEARED". A surface that stripped every escape
 * sequence on the way in still shows the words; what it loses is the thing that
 * makes it a terminal rather than a `<pre>`, and the words are there either
 * way. So these push a run's answer through the real emulator and read the
 * buffer's CELL ATTRIBUTES and CURSOR POSITION back — a parser that dropped SGR
 * and `CSI H` fails both, and a `<pre>` cannot pass either.
 *
 * AND WHY THE RESET RULE IS TESTED AT ALL. A terminal is stateful in a way a
 * list of lines is not: appending one run's bytes to a buffer that holds
 * another's does not look broken, it looks like the first run printed something
 * it never printed. `byteFeed` is the one decision that prevents it, so it is
 * checked in BOTH directions — the same buffer, one answer that continues it
 * and one that does not.
 *
 * The terminal is never `open()`ed: the parser and the buffer are what is under
 * test and they do not need a canvas — the same shape `lib/terminal-session.test.ts`
 * uses, for the same reason.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { byteDroppedNotice, byteFeed } from "./terminal-feed";

/** A DOM for this file only, handed back in `afterAll`: the suite shares a
 *  process and the registrator refuses a second registration, so a file that
 *  keeps one makes whichever file runs next fail on its own first line. */
GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** xterm.js reaches for `document` at import, so the DOM has to exist first. */
let Terminal: typeof import("@xterm/xterm").Terminal;
beforeAll(async () => {
  ({ Terminal } = await import("@xterm/xterm"));
});

/** `write` is asynchronous inside xterm; its callback is when the buffer has
 *  actually moved. */
function settled(term: InstanceType<typeof Terminal>, bytes: string): Promise<void> {
  return new Promise((resolve) => term.write(bytes, () => resolve()));
}

/** One poll, applied the way `RunTerminal` applies it. */
async function feed(term: InstanceType<typeof Terminal>, previous: number, answer: { chunks: string[]; cursor: number; dropped: number }) {
  const next = byteFeed(previous, answer);
  if (next.reset) term.reset();
  if (next.text) await settled(term, next.text);
  return next.cursor;
}

describe("a run's bytes reach the emulator as a terminal, not as text", () => {
  test("an SGR run lands as ATTRIBUTES and `CSI H` moves the cursor", async () => {
    const term = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    // Chunked exactly as the engine's ring hands them over — each one whole,
    // written in order. A surface that only worked on the concatenation would
    // be relying on something the poll does not promise.
    await feed(term, 0, { chunks: ["\u001b[1;31mFAIL", "\u001b[0m ok", "\u001b[3;5H"], cursor: 3, dropped: 0 });

    const line = term.buffer.active.getLine(0);
    // ANSI red is palette index 1; bold is a flag, not a colour.
    expect(line?.getCell(0)?.getFgColor()).toBe(1);
    expect(line?.getCell(0)?.isBold()).toBeTruthy();
    // THE HALF THAT MAKES IT A TEST: the cell after the reset carries neither,
    // so a parser that dropped SGR entirely fails both directions at once.
    expect(line?.getCell(5)?.getFgColor()).not.toBe(1);
    expect(line?.getCell(5)?.isBold()).toBeFalsy();

    // And the cursor went where it was told — `CSI 3;5H` is row 3, column 5,
    // one-based on the wire and zero-based in the buffer. A `<pre>` would have
    // drawn the characters `3;5H` instead.
    expect(term.buffer.active.cursorY).toBe(2);
    expect(term.buffer.active.cursorX).toBe(4);
  });

  test("a masked secret occupies the columns its value did", async () => {
    // The engine replaces a secret with one mask cell per character precisely
    // so a positioned screen keeps its layout (#819). This is that promise read
    // off a real grid rather than off a string.
    const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
    await feed(term, 0, { chunks: ["key=••••••••|"], cursor: 1, dropped: 0 });
    const line = term.buffer.active.getLine(0);
    expect(line?.getCell(4)?.getChars()).toBe("•");
    // The pipe after the mask sits where it would have sat after the value.
    expect(line?.getCell(12)?.getChars()).toBe("|");
  });
});

describe("whether this is the same stream we were drawing", () => {
  test("a continuing poll appends and a cursor that went backwards resets", async () => {
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    let cursor = await feed(term, 0, { chunks: ["first run\r\n"], cursor: 1, dropped: 0 });
    expect(cursor).toBe(1);

    // The ordinary case: more of the same run, appended.
    cursor = await feed(term, cursor, { chunks: ["still going\r\n"], cursor: 2, dropped: 0 });
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("first run");
    expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe("still going");

    // A restart mints a new run whose bytes start at zero. Appending them would
    // show two processes' output as one, which does not LOOK wrong — that is
    // the whole reason this rule exists rather than being noticed on screen.
    await feed(term, cursor, { chunks: ["second run\r\n"], cursor: 1, dropped: 0 });
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("second run");
    expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe("");
  });

  test("the ring dropping past where we were is a gap, and a gap resets too", async () => {
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    const cursor = await feed(term, 0, { chunks: ["early\r\n"], cursor: 1, dropped: 0 });

    // The engine discarded chunks 0..4 while we were at 1: what it hands back
    // is not contiguous with what is on screen. Splicing it in would put a hole
    // in the middle of a screen without saying so.
    await feed(term, cursor, { chunks: ["much later\r\n"], cursor: 9, dropped: 5 });
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("much later");

    // THE CONTROL, and it is the same shape with the drop behind us: a `dropped`
    // that has not caught up appends as normal. Without this, a `reset: true`
    // constant would pass the case above.
    const after = byteFeed(9, { chunks: ["more\r\n"], cursor: 10, dropped: 5 });
    expect(after.reset).toBe(false);
  });

  test("an answer with nothing new writes nothing and keeps the cursor moving", () => {
    // Most polls against a settled run look exactly like this, and a feed that
    // reset or re-drew on them would flicker the screen every few seconds.
    const idle = byteFeed(7, { chunks: [], cursor: 7, dropped: 0 });
    expect(idle).toEqual({ reset: false, text: "", cursor: 7 });
  });
});

describe("the dropped notice", () => {
  test("says something only when something was actually dropped", () => {
    expect(byteDroppedNotice(0)).toBeUndefined();
    expect(byteDroppedNotice(12)).toContain("no longer kept");
  });
});
