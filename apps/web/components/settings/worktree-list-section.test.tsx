/**
 * WHICH CHECKOUTS CAN GO — issue #671.
 *
 * Every claim here is a promise the surface has to keep, and each one is a way
 * the old behaviour or an obvious implementation gets it wrong:
 *
 *   IT NEVER OFFERS A LOCKED ROW AN AFFORDANCE. A checkout a session is working
 *   in must have no checkbox and no force field — git's lock does not refuse
 *   Telar, so a press would SUCCEED and take the directory an agent is writing
 *   in. The affordance's absence is the entire guard on this side.
 *
 *   IT NEVER DRAWS "NO CHECKOUTS" FOR AN ABSENT DRIVE. An empty list reads as
 *   "there are none", which is the reassuring lie the composer's count already
 *   knows not to tell.
 *
 *   IT SAYS "ARCHIVE" ON THE CONFIRM. Giving back a settled session's checkout
 *   ends that session; a confirm that named the gigabytes and hid the session
 *   is the kind people click and regret.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { WorktreeInventory, WorktreeRow } from "@telar/engine-client";
import { armedRows, confirmSentence, ownerLabel, reclaimPayload, WorktreeListSection } from "./worktree-list-section";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

const row = (patch: Partial<WorktreeRow> & Pick<WorktreeRow, "basename">): WorktreeRow => ({
  path: `/Volumes/TelarVR/cuts/${patch.basename}`,
  owner: { kind: "none" },
  registered: true,
  onDisk: true,
  verdict: { kind: "reclaimable" },
  ...patch,
});

let inventory: WorktreeInventory;
let sent: { url: string; body?: unknown }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  inventory = { rows: [], roots: ["/Volumes/TelarVR/cuts"], partial: false, measuredAt: Date.now() };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/reclaim")) {
      return new Response(JSON.stringify({ reclaim: { results: [], summary: "Archived 1 session." } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ inventory }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<WorktreeListSection />);
    await settle();
  });
  await act(async () => {
    await settle();
  });
  return {
    host,
    boxes: () => [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[],
    fields: () => [...host.querySelectorAll('input:not([type="checkbox"])')] as HTMLInputElement[],
    button: (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().startsWith(label)),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("Settings ▸ Storage ▸ Checkouts", () => {
  test("a reclaimable row starts checked, because Telar already did the proof", async () => {
    inventory.rows = [row({ basename: "telar--done-1111", merged: true, clean: true, bytes: 1024 ** 3 })];
    const view = await mount();
    expect(view.boxes()).toHaveLength(1);
    expect(view.boxes()[0]!.checked).toBe(true);
    view.unmount();
  });

  /**
   * THE ROW THAT MUST HAVE NO BUTTON. There is no lock error waiting to catch a
   * press here — `removeSessionWorktreeAsync` unlocks before removing — so if
   * this surface offered the affordance, the removal would go through.
   */
  test("a checkout a session is working in has no checkbox and no force field", async () => {
    inventory.rows = [
      row({
        basename: "telar--busy-2222",
        owner: { kind: "session", sessionId: "s1", lifecycle: "settled" },
        verdict: { kind: "locked", reason: "in-use" },
      }),
    ];
    const view = await mount();
    expect(view.boxes()).toHaveLength(0);
    expect(view.fields()).toHaveLength(0);
    expect(view.host.textContent).toContain("working in it right now");
    expect(view.button("Give back")).toBeUndefined();
    view.unmount();
  });

  test("a live session's checkout is locked and says settling it is the way out", async () => {
    inventory.rows = [
      row({
        basename: "telar--live-3333",
        owner: { kind: "session", sessionId: "s1", lifecycle: "live" },
        verdict: { kind: "locked", reason: "active" },
      }),
    ];
    const view = await mount();
    expect(view.boxes()).toHaveLength(0);
    expect(view.host.textContent).toContain("Settle it first");
    view.unmount();
  });

  /** The typed force is not ceremony — these are exactly the rows Telar could
   *  not prove safe, so the person is being asked to say they looked. The row
   *  offers the field and nothing else: no checkbox, and no press until the
   *  name is in. (The arming rule itself is pinned below, directly.) */
  test("a dirty row offers a typed field instead of a checkbox, and arms nothing on its own", async () => {
    inventory.rows = [
      row({ basename: "telar--dirty-4444", clean: false, verdict: { kind: "needs-force", reasons: ["dirty"] } }),
    ];
    const view = await mount();
    expect(view.boxes()).toHaveLength(0);
    expect(view.fields()).toHaveLength(1);
    expect(view.fields()[0]!.getAttribute("placeholder")).toBe("telar--dirty-4444");
    expect(view.host.textContent).toContain("has uncommitted changes");
    expect(view.button("Give back")).toBeUndefined();
    view.unmount();
  });

  /**
   * AN UNPROVEN READ IS SAID OUT LOUD. A `status` that was killed must not read
   * as clean, and the row must explain that nobody managed to look rather than
   * presenting a subprocess failure as a finding.
   */
  test("an unchecked row asks for the force and says git did not answer", async () => {
    inventory.rows = [
      row({ basename: "telar--unknown-6666", incomplete: "timeout", verdict: { kind: "needs-force", reasons: ["unknown"] } }),
    ];
    const view = await mount();
    expect(view.host.textContent).toContain("could not be checked");
    expect(view.host.textContent).toContain("unchecked");
    expect(view.boxes()).toHaveLength(0);
    view.unmount();
  });

  /** An empty list would read as "there are none", and invite a reclaim of the
   *  lot the moment the drive came back. */
  test("an absent drive says so and draws no rows", async () => {
    inventory = { rows: [], roots: ["/Volumes/TelarVR/cuts"], blocker: "TelarVR is not connected.", partial: false, measuredAt: Date.now() };
    const view = await mount();
    expect(view.host.textContent).toContain("TelarVR is not connected.");
    expect(view.host.textContent).not.toContain("No checkouts yet");
    expect(view.boxes()).toHaveLength(0);
    view.unmount();
  });

  test("the confirm names the sessions it will archive, not just the space", async () => {
    inventory.rows = [
      row({
        basename: "telar--done-7777",
        owner: { kind: "session", sessionId: "s1", lifecycle: "settled" },
        bytes: 2 * 1024 ** 3,
      }),
    ];
    const view = await mount();
    await act(async () => {
      view.button("Give back")!.click();
      await settle();
    });
    expect(view.host.textContent).toContain("Archive 1 session");
    expect(view.host.textContent).toContain("archives its session");
    view.unmount();
  });

  test("the press sends the rows it said it would", async () => {
    inventory.rows = [row({ basename: "telar--clean-8888", owner: { kind: "session", sessionId: "s1", lifecycle: "settled" } })];
    const view = await mount();
    await act(async () => {
      view.button("Give back")!.click();
      await settle();
    });
    await act(async () => {
      view.button("Give them back")!.click();
      await settle();
    });
    const press = sent.find((entry) => entry.url.includes("/reclaim"));
    const items = (press!.body as { items: { path: string; confirm?: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.path).toEndWith("telar--clean-8888");
    // A proven-safe row carries no confirmation: attaching one would make it
    // look like something somebody had forced.
    expect(items[0]!.confirm).toBeUndefined();
    view.unmount();
  });
});

