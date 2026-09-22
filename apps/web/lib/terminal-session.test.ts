/**
 * THE WIRING, AGAINST A REAL XTERM.JS — not a stub of one.
 *
 * WHAT MAKES THESE NON-VACUOUS, because the obvious version of each is not:
 *
 *   - "the text appeared" is satisfied by an emulator that IGNORED the escape
 *     sequence around it, which is the failure a rendering surface actually
 *     has. So these read the buffer's CELL ATTRIBUTES — the colour index, the
 *     bold flag — and check a plain cell right beside the coloured one has
 *     neither, so a parser that dropped SGR entirely fails both halves.
 *   - "the key handler ran" is satisfied by a handler that fires and swallows
 *     the byte. So the assertion is the OCTET arriving at the host's `write`.
 *
 * The terminal is never `open()`ed: the parser and the buffer are what is under
 * test, and they do not need a canvas. That is also why this runs in the plain
 * suite rather than needing a browser.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { TerminalBridge, TerminalChunk, TerminalEnding } from "@/lib/terminal-bridge";
import { attachTerminal, gridMeasurer, terminalKeyHandler } from "@/lib/terminal-session";

/**
 * A DOM for this file only, registered at module scope and handed back in
 * `afterAll` — the shape `right-panel.chooser.test.tsx` documents. Handing it
 * back is not tidiness: the suite shares a process and the registrator refuses
 * a second registration, so a file that keeps one makes whichever file runs
 * next fail on its own first line.
 */
GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** xterm.js reaches for `document` at import, so the DOM has to exist first —
 *  it never touches one after that, which is why `open()` is not needed. */
let Terminal: typeof import("@xterm/xterm").Terminal;
beforeAll(async () => {
  ({ Terminal } = await import("@xterm/xterm"));
});

type Recorded = { writes: Array<{ id: string; data: string }> };

function fakeBridge(): Pick<TerminalBridge, "write" | "onData" | "onExit"> &
  Recorded & { push: (chunk: TerminalChunk) => void; end: (ending: TerminalEnding) => void } {
  const writes: Array<{ id: string; data: string }> = [];
  const data: Array<(chunk: TerminalChunk) => void> = [];
  const exits: Array<(ending: TerminalEnding) => void> = [];
  return {
    writes,
    write: async (id, payload) => {
      writes.push({ id, data: payload });
      return { ok: true };
    },
    onData: (listener) => {
      data.push(listener);
      return () => data.splice(data.indexOf(listener), 1);
    },
    onExit: (listener) => {
      exits.push(listener);
      return () => exits.splice(exits.indexOf(listener), 1);
    },
    push: (chunk) => data.forEach((listener) => listener(chunk)),
    end: (ending) => exits.forEach((listener) => listener(ending)),
  };
}

/** `write` is asynchronous inside xterm; its callback is when the buffer has
 *  actually moved. */
function settled(term: InstanceType<typeof Terminal>, bytes: string): Promise<void> {
  return new Promise((resolve) => term.write(bytes, () => resolve()));
}

