/**
 * THE RETENTION PANE (#542, #646), and the four claims worth a DOM.
 *
 * IT READS ONCE AND NEVER ON A TIMER, like the pane above it: the byte figure
 * behind it is a scan of every qualifying row's text, so a poll here would be
 * #629 at a far worse price per tick. The test counts REQUESTS rather than
 * reading the source for `setInterval` — what must not happen is a second
 * request, however it got made.
 *
 * THE BYTE SCAN IS OPT-IN, so the first read must not carry `?bytes=1`.
 *
 * A WINDOW CANNOT BE CHOSEN BEFORE A DESTINATION IS, because the copy comes
 * before the delete and a control that looked available and refused would teach
 * people to ignore controls.
 *
 * AND THE COPY DISTINGUISHES THE TWO MEANINGS OF "FREED". A sweep frees pages
 * inside the database and returns no bytes to the disk; a person who deleted
 * their history and then saw the same number in Storage has been given the
 * worst possible outcome, so the sentence sends them to Reclaim.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { RetentionBucket, RetentionPolicy } from "@telar/engine-client";
import { bucketLabel, RetentionSection, sweepLabel } from "./retention-section";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

const BUCKETS: RetentionBucket[] = [
  { days: 7, sessions: 41, events: 512_000 },
  { days: 14, sessions: 28, events: 340_000 },
  { days: 30, sessions: 12, events: 90_000 },
  { days: 60, sessions: 0, events: 0 },
];

let calls: Array<{ url: string; method: string }> = [];
let policy: RetentionPolicy = { idleAfterDays: null, exportTo: null };
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  policy = { idleAfterDays: null, exportTo: null };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.includes("/sweep")) {
      return Response.json({ swept: { retired: 41, skipped: 2, events: 512_000 } });
    }
    if (method === "PUT") {
      const patch = JSON.parse(String(init?.body ?? "{}")) as Partial<RetentionPolicy>;
      policy = { ...policy, ...patch };
      return Response.json({ retention: policy });
    }
    const bytes = url.includes("bytes=1");
    return Response.json({
      retention: policy,
      buckets: bytes ? BUCKETS.map((bucket) => ({ ...bucket, bytes: bucket.events * 240 })) : BUCKETS,
    });
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
    root.render(<RetentionSection />);
    await settle();
  });
  await act(async () => { await settle(); });
  return {
    host,
    button: (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement,
    unmount: () => { act(() => root.unmount()); host.remove(); },
  };
}

async function press(button: HTMLElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
  });
}

describe("Settings ▸ Storage ▸ retention", () => {
  test("one read on open, without the byte scan, and no second one however long it sits there", async () => {
    const view = await mount();
    expect(calls).toEqual([{ url: "/api/storage/retention", method: "GET" }]);
    // Far longer than any poll worth writing would wait.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(calls).toHaveLength(1);
    view.unmount();
  });

  test("the byte figure is a press, and only then does the request carry it", async () => {
    const view = await mount();
    await press(view.button("Measure size"));
    expect(calls.map((call) => call.url)).toEqual(["/api/storage/retention", "/api/storage/retention?bytes=1"]);
    expect(view.host.textContent).toContain("MB");
    view.unmount();
  });

  test("the windows are priced against this store before one can be chosen", async () => {
    const view = await mount();
    const text = view.host.textContent ?? "";
    // THE WHOLE ARGUMENT FOR THE PANE: a fixed default window is what destroys
    // the install whose oldest session is a week old. These are that person's
    // own numbers, on screen, before the decision.
    expect(text).toContain("41 conversations");
    expect(text).toContain("512,000 journal rows");
    // …including the window that would take nothing, which reads as a sentence
    // rather than as "0 sessions".
    expect(text).toContain("nothing yet");
    view.unmount();
  });

  test("a window cannot be set before there is somewhere to write the copy", async () => {
    const view = await mount();
    const select = view.host.querySelector("[data-slot='select-trigger']") as HTMLButtonElement | null;
    expect(select?.hasAttribute("disabled")).toBe(true);
    // And "Retire now" is inert too, because there is no window yet.
    expect(view.button("Retire now").disabled).toBe(true);
    view.unmount();
  });
});

describe("the sentences", () => {
  test("a window that would take nothing says so, rather than reporting zero", () => {
    expect(bucketLabel({ days: 60, sessions: 0, events: 0 })).toBe("nothing yet — no conversation here is that old");
  });

  test("one conversation is one conversation", () => {
    expect(bucketLabel({ days: 7, sessions: 1, events: 1 })).toBe("1 conversation, 1 journal row");
  });

  test("bytes appear only when they were measured", () => {
    expect(bucketLabel({ days: 7, sessions: 2, events: 10 })).not.toContain("B");
    // Through `formatBytes`, the cockpit's one byte formatter — a second one on
    // this screen would disagree with the row above it about a gigabyte the
    // first time somebody rounded differently (#630).
    expect(bucketLabel({ days: 7, sessions: 2, events: 10, bytes: 2_400 })).toContain("2.3 KB");
  });

  test("a sweep names what it skipped, and sends the reader to Reclaim for the bytes", () => {
    const said = sweepLabel({ retired: 41, skipped: 2, events: 512_000 });
    expect(said).toContain("Retired 41 conversations");
    expect(said).toContain("512,000 journal rows exported, then dropped");
    // SKIPPED IS NEVER HIDDEN, and it is not an error: it is the guard working.
    expect(said).toContain("2 were left alone");
    // AND "FREED" MEANS TWO THINGS. A DELETE moves pages to sqlite's freelist;
    // the file weighs the same until Reclaim rewrites it, and a person who
    // deleted history and saw no change would think the press did nothing.
    expect(said).toContain("press Reclaim above to give the space back to the disk");
  });

  test("a sweep that took nothing says that, rather than reporting a triumphant zero", () => {
    expect(sweepLabel({ retired: 0, skipped: 0, events: 0 })).toBe("Nothing was old enough to retire.");
  });
});