/**
 * THE ARMING RULE, PINNED DIRECTLY.
 *
 * It is tested here rather than by typing into the DOM because it is the one
 * safety-bearing decision this file makes, and because a rule asserted through
 * a rendered keystroke is a rule that stops being asserted the day the input
 * component changes. There is no lock error downstream to catch a mistake — the
 * engine unlocks before removing — so an over-permissive answer here removes a
 * checkout rather than being refused.
 */
describe("which rows a press would act on", () => {
  const clean = row({ basename: "clean-1111" });
  const dirty = row({ basename: "dirty-2222", verdict: { kind: "needs-force", reasons: ["dirty"] } });
  const busy = row({ basename: "busy-3333", verdict: { kind: "locked", reason: "in-use" } });
  const none = new Set<string>();

  test("a reclaimable row is armed without anyone doing anything", () => {
    expect(armedRows([clean], none, {}).map((entry) => entry.basename)).toEqual(["clean-1111"]);
  });

  test("a locked row is never armed, whatever is typed against it", () => {
    expect(armedRows([busy], none, { [busy.path]: busy.basename })).toEqual([]);
  });

  test("a force row is armed only by its exact basename", () => {
    expect(armedRows([dirty], none, {})).toEqual([]);
    expect(armedRows([dirty], none, { [dirty.path]: "dirty-222" })).toEqual([]);
    expect(armedRows([dirty], none, { [dirty.path]: "DIRTY-2222" })).toEqual([]);
    expect(armedRows([dirty], none, { [dirty.path]: "  dirty-2222  " })).toHaveLength(1);
  });

  test("unchecking a reclaimable row takes it out, and a refresh does not put it back", () => {
    const cleared = new Set([clean.path]);
    expect(armedRows([clean], cleared, {})).toEqual([]);
    // The same rows arriving again from a fresh read: still out, because the
    // state is the exception rather than a selection seeded on load.
    expect(armedRows([row({ basename: "clean-1111" })], cleared, {})).toEqual([]);
  });

  test("the payload carries a confirmation only where one was required", () => {
    const payload = reclaimPayload([clean, dirty], { [dirty.path]: "dirty-2222" });
    expect(payload.find((item) => item.path === clean.path)!.confirm).toBeUndefined();
    expect(payload.find((item) => item.path === dirty.path)!.confirm).toBe("dirty-2222");
  });
});

