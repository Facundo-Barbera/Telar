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
import type { LiveTerminal, TerminalActivity, TerminalChunk, TerminalEnding, TerminalOpenRequest } from "@/lib/terminal-bridge";
import type { RunView } from "@/lib/run/types";
import {
  activateShell,
  addShell,
  emptyWorkspace,
  nextShellId,
  readWorkspace,
  setShellTerminal,
  terminalIds,
  upsertRunShell,
  workspaceParams,
  TERMINAL_ID_PARAM,
} from "@/lib/terminal-workspace";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Fake = {
  opens: TerminalOpenRequest[];
  kills: string[];
  closes: string[];
  writes: Array<{ id: string; data: string }>;
  resizes: Array<{ id: string; cols: number; rows: number }>;
  push: (chunk: TerminalChunk) => void;
  end: (ending: TerminalEnding) => void;
};

function installBridge(
  options: { live?: LiveTerminal[]; openId?: string; ending?: TerminalEnding; activity?: TerminalActivity[] } = {},
): Fake {
  const opens: TerminalOpenRequest[] = [];
  const kills: string[] = [];
  const closes: string[] = [];
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
    // `active` and `close` only when the test says what the host would answer:
    // without them the bridge is a desktop build older than the question,
    // which closes without asking and ends a shell with `kill`.
    ...(options.activity
      ? {
          active: async (ids?: string[]) => ({ terminals: options.activity!.filter((entry) => !ids || ids.includes(entry.id)) }),
          close: async (id: string) => {
            closes.push(id);
            return { ok: true };
          },
        }
      : {}),
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
    closes,
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

/** The params a tab carries after N shells were left open on it — written in
 *  the workspace's own vocabulary rather than by hand, so these tests break if
 *  the encoding moves. */
function restored(...terminals: string[]): Record<string, string> {
  let state = emptyWorkspace();
  for (const terminal of terminals) {
    const id = nextShellId(state);
    state = setShellTerminal(addShell(state, id), id, terminal);
  }
  return workspaceParams(activateShell(state, state.shells[0]!.id));
}

/** The strip's chips — `role="tab"`, which is also what tells this apart from
 *  the close button beside each one. */
function tabs(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll('[role="tablist"][aria-label="Terminal tabs"] [role="tab"]')] as HTMLElement[];
}

