/**
 * THE STORAGE PANE (#642), and the two claims worth a DOM.
 *
 * IT READS ONCE AND NEVER ON A TIMER. #629 is open because four timers in the
 * rail cost ~97,000 requests a day; the read behind this pane walks a 13 GB
 * tree, so a timer here would be that bug at a far worse price per tick. The
 * test counts requests rather than reading the source for `setInterval`,
 * because what must not happen is a second request — however it got made.
 *
 * AND THE ROWS ARE NAMED FOR PEOPLE. The engine says `worktrees`; a reader is
 * told "Session checkouts". A pane that printed directory names would be a
 * `du` listing with a scrollbar, which is the thing it exists not to be.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { StorageReport } from "@telar/engine-client";
import { measuredLabel, orderEntries, StorageSection } from "./storage-section";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

/** This Mac's own shape, in miniature — including the row the issue was
 *  written about, which nobody knew was there. */
const REPORT: StorageReport = {
  root: "/Users/someone/Library/Application Support/Telar/engine",
  total: 13_000_000_000,
  measuredAt: 1_700_000_000_000,
  tookMs: 4_000,
  partial: false,
  entries: [
    { category: "worktrees", bytes: 12_000_000_000, path: "/Users/someone/Library/Application Support/Telar/engine/worktrees", kind: "directory" },
    { category: "journal", bytes: 993_000_000, path: "/Users/someone/Library/Application Support/Telar/engine/execution.sqlite", kind: "file" },
    { category: "other", bytes: 5_000_000, path: "/Users/someone/Library/Application Support/Telar/engine", kind: "directory" },
    { category: "sessions", bytes: 368_000_000, path: "/Users/someone/Library/Application Support/Telar/engine/sessions", kind: "directory" },
  ],
};

let calls: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return new Response(JSON.stringify({ storage: REPORT }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (window as { telarDesktop?: unknown }).telarDesktop;
});

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<StorageSection />);
    await settle();
  });
  await act(async () => {
    await settle();
  });
  return {
    host,
    button: (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement,
    buttons: (label: string) => [...host.querySelectorAll("button")].filter((candidate) => candidate.textContent?.trim() === label),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

async function press(button: HTMLElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
  });
}

describe("Settings ▸ Storage", () => {
  test("one read on open, and no second one however long the pane is left sitting there", async () => {
    const view = await mount();
    expect(calls).toEqual(["/api/storage"]);

    // Far longer than any poll worth writing would wait.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(calls).toEqual(["/api/storage"]);
    view.unmount();
  });

  test("Refresh is the other half of the contract, and it asks for a fresh walk", async () => {
    const view = await mount();
    await press(view.button("Refresh"));
    expect(calls).toEqual(["/api/storage", "/api/storage?refresh=1"]);
    view.unmount();
  });

  test("the rows are named for what they mean to a person, not for their directory", async () => {
    const view = await mount();
    const text = view.host.textContent ?? "";
    expect(text).toContain("Session checkouts");
    expect(text).toContain("Turn journal");
    expect(text).toContain("Conversation history");
    expect(text).not.toContain("worktrees/");
    view.unmount();
  });

  test("the gigabyte nobody knew about is on screen with its size", async () => {
    // The whole argument for the pane, as a test: 993 MB of `execution.sqlite`
    // had never come up in any conversation about disk.
    const view = await mount();
    expect(view.host.textContent).toContain("Turn journal");
    expect(view.host.textContent).toContain("947 MB");
    view.unmount();
  });

  test("the total and the store's location are both at the top", async () => {
    const view = await mount();
    const text = view.host.textContent ?? "";
    expect(text).toContain("Total");
    expect(text).toContain("12 GB");
    expect(text).toContain(REPORT.root);
    view.unmount();
  });

  test("nothing on this pane deletes anything", async () => {
    /**
     * READ AND REACH ONLY, in this pass. A "clean up" button on a pane whose
     * numbers a reader has just met for the first time is an invitation to
     * remove something they have not yet understood.
     */
    const view = await mount();
    const labels = [...view.host.querySelectorAll("button")].map((button) => button.textContent?.trim().toLowerCase() ?? "");
    for (const forbidden of ["delete", "remove", "clean up", "clear", "empty"]) {
      expect(labels).not.toContain(forbidden);
    }
    view.unmount();
  });

  test("Reveal selects the database itself, and opens a folder as a folder", async () => {
    const revealed: { path: string; kind: string }[] = [];
    (window as { telarDesktop?: unknown }).telarDesktop = {
      workspace: {
        reveal: async (path: string) => {
          revealed.push({ path, kind: "directory" });
          return { ok: true };
        },
        revealFile: async (path: string) => {
          revealed.push({ path, kind: "file" });
          return { ok: true };
        },
        open: async () => ({ ok: true }),
      },
    };

    const view = await mount();
    const reveals = view.buttons("Reveal");
    // The total's own, then one per row.
    expect(reveals.length).toBe(REPORT.entries.length + 1);
    await press(reveals[0]!);
    await press(reveals[2]!);

    expect(revealed[0]).toEqual({ path: REPORT.root, kind: "directory" });
    // The journal row — a file, selected in its folder rather than opened.
    expect(revealed[1]).toEqual({ path: REPORT.entries[1]!.path, kind: "file" });
    view.unmount();
  });

  test("a browser tab is told why there is no Reveal, once, instead of per row", async () => {
    const view = await mount();
    expect(view.buttons("Reveal").length).toBe(0);
    expect(view.host.textContent).toContain("needs the Telar desktop app");
    view.unmount();
  });

  test("a partial walk says the figures are a floor rather than quietly under-reporting", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ storage: { ...REPORT, partial: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const view = await mount();
    expect(view.host.textContent).toContain("a floor");
    view.unmount();
  });

  test("an engine that does not answer says so rather than showing a confident zero", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } })) as typeof fetch;
    const view = await mount();
    expect(view.host.textContent).toContain("could not measure");
    expect(view.host.textContent).not.toContain("0 B");
    view.unmount();
  });
});

describe("the two decisions that are pure functions", () => {
  test("`Everything else` reads last whatever it weighs", () => {
    // It is the remainder. In the middle of a list of named things it reads
    // like one of them, and a reader starts wondering what "other" is made of
    // instead of looking at the row above it.
    const ordered = orderEntries(REPORT.entries);
    expect(ordered.map((entry) => entry.category)).toEqual(["worktrees", "journal", "sessions", "other"]);
  });

  test("the timestamp says a time today and a date after that", () => {
    const noon = new Date(2026, 8, 19, 12, 0, 0).getTime();
    expect(measuredLabel(noon, noon + 60_000)).toMatch(/^as of \d/);
    expect(measuredLabel(noon, noon + 3 * 24 * 60 * 60 * 1000)).toContain("Sep");
  });
});