describe("bytes from the PTY reach the emulator's buffer", () => {
  test("an SGR-coloured run lands as ATTRIBUTES, not as text that happens to say RED", async () => {
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    const bridge = fakeBridge();
    const detach = attachTerminal(term, bridge, "t1");

    bridge.push({ id: "t1", data: "\u001b[1;31mRED\u001b[0m plain" });
    await settled(term, "");

    const line = term.buffer.active.getLine(0);
    const coloured = line?.getCell(0);
    // ANSI red is palette index 1; bold is a flag, not a colour.
    expect(coloured?.getFgColor()).toBe(1);
    expect(coloured?.isBold()).toBeTruthy();

    // THE HALF THAT MAKES IT A TEST: a cell outside the run carries neither, so
    // an emulator that printed the escape sequences as text — or dropped them
    // and painted everything plain — fails here even though "RED" is on screen
    // in both cases.
    const plain = line?.getCell(5);
    expect(plain?.getFgColor()).toBe(-1);
    expect(plain?.isBold()).toBeFalsy();
    expect(line?.translateToString(true)).toBe("RED plain");

    detach();
  });

  test("truecolour survives, which is what the owner's prompt is made of", async () => {
    // oh-my-posh catppuccin_frappe emits 24-bit SGR and never touches the
    // sixteen-colour palette — so a terminal that folded truecolour down to the
    // nearest ANSI index would draw his prompt in the wrong colours.
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    const bridge = fakeBridge();
    const detach = attachTerminal(term, bridge, "t1");

    bridge.push({ id: "t1", data: "\u001b[38;2;140;170;238mP\u001b[0m" });
    await settled(term, "");

    const cell = term.buffer.active.getLine(0)?.getCell(0);
    expect(cell?.isFgRGB()).toBeTruthy();
    expect(cell?.getFgColor()).toBe((140 << 16) | (170 << 8) | 238);

    detach();
  });

  test("Neovim's short colon truecolour lands as the colour Neovim meant", async () => {
    // Neovim 0.12 writes `38:2:R:G:B` — ISO 8613-6 with the colour-space slot
    // omitted. xterm.js 6.0.0 reads that as `38:2:CS:R:G` + a missing B, so
    // every colour in an nvim window lost its red and went olive. Measured
    // against the real emulator: this is the exact sequence captured from the
    // owner's nvim (tokyonight-moon's comment grey on its background).
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    const bridge = fakeBridge();
    const detach = attachTerminal(term, bridge, "t1");

    bridge.push({ id: "t1", data: "\u001b[38:2:120:126:147m\u001b[48:2:20:21:32mA\u001b[0m" });
    // And the SAME colour in the two forms xterm already handles, so the test
    // is about equality with the emulator's own reading, not about our numbers.
    bridge.push({ id: "t1", data: "\u001b[38;2;120;126;147mB\u001b[0m\u001b[38:2::120:126:147mC\u001b[0m" });
    await settled(term, "");

    const line = term.buffer.active.getLine(0);
    const a = line?.getCell(0);
    expect(a?.isFgRGB()).toBeTruthy();
    expect(a?.getFgColor()).toBe((120 << 16) | (126 << 8) | 147);
    expect(a?.getBgColor()).toBe((20 << 16) | (21 << 8) | 32);
    expect(line?.getCell(1)?.getFgColor()).toBe(a?.getFgColor());
    expect(line?.getCell(2)?.getFgColor()).toBe(a?.getFgColor());

    detach();
  });

  test("a truecolour sequence split across two PTY chunks is still read whole", async () => {
    // node-pty hands over whatever the kernel had, so `ESC[38:2:120:` can end
    // one chunk and `126:147m` start the next. A rewrite that only saw the
    // first half would leave that one colour wrong — and nvim repaints a
    // screen in many chunks.
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    const bridge = fakeBridge();
    const detach = attachTerminal(term, bridge, "t1");

    bridge.push({ id: "t1", data: "x\u001b[38:2:120:" });
    bridge.push({ id: "t1", data: "126:147mA\u001b[0m" });
    await settled(term, "");

    const line = term.buffer.active.getLine(0);
    expect(line?.translateToString(true)).toBe("xA");
    expect(line?.getCell(1)?.getFgColor()).toBe((120 << 16) | (126 << 8) | 147);

    detach();
  });

  test("an iTerm inline image without `size=` reaches the emulator with it filled in", async () => {
    // fastfetch's `--logo-type iterm` sends `File=inline=1;width=45;...` and no
    // `size`; @xterm/addon-image aborts on that header, so the owner's logo
    // reserved fourteen rows and drew nothing. Asserted on the bytes handed to
    // the emulator, split across chunks the way a PTY delivers a 100 KB
    // payload: a one-pixel PNG, base64, as three pieces.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const seq = `\u001b]1337;File=inline=1;width=45;height=14;preserveAspectRatio=0:${png}\u0007`;
    const written: string[] = [];
    const term = { write: (data: string) => written.push(data), onData: () => ({ dispose: () => {} }) };
    const bridge = fakeBridge();
    const detach = attachTerminal(term, bridge, "t1");

    bridge.push({ id: "t1", data: `before ${seq.slice(0, 40)}` });
    bridge.push({ id: "t1", data: seq.slice(40, 90) });
    bridge.push({ id: "t1", data: `${seq.slice(90)} after` });

    const all = written.join("");
    const pngBytes = Buffer.from(png, "base64").length;
    expect(all).toBe(`before \u001b]1337;File=size=${pngBytes};inline=1;width=45;height=14;preserveAspectRatio=0:${png}\u0007 after`);
    // Nothing was written before the terminator arrived: a half image is not a
    // thing the emulator can be handed.
    expect(written[0]).toBe("before ");

    // A header that already says its size is left exactly as it was.
    written.length = 0;
    bridge.push({ id: "t1", data: `\u001b]1337;File=size=${pngBytes};inline=1:${png}\u0007` });
    expect(written.join("")).toBe(`\u001b]1337;File=size=${pngBytes};inline=1:${png}\u0007`);

    detach();
  });

  test("a cursor-position sequence moves the cursor — the buffer is a screen, not a log", async () => {
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    const bridge = fakeBridge();
    const detach = attachTerminal(term, bridge, "t1");

    // CUP to row 3, column 5, then a character. A log pane would print the
    // escape and leave the text on line 0.
    bridge.push({ id: "t1", data: "\u001b[3;5HX" });
    await settled(term, "");

    expect(term.buffer.active.getLine(2)?.translateToString(true)).toBe("    X");
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("");

    detach();
  });

  test("another terminal's bytes are not drawn in this one", async () => {
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    const bridge = fakeBridge();
    const detach = attachTerminal(term, bridge, "mine");

    bridge.push({ id: "theirs", data: "NOT MINE" });
    bridge.push({ id: "mine", data: "mine" });
    await settled(term, "");

    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("mine");
    detach();
  });

  test("detaching stops the channel — a disposed tab cannot be written into", async () => {
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    const bridge = fakeBridge();
    attachTerminal(term, bridge, "t1")();

    bridge.push({ id: "t1", data: "after" });
    await settled(term, "");
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("");
  });

  test("an ending is reported once, for this terminal only", async () => {
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    const bridge = fakeBridge();
    const seen: TerminalEnding[] = [];
    const detach = attachTerminal(term, bridge, "t1", (ending) => seen.push(ending));

    bridge.end({ id: "other", fate: "exited", exitCode: 0 });
    bridge.end({ id: "t1", fate: "unknown", pid: 42, reason: "not vouched for" });
    expect(seen).toEqual([{ id: "t1", fate: "unknown", pid: 42, reason: "not vouched for" }]);

    detach();
  });
});