/** The "open a shell in your home folder instead" action, by what it says. */
function retry(host: HTMLElement): HTMLButtonElement | null {
  return ([...host.querySelectorAll("button")] as HTMLButtonElement[]).find((button) => button.textContent?.includes("home folder")) ?? null;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** A chord at the surface's own box. The strip handles these on the CAPTURE
 *  phase, before xterm's handler and before the cockpit's window listener. */
async function press(host: HTMLElement, key: string, options: { shiftKey?: boolean; code?: string; metaKey?: boolean } = {}): Promise<void> {
  const target = (host.querySelector('[role="tablist"]')?.parentElement ?? host) as HTMLElement;
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code: options.code ?? "",
        metaKey: options.metaKey ?? true,
        shiftKey: options.shiftKey ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
    const written: Array<Record<string, string>> = [];
    await mount({ sessionId: "session_a", onParams: (params) => written.push(params) });

    // TWO would be the real defect: the panel unmounts this surface on every
    // tab switch, so a second `open` per glance is a shell per glance.
    expect(bridge.opens.length).toBe(1);
    // Remembering the id is what makes the NEXT mount an adoption rather than
    // another spawn — so this assertion is load-bearing for the one above.
    expect(terminalIds(readWorkspace(written[written.length - 1] ?? {}))).toEqual(["term_a"]);
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

describe("a cwd the host refuses (#851)", () => {
  /** The exact shape `unusableCwd` writes in apps/desktop/terminal-host.js —
   *  what makes this refusal, and not some other `failed` reason, detectable
   *  from the renderer's side of the IPC. */
  const CWD_REFUSAL = {
    id: "term_failed",
    fate: "failed" as const,
    error: "Telar cannot start a terminal in /private/tmp/exoplanets: ENOENT (no such file or directory). No process was started.",
  };

  test("the refusal is the tab's whole content — no xterm underneath it", async () => {
    installBridge({ ending: CWD_REFUSAL });
    const host = await mount({ sessionId: "session_a" });

    expect(host.textContent).toContain("never started");
    // The bug this fixes: a blank white xterm canvas under the banner, with
    // nothing to do. There must be no emulator mounted at all for this fate.
    expect(host.querySelector(".xterm")).toBeNull();
    // Found by what it SAYS, not by being the first button on screen — the
    // strip above it has a chip and a `+` of its own now.
    expect(retry(host)).not.toBeNull();
    expect(retry(host)?.textContent).toContain("home folder");
  });

  test("the action retries the same tab with no cwd, so the host falls back to the shell's own default", async () => {
    const bridge = installBridge({ ending: CWD_REFUSAL });
    const host = await mount({ sessionId: "session_a" });
    expect(bridge.opens.length).toBe(1);
    expect(bridge.opens[0]?.cwd).toBe(CHECKOUT);

    await click(retry(host) as HTMLButtonElement);

    expect(bridge.opens.length).toBe(2);
    // Omitted entirely, not sent as `cwd: undefined` — the host's own
    // fallback is triggered by the key being absent, not by its value.
    expect("cwd" in (bridge.opens[1] ?? {})).toBe(false);
  });

  test("a `failed` ending that is not about the cwd keeps today's banner instead", async () => {
    installBridge({ ending: { id: "term_failed", fate: "failed", error: "spawn /bin/nope ENOENT" } });
    const host = await mount({ sessionId: "session_a" });

    expect(host.textContent).toContain("never started");
    // No way forward is offered for a reason that isn't about the directory —
    // there is nothing this shell can retry that would fix it.
    expect(retry(host)).toBeNull();
  });
});

describe("re-adopting a running shell", () => {
  test("a terminal the host still lists is adopted, not replaced", async () => {
    const bridge = installBridge({ live: [{ id: "term_old", pid: 99 }] });
    // In the vocabulary a tab written by the PREVIOUS build carries, which the
    // workspace reads as one shell on that PTY.
    await mount({ sessionId: "session_a", params: { [TERMINAL_ID_PARAM]: "term_old" } });
    // The whole point of W1's `list()`: no second spawn, and the first shell is
    // not left running with nobody reading it.
    expect(bridge.opens).toEqual([]);
    expect(bridge.kills).toEqual([]);
  });

  test("a terminal that has since died is replaced rather than left blank", async () => {
    const bridge = installBridge({ live: [], openId: "term_new" });
    await mount({ sessionId: "session_a", params: { [TERMINAL_ID_PARAM]: "term_gone" } });
    expect(bridge.opens.length).toBe(1);
  });

  test("a tab restored with three shells re-adopts all three, and opens nothing", async () => {
    const bridge = installBridge({ live: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] });
    const host = await mount({ sessionId: "session_a", params: restored("t1", "t2", "t3") });
    expect(bridge.opens).toEqual([]);
    expect(tabs(host).length).toBe(3);
  });
});

/**
 * THE INNER STRIP — the whole of what this change is for. Three shells live in
 * ONE outer Terminal tab, and the gestures are the Browser's: `+`, a close per
 * chip, ⌘T / ⌘W / ⌘1–9.
 */
describe("the strip of shells", () => {
  test("one chip per shell, and the strip is a tablist of its own", async () => {
    installBridge({ live: [{ id: "t1" }, { id: "t2" }] });
    const host = await mount({ sessionId: "session_a", params: restored("t1", "t2") });
    expect(host.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Terminal tabs");
    expect(tabs(host).map((tab) => tab.textContent)).toEqual(["Shell 1", "Shell 2"]);
    // The LAST restored shell is not the active one — the first is, so the
    // strip you come back to reads left to right.
    expect(tabs(host)[0]?.getAttribute("aria-selected")).toBe("true");
  });

  test("+ opens one more shell, in the session's checkout, and selects it", async () => {
    const bridge = installBridge({ live: [{ id: "t1" }], openId: "t2" });
    const host = await mount({ sessionId: "session_a", params: restored("t1") });
    expect(bridge.opens.length).toBe(0);

    await click(host.querySelector('button[aria-label="New shell"]') as HTMLButtonElement);

    expect(bridge.opens.length).toBe(1);
    // The same `startingDirectory` the first shell uses.
    expect(bridge.opens[0]?.cwd).toBe(CHECKOUT);
    expect(tabs(host).length).toBe(2);
    expect(tabs(host)[1]?.getAttribute("aria-selected")).toBe("true");
  });

  test("closing a chip ends that shell and focuses its neighbour", async () => {
    const bridge = installBridge({ live: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] });
    const host = await mount({ sessionId: "session_a", params: restored("t1", "t2", "t3") });

    // Select the middle one, then close it: the NEIGHBOUR takes focus, not the
    // first chip — the eye does not jump the strip on every close.
    await click(tabs(host)[1] as HTMLButtonElement);
    await click(host.querySelector('button[aria-label="Close Shell 2"]') as HTMLButtonElement);

    expect(bridge.kills).toEqual(["t2"]);
    expect(tabs(host).length).toBe(2);
    expect(tabs(host)[1]?.getAttribute("aria-selected")).toBe("true");
  });

  test("an inactive pane is MOUNTED and hidden, because unmounting is what drops scrollback", async () => {
    installBridge({ live: [{ id: "t1" }, { id: "t2" }] });
    const host = await mount({ sessionId: "session_a", params: restored("t1", "t2") });

    const panes = [...host.querySelectorAll('[data-testid="terminal-pane"]')];
    // BOTH are in the document — the host forwards bytes and does not record
    // them, so a pane that came back would arrive with an empty screen over a
    // live shell.
    expect(panes.length).toBe(2);
    expect(panes.map((pane) => pane.getAttribute("data-active"))).toEqual(["true", "false"]);
    expect(panes[1]?.className).toContain("hidden");
    // Each one has its own emulator, so the bytes of one shell cannot arrive
    // in the other's screen.
    expect(host.querySelectorAll('[data-testid="terminal-host"]').length).toBe(2);
  });
});

describe("the strip's keys", () => {
  test("Cmd+T opens a shell, Cmd+2 selects the second, Cmd+W closes the active one", async () => {
    const bridge = installBridge({ live: [{ id: "t1" }], openId: "t2" });
    const host = await mount({ sessionId: "session_a", params: restored("t1") });

    await press(host, "t");
    expect(bridge.opens.length).toBe(1);
    expect(tabs(host).length).toBe(2);

    await press(host, "1");
    expect(tabs(host)[0]?.getAttribute("aria-selected")).toBe("true");
    await press(host, "2");
    expect(tabs(host)[1]?.getAttribute("aria-selected")).toBe("true");

    await press(host, "w");
    expect(tabs(host).length).toBe(1);
    expect(bridge.kills).toEqual(["t2"]);
  });

  test("Cmd+Shift+] and Cmd+Shift+[ walk the strip, wrapping at both ends", async () => {
    installBridge({ live: [{ id: "t1" }, { id: "t2" }] });
    const host = await mount({ sessionId: "session_a", params: restored("t1", "t2") });

    await press(host, "}", { shiftKey: true, code: "BracketRight" });
    expect(tabs(host)[1]?.getAttribute("aria-selected")).toBe("true");
    await press(host, "}", { shiftKey: true, code: "BracketRight" });
    expect(tabs(host)[0]?.getAttribute("aria-selected")).toBe("true");
    await press(host, "{", { shiftKey: true, code: "BracketLeft" });
    expect(tabs(host)[1]?.getAttribute("aria-selected")).toBe("true");
  });

  /**
   * THE ONE THAT CROSSES THE BOUNDARY. A Terminal with no shells in it is a
   * blank pane with a `+`, so the last ⌘W is the gesture that closes the OUTER
   * tab — which only the panel can do, and only because the surface asks.
   */
  test("Cmd+W on the LAST shell asks the panel to close the outer tab", async () => {
    const bridge = installBridge({ live: [{ id: "t1" }] });
    let asked = 0;
    const host = await mount({ sessionId: "session_a", params: restored("t1"), onCloseSelf: () => (asked += 1) });

    await press(host, "w");
    expect(bridge.kills).toEqual(["t1"]);
    expect(asked).toBe(1);
  });

  test("a key the strip does not own is left for the shell", async () => {
    const bridge = installBridge({ live: [{ id: "t1" }, { id: "t2" }] });
    const host = await mount({ sessionId: "session_a", params: restored("t1", "t2") });
    // No ninth shell to select, and no modifier at all: neither may move the
    // strip, or a `9` typed at a prompt would switch tabs.
    await press(host, "9");
    await press(host, "t", { metaKey: false });
    expect(tabs(host).length).toBe(2);
    expect(bridge.opens).toEqual([]);
  });
});

describe("what a terminal's ending is allowed to say", () => {
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

/**
 * CLOSE = KILL, AND THE QUESTION BEFORE IT ("Run = a new terminal").
 *
 * The host is asked whether anything is running; a busy terminal is closed
 * only on a yes, an idle one without a word — and a RUN's chip is no longer
 * the exception that closes without ending anything.
 */
describe("closing a chip ends its terminal", () => {
  const realConfirm = window.confirm;
  afterEach(() => {
    window.confirm = realConfirm;
  });

  /** Records every question, answering with `answer`. */
  function stubConfirm(answer: boolean): string[] {
    const asked: string[] = [];
    window.confirm = ((message?: string) => (asked.push(String(message)), answer)) as typeof window.confirm;
    return asked;
  }

  test("an idle shell closes without asking", async () => {
    const bridge = installBridge({ live: [{ id: "t1" }, { id: "t2" }], activity: [{ id: "t2", active: false, processes: 0 }] });
    const asked = stubConfirm(false);
    const host = await mount({ sessionId: "session_a", params: restored("t1", "t2") });

    await click(host.querySelector('button[aria-label="Close Shell 2"]') as HTMLButtonElement);

    expect(asked).toEqual([]);
    expect(bridge.closes).toEqual(["t2"]);
    expect(tabs(host).length).toBe(1);
  });

  test("a busy shell asks in plain words, and no keeps it open and running", async () => {
    const bridge = installBridge({
      live: [{ id: "t1" }, { id: "t2" }],
      activity: [{ id: "t2", active: true, processes: 3, command: "bun test --watch" }],
    });
    const asked = stubConfirm(false);
    const host = await mount({ sessionId: "session_a", params: restored("t1", "t2") });

    await click(host.querySelector('button[aria-label="Close Shell 2"]') as HTMLButtonElement);

    expect(asked[0]).toStartWith("End “bun test --watch” (3 processes)?");
    expect(bridge.closes).toEqual([]);
    expect(tabs(host).length).toBe(2);

    stubConfirm(true);
    await click(host.querySelector('button[aria-label="Close Shell 2"]') as HTMLButtonElement);
    expect(bridge.closes).toEqual(["t2"]);
    expect(tabs(host).length).toBe(1);
  });

  test("closing a run's chip ends the run through the engine, as the person", async () => {
    const run: RunView = {
      terminalId: "term_run",
      runId: "term_run",
      projectId: "project_1",
      sessionId: "session_a",
      origin: "run",
      title: "web dev #2",
      configId: "cfg_web",
      configName: "web dev",
      command: "bun run dev",
      worktreePath: CHECKOUT,
      cwd: CHECKOUT,
      status: "ready",
      readiness: { kind: "none" },
      startedAt: 1,
      env: [],
    };
    const posted: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") posted.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("/run/status")) return Response.json({ terminals: [run] });
      if (url.includes("/run/configs")) return Response.json({ configurations: [] });
      if (url.includes("/run/stop")) return Response.json({ ...run, status: "closed", closedBy: "person" });
      if (url.includes("/run/")) return new Response("", { status: 404 });
      return Response.json({ listing: { workspacePath: CHECKOUT, repository: true, files: [], source: "git", truncated: false, readAt: 1 } });
    }) as typeof fetch;
    const bridge = installBridge({ live: [{ id: "t1" }], activity: [{ id: "term_run", active: true, processes: 4 }] });
    const asked = stubConfirm(true);
    const params = workspaceParams(
      upsertRunShell(readWorkspace(restored("t1")), { runId: "term_run", configId: "cfg_web", terminalId: "term_run", title: "web dev #2" }),
    );
    const host = await mount({ sessionId: "session_a", params });

    await click(host.querySelector('button[aria-label="Close web dev #2"]') as HTMLButtonElement);

    // What the person launched, not what the process table calls it.
    expect(asked[0]).toStartWith("End “bun run dev” (4 processes)?");
    const stop = posted.find((entry) => entry.url.includes("/run/stop"));
    // No `closedBy`: an absent one is the person, which is who pressed it.
    expect(stop?.body).toEqual({ terminalId: "term_run" });
    // The engine owns a run's terminal; the host is not asked to close it.
    expect(bridge.closes).toEqual([]);
    expect(tabs(host).map((tab) => tab.textContent)).toEqual(["Shell 1"]);
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
    // the Diff. `closeTerminalTab` is what ends it, from the cockpit that can
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

describe("resize is one fit per frame, and one SIGWINCH per grid change", () => {
  /** rAF stubbed to a queue this test drains by hand, so "inside one frame"
   *  and "the frame paints" are facts the test controls rather than timing. */
  let queued: Array<FrameRequestCallback> = [];
  const realRaf = window.requestAnimationFrame;
  const realCancel = window.cancelAnimationFrame;
  beforeEach(() => {
    queued = [];
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued.push(cb);
      return queued.length;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((handle: number) => {
      queued[handle - 1] = () => {};
    }) as typeof window.cancelAnimationFrame;
  });
  afterEach(() => {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCancel;
  });
  const paint = () => {
    const frame = queued.splice(0);
    for (const cb of frame) cb(performance.now());
  };

  test("five resize signals in one frame fit once and signal the PTY at most once", async () => {
    const fake = installBridge();
    await mount({ sessionId: "s1" });
    await act(async () => {
      paint();
    });
    const before = fake.resizes.length;
    await act(async () => {
      for (let i = 0; i < 5; i += 1) window.dispatchEvent(new Event("telar:panel-resized"));
    });
    // Nothing has painted yet: the burst is queued, not sent.
    expect(fake.resizes.length).toBe(before);
    await act(async () => {
      paint();
    });
    // One frame, at most one SIGWINCH — and zero if the grid did not move,
    // which in a headless box it does not. The failure state (no coalescing)
    // produced FIVE here, which is the storm nvim could not keep up with.
    expect(fake.resizes.length - before).toBeLessThanOrEqual(1);
  });

  test("a frame that leaves cols and rows unchanged sends no SIGWINCH", async () => {
    const fake = installBridge();
    await mount({ sessionId: "s1" });
    await act(async () => {
      paint();
    });
    const settled = fake.resizes.length;
    await act(async () => {
      window.dispatchEvent(new Event("telar:panel-resized"));
      paint();
      window.dispatchEvent(new Event("telar:panel-resized"));
      paint();
    });
    expect(fake.resizes.length).toBe(settled);
  });
});