describe("the row's words", () => {
  test("a session whose checkout outlived it reads as left behind, not as archived", () => {
    expect(ownerLabel(row({ basename: "x", owner: { kind: "session", sessionId: "s1", lifecycle: "archived" } })).label).toBe("left behind");
  });

  test("a checkout nothing claims says so plainly", () => {
    expect(ownerLabel(row({ basename: "x" })).label).toBe("no session");
  });

  test("the confirm counts archives and removals separately, and promises the branches", () => {
    const sentence = confirmSentence([
      row({ basename: "a", owner: { kind: "session", sessionId: "s1", lifecycle: "settled" }, bytes: 1024 ** 3 }),
      row({ basename: "b", bytes: 1024 ** 3 }),
    ]);
    expect(sentence).toContain("Archive 1 session");
    expect(sentence).toContain("Remove 1 checkout");
    expect(sentence).toContain("Branches are kept.");
  });
});

/**
 * A READ THAT OUTLIVES THE PANE IS HUNG UP ON. Git reads per checkout take
 * seconds on a large install; left running, this read held one of the
 * cockpit's two read slots and the sidebar queued behind it until a reload.
 * The pane's zero-timeout is run by hand, so nothing here sleeps.
 */
test("closing the pane aborts a checkouts read the engine has not answered", async () => {
  const signals: AbortSignal[] = [];
  const queued: Array<() => void> = [];
  const realSetTimeout = window.setTimeout;
  window.setTimeout = ((run: () => void) => (queued.push(run), queued.length)) as typeof window.setTimeout;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  try {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<WorktreeListSection />);
    });
    await act(async () => {
      for (const run of queued.splice(0)) run();
    });
    expect(signals.length).toBe(1);
    expect(signals[0]!.aborted).toBe(false);

    act(() => root.unmount());
    host.remove();
    expect(signals[0]!.aborted).toBe(true);
  } finally {
    window.setTimeout = realSetTimeout;
  }
});
