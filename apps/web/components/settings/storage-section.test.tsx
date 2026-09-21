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
import { cacheLabel, measuredLabel, orderEntries, StorageSection } from "./storage-section";

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
     * STILL TRUE WITH RECLAIM ON THE PANE (#646), and the reason it is worth
     * keeping as a test rather than retiring as a stale rule.
     *
     * #642's objection was to a "clean up" on a pane whose numbers a reader has
     * just met — an invitation to remove something they have not yet
     * understood. Reclaim removes no history: the rows it drops are superseded
     * by the `item.completed` of their own turn. So the pane gained an action
     * and none of these verbs, which is exactly the line this holds.
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

/**
 * RECLAIM (#646) — the pane's one write, and the three things it must not get
 * wrong: it only appears on the journal row, it re-measures rather than doing
 * arithmetic on a stale figure, and it reports a press that moved nothing.
 */
describe("Settings ▸ Storage ▸ Reclaim", () => {
  const reclaimResponse = (reclaimed: { before: number; after: number; deltas: number; starts: number; sessions: number }) => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      const body = url.includes("/journal/reclaim")
        ? { reclaimed }
        : // After the press the row must show the file as it is NOW, so the
          // second walk answers with the smaller figure the vacuum produced.
          { storage: calls.some((seen) => seen.includes("/journal/reclaim")) ? { ...REPORT, total: 12_700_000_000, entries: REPORT.entries.map((entry) => (entry.category === "journal" ? { ...entry, bytes: 695_000_000 } : entry)) } : REPORT };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  };

  test("it is offered on the journal row and on no other", async () => {
    reclaimResponse({ before: 993_000_000, after: 695_000_000, deltas: 443_738, starts: 127_213, sessions: 446 });
    const view = await mount();
    // One button, not one per row: nothing else here is a SQLite file.
    expect(view.buttons("Reclaim").length).toBe(1);
    view.unmount();
  });

  test("a press compacts, then re-measures — the row cannot keep showing the old size", async () => {
    reclaimResponse({ before: 993_000_000, after: 695_000_000, deltas: 443_738, starts: 127_213, sessions: 446 });
    const view = await mount();
    expect(view.host.textContent).toContain("947 MB");

    await press(view.button("Reclaim"));
    expect(calls).toEqual(["/api/storage", "/api/storage/journal/reclaim", "/api/storage?refresh=1"]);

    const text = view.host.textContent ?? "";
    // What went, in rows and in bytes, and both ends of the change.
    expect(text).toContain("570,951 superseded rows");
    expect(text).toContain("947 MB → 663 MB");
    // And the row itself now reads the compacted file.
    expect(text).toContain("663 MB");
    expect(text).not.toContain("947 MB —");
    view.unmount();
  });

  test("pressing it again says the store is already compact rather than nothing at all", async () => {
    // The case worth designing for: somebody who reclaimed yesterday. A silent
    // no-op reads as a broken button, and "freed 0 B" reads as a bug.
    reclaimResponse({ before: 695_000_000, after: 695_000_000, deltas: 0, starts: 0, sessions: 0 });
    const view = await mount();
    await press(view.button("Reclaim"));
    expect(view.host.textContent).toContain("Already compact");
    view.unmount();
  });

  test("it says no turn, item or answer is removed — before anyone presses it", async () => {
    // A button on a row called "Turn journal" reads as "delete my
    // conversations" unless the row says otherwise, so the sentence is there
    // on arrival rather than in a confirmation nobody reads.
    reclaimResponse({ before: 1, after: 1, deltas: 0, starts: 0, sessions: 0 });
    const view = await mount();
    expect(view.host.textContent).toContain("no turn or answer is removed");
    view.unmount();
  });

  test("an engine that refuses the compaction says so and leaves the figures alone", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes("/journal/reclaim")) return new Response("{}", { status: 409, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ storage: REPORT }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const view = await mount();
    await press(view.button("Reclaim"));
    expect(view.host.textContent).toContain("could not compact");
    // The pane still reports what it last measured, rather than blanking.
    expect(view.host.textContent).toContain("947 MB");
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

/**
 * THE SENTENCE UNDER THE CHECKOUTS FIGURE — issue #633.
 *
 * It exists because the figure itself cannot carry this: `stat.blocks` counts
 * a copy-on-write clone at full size, so "Session checkouts — 7.3 GB" reads
 * identically whether deduplication is working or not. The row that makes
 * somebody ask is precisely the row that cannot answer.
 */
describe("what a checkout's node_modules costs, and why", () => {
  test("one disk says nothing at all", () => {
    // The engine filters `same-device` out, so this is the empty case — and
    // most people are it. Their entitlement is silence, not a reassuring row.
    expect(cacheLabel([])).toBeUndefined();
  });

  test("a cache on another disk says what it costs and what would fix it", () => {
    const said = cacheLabel([{ name: "bun", path: "/Users/someone/.bun/install/cache", dedup: "different-device" }])!;
    expect(said).toContain("bun");
    expect(said).toContain("copies every package instead of sharing it");
    expect(said).toContain("same disk");
    // NOT A PATH. The sentence is about a relationship between two locations,
    // and printing either of them invites somebody to go and look at the wrong
    // one — the cache is not where the bytes are.
    expect(said).not.toContain("/Users/someone");
  });

  test("a cache nobody has ever created is said differently, and is not called a different disk", () => {
    const said = cacheLabel([{ name: "pnpm", path: "/Users/someone/Library/pnpm", dedup: "unreachable" }])!;
    expect(said).toContain("no cache Telar can reach");
    expect(said).toContain("may simply never have run here");
    // THE DISTINCTION IS THE WHOLE POINT OF TWO WORDS. Calling an absent cache
    // "a different disk" would be a wrong answer dressed as a precise one.
    expect(said).not.toContain("different disk");
  });

  test("both at once are two sentences, not a merged count", () => {
    const said = cacheLabel([
      { name: "bun", path: "/a", dedup: "different-device" },
      { name: "yarn", path: "/b", dedup: "unreachable" },
    ])!;
    expect(said).toContain("bun");
    expect(said).toContain("yarn");
    // "2 package caches have problems" would send a person looking for one
    // thing where there are two, with two different answers.
    expect(said).toContain("copies every package");
    expect(said).toContain("no cache Telar can reach");
  });
});