describe("keys the shell must not lose", () => {
  /** A keydown with the two calls the handler has to make, recorded. */
  function keydown(init: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean }>) {
    const calls = { prevented: 0, stopped: 0 };
    return {
      event: {
        type: "keydown",
        ...init,
        preventDefault: () => {
          calls.prevented += 1;
        },
        stopPropagation: () => {
          calls.stopped += 1;
        },
      },
      calls,
    };
  }

  test("^W reaches the host as 0x17, exactly once", () => {
    const bridge = fakeBridge();
    const handle = terminalKeyHandler((bytes) => void bridge.write("t1", bytes));
    const { event, calls } = keydown({ key: "w", ctrlKey: true });

    // `false` is what stands xterm's own encoder down. Returning `true` here
    // would send the byte TWICE — once from us, once from xterm.
    expect(handle(event)).toBe(false);
    expect(bridge.writes).toEqual([{ id: "t1", data: "\u0017" }]);
    /**
     * `stopPropagation` IS THE ONE THAT MATTERS and is asserted on its own.
     * `useCommandKeys` listens on `window` at the end of the bubble chain and
     * never consults `defaultPrevented`, so a handler that only prevented the
     * default would let `^R` fire whatever a person had bound it to while their
     * shell sat waiting for a history search.
     */
    expect(calls.stopped).toBe(1);
    expect(calls.prevented).toBe(1);
  });

  test("^R reaches the host as 0x12", () => {
    const bridge = fakeBridge();
    terminalKeyHandler((bytes) => void bridge.write("t1", bytes))(keydown({ key: "r", ctrlKey: true }).event);
    expect(bridge.writes).toEqual([{ id: "t1", data: "\u0012" }]);
  });

  test("Escape reaches the host as 0x1b", () => {
    const bridge = fakeBridge();
    terminalKeyHandler((bytes) => void bridge.write("t1", bytes))(keydown({ key: "Escape" }).event);
    expect(bridge.writes).toEqual([{ id: "t1", data: "\u001b" }]);
  });

  test("every other key is xterm's, untouched and uncancelled", () => {
    const bridge = fakeBridge();
    const handle = terminalKeyHandler((bytes) => void bridge.write("t1", bytes));
    for (const init of [{ key: "a" }, { key: "Enter" }, { key: "c", ctrlKey: true }, { key: "w", metaKey: true }]) {
      const { event, calls } = keydown(init);
      expect(handle(event)).toBe(true);
      expect(calls.stopped).toBe(0);
      expect(calls.prevented).toBe(0);
    }
    expect(bridge.writes).toEqual([]);
  });

  test("keyup is not a press — the byte is not sent twice per stroke", () => {
    const bridge = fakeBridge();
    const handle = terminalKeyHandler((bytes) => void bridge.write("t1", bytes));
    expect(handle({ type: "keyup", key: "w", ctrlKey: true })).toBe(true);
    expect(bridge.writes).toEqual([]);
  });
});

/**
 * ONE FIT PER FRAME, FOR BOTH PANES — issues #825 and #909.
 *
 * WHAT IS BEING COUNTED AND WHY IT IS COUNTED RATHER THAN OBSERVED. A fit
 * reflows the whole scrollback (3000 lines) on the main thread and a resize
 * SIGWINCHes a live process, so "it ended up the right size" is true of the
 * version that froze the cockpit as well as of this one. The number of fits
 * and the number of signals ARE the behaviour.
 *
 * THE FRAME QUEUE IS DRIVEN BY HAND. "Three notifications in one frame" is
 * only a statable claim when the test owns the frame — and nothing here waits
 * on a real clock, which a test of a coalescer must not do: a sleep long
 * enough to be reliable is long enough to hide the coalescing it is checking.
 */
