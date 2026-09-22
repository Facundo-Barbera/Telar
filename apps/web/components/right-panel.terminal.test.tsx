/**
 * THE TERMINAL SURFACE SURVIVES A GLANCE AT ANOTHER TAB — issue #909.
 *
 * THE MULTIPLIER, AND WHY IT IS MEASURED IN CONSTRUCTIONS. The panel rendered
 * only its active tab, so every switch away unmounted the whole Terminal
 * surface and every return built it again: a fresh `Terminal` per shell, each
 * with a new WebGL context and glyph atlas, the host's terminal re-adopted, and
 * a run's whole byte window replayed into an empty buffer. None of that is
 * visible in the finished screen — it looks the same once it has arrived — so
 * what this file counts is how many emulators were built and how many shells
 * were asked for, which is the cost the owner was waiting through.
 *
 * `term.open()` IS THE COUNTER. It is called exactly once per `Terminal` this
 * app constructs (terminal-surface.tsx `createTerminal`), it is on the public
 * prototype, and unlike the constructor it cannot be reached by an instance
 * that was never mounted into a document.
 *
 * WHAT IS NOT CLAIMED HERE: that the emulator DRAWS after the reveal. There is
 * no canvas in this environment — `right-panel.suspense.test.tsx` and
 * `session/terminal-surface.test.tsx` both say so — and the acceptance for the
 * pixels is the owner's own tab.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RightPanel, type PanelTabItem } from "./right-panel";
import type { TerminalOpenRequest } from "@/lib/terminal-bridge";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every emulator this panel put into the document, counted on the prototype so
 *  a second construction anywhere in the tree is visible from out here. */
let opened = 0;
let restoreOpen: (() => void) | undefined;

beforeAll(async () => {
  // Dynamic for the reason `lib/run/terminal-feed.test.ts` gives: xterm reaches
  // for `document` as it loads. The module is the one the surface uses.
  const { Terminal } = await import("@xterm/xterm");
  const original = Terminal.prototype.open;
  Terminal.prototype.open = function patched(this: unknown, element: HTMLElement) {
    opened += 1;
    return (original as (element: HTMLElement) => void).call(this, element);
  };
  restoreOpen = () => {
    Terminal.prototype.open = original;
  };
});

afterAll(() => {
  restoreOpen?.();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const CHECKOUT = "/Users/someone/code/telar";
const realFetch = globalThis.fetch;

/** The one question the Terminal asks the engine (where to start), and an empty
 *  answer for everything the Diff asks. */
function stubEngine() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/files"))
      return Response.json({ listing: { workspacePath: CHECKOUT, repository: true, files: [], source: "git", truncated: false, readAt: 1 } });
    return Response.json({});
  }) as typeof fetch;
}

type Host = { opens: TerminalOpenRequest[]; kills: string[] };

/** The desktop shell's terminal host. Without one the surface draws a sentence
 *  instead of an emulator, and this file would be counting nothing. */
function installBridge(): Host {
  const opens: TerminalOpenRequest[] = [];
  const kills: string[] = [];
  let next = 0;
  const terminal = {
    open: async (request: TerminalOpenRequest) => {
      opens.push(request);
      next += 1;
      return { id: `term_${next}`, pid: 4200 + next };
    },
    write: async () => ({ ok: true }),
    resize: async () => ({ ok: true }),
    kill: async (id: string) => {
      kills.push(id);
      return { ok: true };
    },
    list: async () => ({ terminals: [] }),
    // Nothing in this file reads a byte: what it counts is how many emulators
    // were built, which is settled before the first one arrives.
    onData: () => () => {},
    onExit: () => () => {},
  };
  (window as unknown as { telarDesktop?: unknown }).telarDesktop = { terminal };
  return { opens, kills };
}

const tab = (id: string, kind: string, params: Record<string, string> = {}): PanelTabItem => ({ id, kind, params }) as PanelTabItem;

let mounted: Root | undefined;
let host: HTMLElement | undefined;

beforeEach(() => {
  opened = 0;
  stubEngine();
});

afterEach(() => {
  const root = mounted;
  mounted = undefined;
  if (root) act(() => root.unmount());
  host?.remove();
  host = undefined;
  globalThis.fetch = realFetch;
  delete (window as unknown as { telarDesktop?: unknown }).telarDesktop;
});

