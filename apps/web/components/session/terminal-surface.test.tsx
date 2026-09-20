/**
 * THE SURFACE, MOUNTED, AGAINST A FAKE HOST AND A REAL XTERM.JS.
 *
 * WHAT IS AND IS NOT CHECKED HERE, stated rather than implied:
 *
 *   - CHECKED: that a shell is asked for exactly once, that a running one is
 *     re-adopted instead of a second being opened, that a terminal ending is
 *     reported without ever reading as "finished", and that the emulator is
 *     refused — with a sentence — where a PTY would be a lie.
 *   - NOT CHECKED, and cannot be from here: that an IMAGE renders. The image
 *     addon decodes on a canvas and a worker, and this environment has neither
 *     — `@xterm/addon-webgl` does not even load (no WebGL2), which this file
 *     relies on to exercise the fallback path. So the assertion below is that
 *     the addon ACTIVATED, which is observable, and the acceptance criterion
 *     for a drawn image is the owner's own `fastfetch` in a real tab.
 *
 * `right-panel.chooser.test.tsx` explains why a DOM is registered per file.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TERMINAL_IMAGE_OPTIONS, TerminalSurface } from "./terminal-surface";
import type { LiveTerminal, TerminalChunk, TerminalEnding, TerminalOpenRequest } from "@/lib/terminal-bridge";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Fake = {
  opens: TerminalOpenRequest[];
  kills: string[];
  writes: Array<{ id: string; data: string }>;
  resizes: Array<{ id: string; cols: number; rows: number }>;
  push: (chunk: TerminalChunk) => void;
  end: (ending: TerminalEnding) => void;
};

function installBridge(options: { live?: LiveTerminal[]; openId?: string; ending?: TerminalEnding } = {}): Fake {
  const opens: TerminalOpenRequest[] = [];
  const kills: string[] = [];
  const writes: Array<{ id: string; data: string }> = [];
  const resizes: Array<{ id: string; cols: number; rows: number }> = [];
  const data: Array<(chunk: TerminalChunk) => void> = [];
  const exits: Array<(ending: TerminalEnding) => void> = [];
  const terminal = {
    open: async (request: TerminalOpenRequest) => {
      opens.push(request);
      if (options.ending) return { id: "term_failed", ending: options.ending };
      return { id: options.openId ?? "term_new", pid: 4242 };
    },
    write: async (id: string, payload: string) => {
      writes.push({ id, data: payload });
      return { ok: true };
    },
    resize: async (id: string, cols: number, rows: number) => {
      resizes.push({ id, cols, rows });
      return { ok: true };
    },
    kill: async (id: string) => {
      kills.push(id);
      return { ok: true };
    },
    list: async () => ({ terminals: options.live ?? [] }),
    onData: (listener: (chunk: TerminalChunk) => void) => {
      data.push(listener);
      return () => data.splice(data.indexOf(listener), 1);
    },
    onExit: (listener: (ending: TerminalEnding) => void) => {
      exits.push(listener);
      return () => exits.splice(exits.indexOf(listener), 1);
    },
  };
  (window as unknown as { telarDesktop?: unknown }).telarDesktop = { terminal };
  return {
    opens,
    kills,
    writes,
    resizes,
    push: (chunk) => data.forEach((listener) => listener(chunk)),
    end: (ending) => exits.forEach((listener) => listener(ending)),
  };
}

let mounted: Root | undefined;

/** The engine, answering the one question this surface asks it: where the
 *  session's checkout is. Stubbed rather than left to fail so the cwd handed to
 *  the host is something this file can assert. */
const CHECKOUT = "/Users/someone/code/telar";
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ listing: { workspacePath: CHECKOUT, repository: true, files: [], source: "git", truncated: false, readAt: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
});

afterEach(() => {
  const root = mounted;
  mounted = undefined;
  if (root) act(() => root.unmount());
  globalThis.fetch = realFetch;
  delete (window as unknown as { telarDesktop?: unknown }).telarDesktop;
});

/** Mounted, then flushed: the surface asks the engine for a cwd and the host
 *  for a shell, and both are promises. */
