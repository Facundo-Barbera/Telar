/**
 * A RUN'S WINDOW, WRITTEN SO XTERM CAN YIELD INSIDE IT — issue #909.
 *
 * THE DEFECT WAS NOT WHAT REACHED THE SCREEN, which is why nothing about the
 * buffer can state it. `chunks.join("")` draws the same characters as the
 * chunks written in order — the engine cuts them at redactor boundaries, so no
 * sequence straddles one. What differs is the COST: xterm's `WriteBuffer`
 * checks its 12 ms yield budget between write ITEMS and never inside one, so a
 * joined window is one uninterrupted parse of up to 256 KB followed by a
 * reflow of 3000 lines, with the click that opened the chip queued behind all
 * of it. The owner's report — "opening the Terminal freezes everything for
 * seconds while a Run is executing" — is that one string.
 *
 * So the assertion is about the CALLS, not the cells: what this file counts is
 * how many items the emulator was handed and what was in each. It watches
 * `Terminal.prototype.write` because that is the one door
 * `lib/terminal-session.ts`'s writer goes through, and it is the same door for
 * both feeds — the bridge's attach and the hop's poll each read the run from
 * the top and each used to join.
 *
 * `right-panel.chooser.test.tsx` explains why a DOM is registered per file.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunPane } from "./run-pane";
import type { RunApi } from "@/lib/run/api";
import type { RunBytesAnswer } from "@/lib/run/types";
import type { TerminalChunk } from "@/lib/terminal-bridge";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Everything handed to an emulator in this file, in order. The patch is on the
 *  PROTOTYPE, so it covers the instance the pane builds for itself — which is
 *  the only one there is a way to reach from out here. */
let written: string[] = [];
let restoreWrite: (() => void) | undefined;

beforeAll(async () => {
  // Imported dynamically for the reason `lib/run/terminal-feed.test.ts` states:
  // xterm reaches for `document` as it loads, so the DOM has to exist first.
  // The module is already resolved by then, so this is the same class object
  // the pane writes through rather than a second copy of it.
  const { Terminal } = await import("@xterm/xterm");
  const original = Terminal.prototype.write;
  Terminal.prototype.write = function patched(this: unknown, data: string | Uint8Array, callback?: () => void) {
    written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    return (original as (data: string | Uint8Array, callback?: () => void) => void).call(this, data, callback);
  };
  restoreWrite = () => {
    Terminal.prototype.write = original;
  };
});