/** A quiet moment — long enough for a frame, when there are frames. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function show(tabs: PanelTabItem[], active: string | undefined) {
  if (!mounted) {
    host = document.createElement("div");
    document.body.append(host);
    mounted = createRoot(host);
  }
  const root = mounted;
  act(() => {
    root.render(
      <RightPanel
        sessionId="session_a"
        projectId="project_a"
        tabs={tabs}
        {...(active ? { tab: active } : {})}
        onTabChange={() => {}}
        onOpenTab={() => {}}
        onCloseTab={() => {}}
        onClose={() => {}}
      />,
    );
  });
}

/**
 * Quiet moments until `done`, or until the budget runs out — the shape
 * `right-panel.suspense.test.tsx` uses, and for its reason: the surface arrives
 * behind a real `next/dynamic` chunk, and how many milliseconds that takes is a
 * property of the machine rather than a number to write down. It returns as
 * soon as the condition holds, so nothing here sleeps through a timer.
 */
async function until(done: () => boolean, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (!done() && Date.now() < deadline) await act(async () => void (await settle()));
  return done();
}

/** The emulator's own host element, by the test id the pane gives it. */
const emulators = () => (host ? host.querySelectorAll('[data-testid="terminal-pane"]') : []);

describe("a Terminal you have opened stays mounted behind the tab you look at next", () => {
  test("switching away and back does not build a second emulator", async () => {
    const bridge = installBridge();
    const tabs = [tab("terminal", "terminal"), tab("diff", "diff")];

    show(tabs, "terminal");
    expect(await until(() => opened > 0)).toBe(true);
    // One shell, one emulator: the baseline the two counts below are about.
    expect(opened).toBe(1);
    expect(bridge.opens).toHaveLength(1);
    const pane = emulators()[0];
    expect(pane).toBeDefined();

    show(tabs, "diff");
    await until(() => false, 100);

    show(tabs, "terminal");
    await until(() => false, 100);

    // THE REGRESSION. Before this, the return built a second `Terminal` — new
    // GL context, new glyph atlas — re-adopted the host's terminal and replayed
    // the run's window into it, every time.
    expect(opened).toBe(1);
    expect(bridge.opens).toHaveLength(1);
    // The same NODE, not merely a node of the same shape: a remount is a new
    // element, and a new element is a new emulator whatever the counts say.
    expect(emulators()[0]).toBe(pane);
  });

  test("while another tab is showing, the Terminal is hidden rather than gone", async () => {
    installBridge();
    const tabs = [tab("terminal", "terminal"), tab("diff", "diff")];

    show(tabs, "terminal");
    expect(await until(() => opened > 0)).toBe(true);

    show(tabs, "diff");
    await until(() => false, 100);

    // `display:none`, which is what keeps the WebGL context and the scrollback
    // alive — and what takes nine live textareas out of the tab order.
    const kept = emulators()[0] as HTMLElement | undefined;
    expect(kept).toBeDefined();
    expect(kept?.closest("[hidden],.hidden")).not.toBe(null);
  });

  test("a Terminal tab nobody has opened mounts nothing — no shell is spawned for a glance never taken", async () => {
    const bridge = installBridge();
    // The layout a reload restores: a Terminal in the strip, the Diff on
    // screen. Mounting every terminal tab in the strip would adopt — or, when
    // the host no longer holds those PTYs, SPAWN — a shell per tab per load.
    show([tab("diff", "diff"), tab("terminal", "terminal")], "diff");
    await until(() => false, 200);

    expect(opened).toBe(0);
    expect(bridge.opens).toHaveLength(0);
  });

  test("closing the tab lets the surface go", async () => {
    installBridge();
    const tabs = [tab("terminal", "terminal"), tab("diff", "diff")];

    show(tabs, "terminal");
    expect(await until(() => opened > 0)).toBe(true);

    // Kept means kept for as long as the tab exists — not for ever. The shells
    // themselves are ended by the cockpit's own close (`endTerminalForTab`),
    // which is the only place that can tell a close from a switch.
    show([tab("diff", "diff")], "diff");
    await until(() => emulators().length === 0, 1_000);

    expect(emulators()).toHaveLength(0);
  });
});