describe("the measurer both terminal panes share", () => {
  /** rAF, owned by this file. `paint()` is the browser deciding to draw. */
  function frames() {
    const queued = new Map<number, () => void>();
    let next = 1;
    const real = { request: window.requestAnimationFrame, cancel: window.cancelAnimationFrame };
    window.requestAnimationFrame = ((callback: (time: number) => void) => {
      const id = next++;
      queued.set(id, () => callback(0));
      return id;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => {
      queued.delete(id);
    }) as typeof window.cancelAnimationFrame;
    return {
      paint: () => {
        const due = [...queued.values()];
        queued.clear();
        for (const run of due) run();
      },
      restore: () => {
        window.requestAnimationFrame = real.request;
        window.cancelAnimationFrame = real.cancel;
      },
    };
  }

  /** An emulator and a fit addon, in the only two facts that matter here: how
   *  many times it was fitted, and what grid the box gave it. */
  function emulator(box = { cols: 80, rows: 24 }) {
    const term = { cols: 0, rows: 0 };
    const state = { fits: 0, refuse: false, box };
    return {
      state,
      term,
      fittable: {
        term,
        fit: {
          fit: () => {
            state.fits += 1;
            // What FitAddon does on a hidden pane or a panel mid-animation.
            if (state.refuse) throw new Error("no grid in a zero-sized box");
            term.cols = state.box.cols;
            term.rows = state.box.rows;
          },
        },
      },
    };
  }

  function measurerOn(pane: ReturnType<typeof emulator>) {
    const signalled: Array<{ cols: number; rows: number }> = [];
    return { signalled, ...gridMeasurer(() => pane.fittable, (grid) => signalled.push(grid)) };
  }

  test("three notifications in one frame are ONE fit and ONE resize", () => {
    const clock = frames();
    const pane = emulator();
    const { measure, signalled } = measurerOn(pane);

    // The burst a chip leaving `display:none` produces, or a panel drag: the
    // ResizeObserver fires, the drag announces itself, the reveal re-measures.
    measure();
    measure();
    measure();
    // Nothing has happened yet — that is the coalescing, not a missing call.
    expect(pane.state.fits).toBe(0);

    clock.paint();
    expect(pane.state.fits).toBe(1);
    expect(signalled).toEqual([{ cols: 80, rows: 24 }]);
    clock.restore();
  });

  test("a notification that leaves the grid where it was sends no resize", () => {
    const clock = frames();
    const pane = emulator();
    const { measure, signalled } = measurerOn(pane);

    measure();
    clock.paint();
    expect(signalled).toHaveLength(1);

    // A drag that moved the box by four pixels. The emulator is re-fitted —
    // that is what tells us the grid did not move — and the PTY is left alone.
    measure();
    clock.paint();
    expect(pane.state.fits).toBe(2);
    expect(signalled).toHaveLength(1);

    // ...and a box that really did change a cell is still signalled, so the
    // guard above is a guard rather than a resize that stopped happening.
    pane.state.box = { cols: 100, rows: 24 };
    measure();
    clock.paint();
    expect(signalled).toEqual([
      { cols: 80, rows: 24 },
      { cols: 100, rows: 24 },
    ]);
    clock.restore();
  });

  test("a box with no grid in it signals nothing, and does not poison the next measurement", () => {
    const clock = frames();
    const pane = emulator();
    const { measure, signalled } = measurerOn(pane);

    pane.state.refuse = true;
    measure();
    clock.paint();
    expect(signalled).toEqual([]);

    // Revealed. Nothing was remembered from the refusal, so the first real
    // grid is news — a hidden pane that came back silent is the bug this half
    // guards against.
    pane.state.refuse = false;
    measure();
    clock.paint();
    expect(signalled).toEqual([{ cols: 80, rows: 24 }]);
    clock.restore();
  });

  test("an unmount cancels the frame it queued, so a disposed emulator is never fitted", () => {
    const clock = frames();
    const pane = emulator();
    const { measure, cancel, signalled } = measurerOn(pane);

    measure();
    cancel();
    clock.paint();

    expect(pane.state.fits).toBe(0);
    expect(signalled).toEqual([]);
    clock.restore();
  });

  test("a pane whose refs are gone is read, not assumed", () => {
    const clock = frames();
    const signalled: Array<{ cols: number; rows: number }> = [];
    // What `termRef.current && fitRef.current` answers between the dispose and
    // the frame that was already queued.
    const { measure } = gridMeasurer(() => undefined, (grid) => signalled.push(grid));

    measure();
    clock.paint();
    expect(signalled).toEqual([]);
    clock.restore();
  });
});
