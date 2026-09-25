/**
 * SETTINGS → LINKS, END TO END ON THE PAGE'S SIDE.
 *
 * The setting never worked for two reasons, and each has a test here:
 *
 *   1. Transcript links were Streamdown's `<button>`s behind its own dialog,
 *      with no `href` for the cockpit's click handler — so with the setting on
 *      a link must render as a real anchor, and with it off keep the gate.
 *   2. Every link the page did not catch became a popup, decided in the
 *      desktop shell's main process, which never saw the setting — so the page
 *      must mirror it there (`claimLinks` → `telarDesktop.links`) and route
 *      what the shell hands back. The shell's half is
 *      `apps/desktop/link-routing.test.js`.
 *
 * The shell bridge is a fixture: it records what the page told it and lets the
 * test play the main process handing a link back.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { claimLinks, openInSystemBrowser, useLinkPolicy } = await import("./link-policy");
const { MessageResponse } = await import("@/components/ui/message");

const KEY = "telar:open-links-in-session-browser";

type Shell = { routing: boolean[]; external: string[]; handBack(url: string): void; listeners: number };

function installShell(): Shell {
  const listeners = new Set<(payload: { url?: unknown }) => void>();
  const shell: Shell = {
    routing: [],
    external: [],
    handBack: (url) => listeners.forEach((listener) => listener({ url })),
    get listeners() {
      return listeners.size;
    },
  };
  (window as unknown as { telarDesktop: unknown }).telarDesktop = {
    links: {
      setRouting: async (on: boolean) => {
        shell.routing.push(on);
        return { ok: true };
      },
      onOpen: (listener: (payload: { url?: unknown }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    browser: {
      openExternal: async (url: string) => {
        shell.external.push(url);
        return { ok: true };
      },
    },
  };
  return shell;
}

/** Flip the setting the way the Settings row does. */
function Toggle({ to, onReady }: { to: boolean; onReady: (flip: () => void) => void }) {
  const { setOpenInSessionBrowser } = useLinkPolicy();
  onReady(() => setOpenInSessionBrowser(to));
  return null;
}

function flip(to: boolean) {
  const host = document.createElement("div");
  const root = createRoot(host);
  let run = () => {};
  act(() => root.render(<Toggle to={to} onReady={(flipIt) => (run = flipIt)} />));
  act(() => run());
  act(() => root.unmount());
}

beforeEach(() => {
  window.localStorage.clear();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  delete (window as unknown as { telarDesktop?: unknown }).telarDesktop;
});

describe("the desktop shell sees the setting", () => {
  test("a cockpit claiming links with the setting ON tells the shell to route them here", () => {
    const shell = installShell();
    window.localStorage.setItem(KEY, "1");
    const release = claimLinks(() => {});
    expect(shell.routing.at(-1)).toBe(true);
    release();
    expect(shell.routing.at(-1)).toBe(false);
  });

  test("with the setting OFF the shell keeps sending links to the system browser", () => {
    const shell = installShell();
    const release = claimLinks(() => {});
    expect(shell.routing.at(-1)).toBe(false);
    expect(shell.listeners).toBe(0);
    release();
  });

  test("flipping the setting while a cockpit is mounted updates the shell both ways", () => {
    const shell = installShell();
    const release = claimLinks(() => {});
    flip(true);
    expect(shell.routing.at(-1)).toBe(true);
    flip(false);
    expect(shell.routing.at(-1)).toBe(false);
    release();
  });

  test("a link the shell hands back opens through the cockpit's router", () => {
    const shell = installShell();
    window.localStorage.setItem(KEY, "1");
    const routed: string[] = [];
    const release = claimLinks((href) => routed.push(href));
    shell.handBack("https://example.com/docs");
    expect(routed).toEqual(["https://example.com/docs"]);
    expect(shell.external).toEqual([]);
    release();
    expect(shell.listeners).toBe(0);
  });

  test("releasing an older claim does not clear a newer cockpit's", () => {
    const shell = installShell();
    window.localStorage.setItem(KEY, "1");
    const routed: string[] = [];
    const releaseOld = claimLinks(() => routed.push("old"));
    const releaseNew = claimLinks(() => routed.push("new"));
    releaseOld();
    expect(shell.routing.at(-1)).toBe(true);
    shell.handBack("https://example.com/");
    expect(routed).toEqual(["new"]);
    releaseNew();
  });

  test("the fallback goes through the shell, never window.open — which would come straight back", () => {
    const shell = installShell();
    const opened: unknown[] = [];
    const original = window.open;
    window.open = ((...args: unknown[]) => (opened.push(args), null)) as typeof window.open;
    try {
      openInSystemBrowser("https://example.com/");
    } finally {
      window.open = original;
    }
    expect(shell.external).toEqual(["https://example.com/"]);
    expect(opened).toEqual([]);
  });
});

describe("transcript links", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<MessageResponse>{"See [the docs](https://example.com/docs)."}</MessageResponse>));
  };

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  test("with the setting ON a link is a real anchor the cockpit's click handler can route", () => {
    window.localStorage.setItem(KEY, "1");
    render();
    const link = host.querySelector('[data-streamdown="link"]');
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
  });

  test("with the setting OFF the link keeps its confirm-before-leaving gate", () => {
    render();
    const link = host.querySelector('[data-streamdown="link"]');
    expect(link?.tagName).toBe("BUTTON");
  });
});