async function mount(props: Parameters<typeof TerminalSurface>[0] = {}): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => {
    root.render(<TerminalSurface {...props} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

describe("without the desktop shell", () => {
  test("it says why there is no terminal instead of drawing an empty one", async () => {
    const host = await mount();
    // A blank black box would read as a shell that has not printed yet.
    expect(host.textContent).toContain("desktop shell");
    expect(host.textContent).toContain("this Mac");
  });
});

describe("opening a shell", () => {
  test("one mount asks for exactly one shell, and remembers its id on the tab", async () => {
    const bridge = installBridge({ openId: "term_a" });
    const remembered: string[] = [];
    await mount({ sessionId: "session_a", onTerminalId: (id) => remembered.push(id) });

    // TWO would be the real defect: the panel unmounts this surface on every
    // tab switch, so a second `open` per glance is a shell per glance.
    expect(bridge.opens.length).toBe(1);
    expect(remembered).toEqual(["term_a"]);
    // Remembering the id is what makes the NEXT mount an adoption rather than
    // another spawn — so this assertion is load-bearing for the one above.
  });

  test("the emulator's own size is what the PTY is told, so SIGWINCH is not a guess", async () => {
    const bridge = installBridge({ openId: "term_a" });
    await mount({ sessionId: "session_a" });
    expect(bridge.opens[0]?.cols).toBeGreaterThan(0);
    expect(bridge.opens[0]?.rows).toBeGreaterThan(0);
  });

  test("the shell starts in the session's checkout, not wherever Electron was launched", async () => {
    const bridge = installBridge({ openId: "term_a" });
    await mount({ sessionId: "session_a" });
    expect(bridge.opens[0]?.cwd).toBe(CHECKOUT);
  });

  test("an engine that cannot answer still gets you a terminal", async () => {
    // Refusing to open a shell because a directory lookup was slow would be a
    // worse failure than landing in the wrong directory.
    globalThis.fetch = (async () => {
      throw new Error("engine away");
    }) as typeof fetch;
    const bridge = installBridge({ openId: "term_a" });
    await mount({ sessionId: "session_a" });
    expect(bridge.opens.length).toBe(1);
    expect(bridge.opens[0]?.cwd).toBeUndefined();
  });

  test("a spawn that never started is reported as never started", async () => {
    installBridge({ ending: { id: "term_failed", fate: "failed", error: "ENOENT" } });
    const host = await mount({ sessionId: "session_a" });
    expect(host.textContent).toContain("never started");
  });
});

describe("re-adopting a running shell", () => {
  test("a terminal the host still lists is adopted, not replaced", async () => {
    const bridge = installBridge({ live: [{ id: "term_old", pid: 99 }] });
    await mount({ sessionId: "session_a", terminalId: "term_old" });
    // The whole point of W1's `list()`: no second spawn, and the first shell is
    // not left running with nobody reading it.
    expect(bridge.opens).toEqual([]);
    expect(bridge.kills).toEqual([]);
  });

  test("a terminal that has since died is replaced rather than left blank", async () => {
    const bridge = installBridge({ live: [], openId: "term_new" });
    await mount({ sessionId: "session_a", terminalId: "term_gone" });
    expect(bridge.opens.length).toBe(1);
  });
});

describe("what a terminal's ending is allowed to say", () => {
  test("`unknown` never reads as finished, and is marked as the warning it is", async () => {
    const bridge = installBridge({ openId: "term_a" });
    const host = await mount({ sessionId: "session_a" });

    await act(async () => {
      bridge.end({ id: "term_a", fate: "unknown", pid: 7777, reason: "a kill was never observed (pid 7777)" });
    });

    expect(host.textContent).toContain("lost track");
    expect(host.textContent).toContain("7777");
    // The one thing it must not be able to say.
    expect(host.textContent).not.toContain("exited");
  });

  test("an observed exit says so, plainly", async () => {
    const bridge = installBridge({ openId: "term_a" });
    const host = await mount({ sessionId: "session_a" });
    await act(async () => {
      bridge.end({ id: "term_a", fate: "exited", exitCode: 0 });
    });
    expect(host.textContent).toContain("Shell exited.");
  });

  test("another terminal's ending is not this tab's", async () => {
    const bridge = installBridge({ openId: "term_a" });
    const host = await mount({ sessionId: "session_a" });
    await act(async () => {
      bridge.end({ id: "term_b", fate: "exited", exitCode: 1 });
    });
    expect(host.textContent).not.toContain("Shell exited");
  });
});

describe("closing the surface", () => {
  test("unmounting does NOT kill the shell — a tab switch is not a goodbye", async () => {
    const bridge = installBridge({ openId: "term_a" });
    await mount({ sessionId: "session_a" });
    const root = mounted;
    mounted = undefined;
    act(() => root?.unmount());
    // Killing here would end a half-typed command because somebody looked at
    // the Diff. `endTerminalForTab` is what ends it, from the cockpit that can
    // tell a switch from a close.
    expect(bridge.kills).toEqual([]);
  });
});

describe("image protocols", () => {
  test("SIXEL and iTerm2 IIP are on, and size reports with them", async () => {
    // IIP is the one that matters: the owner's `~/.zshrc` runs
    // `fastfetch --logo-type iterm`, and the logo's scaling needs CSI 16 t.
    expect(TERMINAL_IMAGE_OPTIONS.sixelSupport).toBe(true);
    expect(TERMINAL_IMAGE_OPTIONS.iipSupport).toBe(true);
    expect(TERMINAL_IMAGE_OPTIONS.enableSizeReports).toBe(true);
  });

  test("there is no kitty switch to set, because the addon implements no kitty", async () => {
    /**
     * The brief for this work said to turn kitty OFF and to call it "alpha
     * upstream, deliberately not enabled". Both halves are wrong at
     * `@xterm/addon-image@0.9.0` and this test is where that is recorded:
     * the addon's README describes it as "Inline image output in xterm.js.
     * Supports SIXEL and iTerm's inline image protocol (IIP)", its options
     * carry no kitty key, and its `src/` contains no kitty handler. What the
     * README calls ALPHA is IIP — the protocol we depend on.
     *
     * Asserted against the installed package rather than written in a comment,
     * so the day the addon grows kitty support this test fails and somebody has
     * to make the decision on purpose.
     */
    const options = Object.keys(TERMINAL_IMAGE_OPTIONS);
    expect(options.some((key) => key.toLowerCase().includes("kitty"))).toBe(false);
    const typings = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/@xterm/addon-image/typings/addon-image.d.ts"),
      "utf8",
    );
    expect(typings).toContain("sixelSupport");
    expect(typings).toContain("iipSupport");
    expect(typings.toLowerCase()).not.toContain("kitty");
  });

  test("loading the addon really does turn the size reports on", async () => {
    /**
     * NOT A RESTATEMENT OF THE OPTIONS OBJECT. `windowOptions` is `{}` on a
     * bare terminal and carries three `true`s once the addon has ACTIVATED, so
     * this distinguishes "the addon is in the bundle" from "the addon ran" —
     * which is as far as this environment can go, since decoding needs a canvas
     * it does not have.
     */
    const { Terminal } = await import("@xterm/xterm");
    const { ImageAddon } = await import("@xterm/addon-image");

    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    /**
     * CLEARED FIRST, and that is not cheating — it is the only honest way to
     * read this. xterm's `windowOptions` DEFAULT IS ONE SHARED OBJECT across
     * instances, so once any addon anywhere in this process has activated, a
     * freshly-constructed terminal already reports the flags set. Comparing a
     * "bare" terminal against a loaded one therefore measured nothing but test
     * order. Clearing this instance's own copy makes the before/after a fact
     * about this addon activating.
     */
    term.options.windowOptions = {};
    expect(term.options.windowOptions?.getCellSizePixels ?? false).toBe(false);

    term.loadAddon(new ImageAddon(TERMINAL_IMAGE_OPTIONS));
    expect(term.options.windowOptions?.getCellSizePixels).toBe(true);
    expect(term.options.windowOptions?.getWinSizePixels).toBe(true);
  });
});