afterAll(() => {
  restoreWrite?.();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

let mounted: Root | undefined;

beforeEach(() => {
  written = [];
});

afterEach(() => {
  const root = mounted;
  mounted = undefined;
  if (root) act(() => root.unmount());
  delete (window as unknown as { telarDesktop?: unknown }).telarDesktop;
});

/** The engine's run door, answering the one question a pane asks on attach.
 *  Every resize it is told about is kept: a run's SIGWINCH goes over the hop
 *  like everything else a renderer may not do itself. */
function runDoor(answer: RunBytesAnswer): RunApi & { resizes: Array<{ cols: number; rows: number }> } {
  const resizes: Array<{ cols: number; rows: number }> = [];
  return {
    resizes,
    bytes: async () => answer,
    write: async () => ({ delivered: true }),
    resize: async (_session: string, options: { cols: number; rows: number }) => {
      resizes.push({ cols: options.cols, rows: options.rows });
      return { resized: true };
    },
  } as unknown as RunApi & { resizes: Array<{ cols: number; rows: number }> };
}

/** The desktop shell, holding a run's terminal open for adoption. Installed
 *  only by the STREAM tests: its absence is what puts a pane on the poll. */
function installBridge(): { push: (chunk: TerminalChunk) => void } {
  const listeners: Array<(chunk: TerminalChunk) => void> = [];
  const terminal = {
    open: async () => ({ id: "term_run" }),
    write: async () => ({ ok: true }),
    resize: async () => ({ ok: true }),
    kill: async () => ({ ok: true }),
    list: async () => ({ terminals: [] }),
    adopt: async () => ({ ok: true }),
    abandon: async () => ({ ok: true }),
    onData: (listener: (chunk: TerminalChunk) => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    onExit: () => () => {},
  };
  (window as unknown as { telarDesktop?: unknown }).telarDesktop = { terminal };
  return { push: (chunk) => listeners.forEach((listener) => listener(chunk)) };
}

/** Mounted, then flushed: the attach adopts and reads, and both are promises. */
async function mount(props: Partial<Parameters<typeof RunPane>[0]> & { api: RunApi }): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => {
    root.render(<RunPane sessionId="session_a" runId="run_a" live={false} active visible {...props} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

/** A window the size of the report: enough chunks that joining them is a parse
 *  nobody can interrupt, written here as three so the assertion stays readable.
 *  The engine's own ceiling is 4000 chunks / 256 KB per run. */
const WINDOW = ["first line\r\n", "second line\r\n", "third line\r\n"];

describe("the scrollback a chip attaches to", () => {
  test("over the bridge: one write per chunk, and never the joined window", async () => {
    installBridge();
    await mount({ api: runDoor({ chunks: WINDOW, cursor: 3, dropped: 0 }), terminalId: "term_run" });

    // THE REGRESSION, STATED AS THE NUMBER IT IS: three chunks are three items
    // for xterm to yield between, not one item three times as long.
    expect(written).toEqual(WINDOW);
    expect(written).not.toContain(WINDOW.join(""));
  });

  test("over the hop: the poll's first tick reads the same window and cuts it the same way", async () => {
    // No bridge — `runFeedKind` puts this pane on the poll, which reads from
    // cursor 0 on its first tick. A settled run then stops asking, so nothing
    // here waits on a timer.
    await mount({ api: runDoor({ chunks: WINDOW, cursor: 3, dropped: 0 }) });

    expect(written).toEqual(WINDOW);
    expect(written).not.toContain(WINDOW.join(""));
  });

  test("nothing is fitted or SIGWINCHed before a frame — the pane is on the shared measurer", async () => {
    /**
     * THE SECOND CAUSE, FROM THE PANE'S SIDE (#909). `RunPane` was written from
     * the file that predated #825's coalescing, so it fitted and resized
     * synchronously on every ResizeObserver notification — and a chip leaving
     * `display:none` fires several in one frame, each reflowing 3000 lines and
     * each SIGWINCHing a live dev server. `lib/terminal-session.test.ts` states
     * the rule; this says this pane really is the thing obeying it.
     *
     * The frames are the test's, so "before a frame" is a state to sit in
     * rather than a race to win — and nothing here sleeps.
     */
    const queued: Array<() => void> = [];
    const real = { request: window.requestAnimationFrame, cancel: window.cancelAnimationFrame };
    window.requestAnimationFrame = ((callback: (time: number) => void) => queued.push(() => callback(0))) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;
    try {
      const api = runDoor({ chunks: WINDOW, cursor: 3, dropped: 0 });
      await mount({ api, terminalId: "term_run" });
      // Mounting measures — on reveal, and again when the fonts land — and not
      // one of those has reached the engine.
      expect(api.resizes).toEqual([]);

      // THE OTHER HALF, or the assertion above would hold just as well for a
      // pane that never measured at all: when the frame comes, exactly one
      // grid is reported for the several notifications behind it.
      await act(async () => {
        for (const run of queued.splice(0)) {
          try {
            run();
          } catch {
            // xterm queues frames of its own and there is no canvas here to
            // draw into. Only the measurer's frame is this file's business.
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(api.resizes).toHaveLength(1);
      expect(api.resizes[0]?.cols).toBeGreaterThan(0);
      expect(api.resizes[0]?.rows).toBeGreaterThan(0);
    } finally {
      window.requestAnimationFrame = real.request;
      window.cancelAnimationFrame = real.cancel;
    }
  });

  test("a frame that arrives after the join is its own write too", async () => {
    const bridge = installBridge();
    await mount({ api: runDoor({ chunks: WINDOW, cursor: 3, dropped: 0 }), terminalId: "term_run", live: true });

    await act(async () => {
      bridge.push({ id: "term_run", data: "fourth line\r\n", cursor: 4 });
      bridge.push({ id: "term_run", data: "fifth line\r\n", cursor: 5 });
    });

    expect(written).toEqual([...WINDOW, "fourth line\r\n", "fifth line\r\n"]);
  });
});
