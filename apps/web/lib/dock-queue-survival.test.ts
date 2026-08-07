// ISSUE #7 — A MESSAGE SURVIVES THE SURFACE GOING AWAY.
//
// #5 made this true for navigation and reload; the dock's close button was the
// one hole left. Undocking deleted `runtime[id]`, and because the provider
// persists exactly the queued slice of `runtime`, the very next write erased the
// same messages from localStorage — gone from memory AND disk, for a session
// that still existed.
//
// Three claims, and they are not equally load-bearing — the order below is the
// honest one:
//
//   1. WHAT IS KEPT. `releaseRuntime` parks the queue on a blank Runtime. The
//      dock's bridge is pre-ack by construction, so in practice this keeps
//      everything; the ownership filter it calls is the general rule for the
//      next caller, NOT what bounds this bug (see the first describe).
//   2. WHAT BOUNDS IT. A 202 is now the only exit from `telar:dock-queued`, so
//      the map needs the byte ceiling `writeQueue` already gives the session
//      surface's own key.
//   3. WHAT THE USER SEES. Retention turns a lost message into a message that
//      sends later — acceptable only because a head cannot drain without being
//      on screen, showing the count.
//
// Kept out of `message-queue.test.ts` (byte budget) and `queue-partition.test.ts`
// (who RENDERS an item) — this is who may DESTROY one.

// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  fitQueueMapToBudget,
  isEngineOwned,
  MAX_QUEUE_BYTES,
  retainOnSurfaceLoss,
  type QueueItemLifecycle,
} from "./message-queue";
// THE REAL REDUCERS, not copies of them. These are module-scope pure functions
// in a "use client" .tsx; bun imports it fine (`lib/ultra-runs.test.ts` already
// imports `@/components/session/ultra-rail`), so a hand-rolled stand-in here
// would only be a second version of the rule that cannot drift-fail.
import {
  baseRuntime,
  queuedSlice,
  releaseRuntime,
  type DockQueuedMessage,
  type Runtime,
} from "@/components/dock/dock-provider";

const WEB_ROOT = new URL("../", import.meta.url);
const src = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");
const dockProvider = () => src("components/dock/dock-provider.tsx");
const runtimeHost = () => src("components/dock/session-runtime-host.tsx");

type Item = {
  id: string;
  text: string;
  state?: QueueItemLifecycle;
  accepted?: boolean;
  error?: string;
};
const ids = (items: Item[]) => items.map((i) => i.id);

// THE GENERAL RULE, WHICH THE DOCK DOES NOT YET EXERCISE. `DockQueuedMessage` is
// `{id, text}` and nothing writes `state`/`accepted` onto one — the runtime host
// never projects engine state onto the items, in any form — so at the
// dock's call site this filter is the identity function, and only the first test
// below is reachable from production today. The rest pin the rule for the next
// caller (the session surface DOES set `accepted`); they are not evidence that
// the dock is bounded. What bounds the dock is `releaseRuntime` + the byte
// ceiling, both exercised further down.
describe("retainOnSurfaceLoss — only the engine's copy makes an item safe to drop", () => {
  test("a purely local item is retained — it exists in no other place", () => {
    // THE REGRESSION ITSELF: the dock's `queued` is a pre-ack bridge and nothing
    // else (`dequeue` runs only on a 202), so EVERY item in it is at risk.
    const local: Item[] = [
      { id: "a", text: "fix the flaky test" },
      { id: "b", text: "and rerun it" },
    ];
    expect(ids(retainOnSurfaceLoss(local))).toEqual(["a", "b"]);
  });

  test("over the dock's OWN item type the filter is total — nothing can be dropped", () => {
    // The reachable claim, stated in the dock's real type rather than the
    // general one: `DockQueuedMessage` has no field that can make an item
    // engine-owned, so retention there is unconditional. If the host ever starts
    // projecting `state` onto items this stops compiling as written, which is
    // the moment `releaseRuntime`'s comment stops being true.
    const items: DockQueuedMessage[] = [
      { id: "a", text: "one" },
      { id: "b", text: "two" },
    ];
    expect(retainOnSurfaceLoss(items)).toEqual(items);
  });

  test("[rule, not yet reachable from the dock] an acknowledged item is released", () => {
    // Keeping these would be the opposite bug: a client-side replay of work the
    // engine has already taken, i.e. a duplicate send.
    const owned: Item[] = [
      { id: "acked", text: "x", accepted: true },
      { id: "queued", text: "y", state: "queued" },
      { id: "running", text: "z", state: "running" },
    ];
    expect(retainOnSurfaceLoss(owned)).toEqual([]);
  });

  test("[rule] `state` alone is enough, without `accepted`", () => {
    // The two surfaces mark acknowledgement differently — session-view sets
    // `accepted`, the engine projection supplies `state`. Requiring both would
    // retain (and re-send) every item projected back from queue.json.
    expect(isEngineOwned({ id: "p", state: "claimed" })).toBe(true);
    expect(isEngineOwned({ id: "q", accepted: true })).toBe(true);
    expect(isEngineOwned({ id: "r" })).toBe(false);
  });

  test("[rule] a terminal item is released — history is not a queue entry", () => {
    const done: Item[] = [
      { id: "c", text: "x", state: "committed" },
      { id: "x", text: "y", state: "cancelled" },
    ];
    expect(retainOnSurfaceLoss(done)).toEqual([]);
  });

  test("[rule] a local item the engine REFUSED is retained, not swept out by a close button", () => {
    // #31 already refused to let a refused message vanish from the queue box.
    // It carries no `state` and was never accepted, so it lives only here — a
    // close button must not become the back door that deletes it.
    const refused: Item = { id: "refused", text: "important", error: "HTTP 500" };
    expect(ids(retainOnSurfaceLoss([refused]))).toEqual(["refused"]);
  });

  test("[rule] mixed queues split, and order is preserved among the survivors", () => {
    const mixed: Item[] = [
      { id: "1", text: "a" },
      { id: "taken", text: "b", state: "running" },
      { id: "2", text: "c" },
      { id: "old", text: "d", state: "committed" },
      { id: "3", text: "e" },
    ];
    expect(ids(retainOnSurfaceLoss(mixed))).toEqual(["1", "2", "3"]);
  });

  test("retaining does not mutate or rewrite the items it keeps", () => {
    // The retained item is re-submitted under its own `id` as the idempotency
    // key; a new object identity would be fine but a new id would not.
    const item: Item = { id: "keep", text: "verbatim" };
    const [kept] = retainOnSurfaceLoss([item]);
    expect(kept).toBe(item);
  });
});

// The reducers above are tested by RUNNING them. What is left is WIRING — which
// callbacks and which JSX reach them — and that lives inside a component the app
// has no harness for (story 3.1 hard rule 9), so the SOURCE TEXT is the
// executable form, exactly as `queue-partition.test.ts` and
// `composer-disable.test.ts` already work. Only claims that cannot be made by
// import belong here.
describe("issue #7 — the dock's removal paths drop the viewport, not the queue", () => {
  test("`releaseRuntime` is the ONLY thing that may drop an id's runtime", () => {
    // A second `delete next[id]` anywhere in the provider is a removal path that
    // bypasses the retention rule — which is exactly what the bug was.
    const provider = dockProvider();
    expect(provider.split("delete next[id];").length - 1).toBe(1);
    const at = provider.indexOf("delete next[id];");
    expect(provider.slice(0, at)).toContain("export const releaseRuntime = (");
  });

  test("BOTH removal paths go through it — undock and clearAutoDock", () => {
    // `clearAutoDock` fires when the standalone session view mounts and had the
    // identical delete. Fixing only the close button would leave the same loss
    // one navigation away.
    const provider = dockProvider();
    expect(provider.split("setRuntimeState((prev) => releaseRuntime(prev, id));").length - 1).toBe(2);
    for (const fn of ["const undock = useCallback", "const clearAutoDock = useCallback"]) {
      const at = provider.indexOf(fn);
      expect(at).toBeGreaterThan(-1);
      expect(provider.slice(at, provider.indexOf("}, []);", at))).toContain("releaseRuntime(prev, id)");
    }
  });

  test("the persist effect writes the budgeted queued slice, so retention reaches disk", () => {
    // The halves are coupled: this snapshot is what survives a reload, and it is
    // built from `queuedSlice` — precisely what `releaseRuntime` keeps non-empty
    // — then capped, because a 202 is now the only thing that removes an entry.
    expect(dockProvider()).toContain("fitQueueMapToBudget(queuedSlice(runtime)).map");
  });
});

describe("issue #7 — a retained queue is a VISIBLE queue, not a sleeper", () => {
  // Retention made a re-dock able to resume a send the user last saw fail. That
  // is only defensible if the user can see it coming: a minimized head used to
  // say nothing at all about words it was holding (the X exists on hover only,
  // and the queue chips render inside an EXPANDED panel).
  test("a head with unsent words renders a persistent count", () => {
    const dock = src("components/dock/dock.tsx");
    const at = dock.indexOf("function Head(");
    expect(at).toBeGreaterThan(-1);
    const head = dock.slice(at, dock.indexOf("function IconBtn(", at));
    expect(head).toContain("const pending = pendingOf(rt);");
    expect(head).toContain("{pending > 0 && (");
    // Not gated on hover — that was the hole. `group-hover:` belongs to the X.
    const badge = head.slice(head.indexOf("{pending > 0 && ("));
    expect(badge.slice(0, badge.indexOf("</span>"))).not.toContain("group-hover:");
  });

  test("every count the dock shows is the count `releaseRuntime` actually keeps", () => {
    // `queued.length` and the retained length agree only while nothing writes
    // engine state onto a dock item. Counting the raw array would start
    // promising to keep messages the reducer drops.
    const dock = src("components/dock/dock.tsx");
    expect(dock).toContain("retainOnSurfaceLoss(rt?.queued ?? []).length");
    expect(dock).not.toContain("rt?.queued.length ?? 0");
  });

  test("both dismiss affordances still admit what they are keeping", () => {
    // Not a confirm dialog: the act is no longer destructive, so interrupting it
    // would be theatre. The badge is the persistent disclosure; these are the
    // per-control ones, on the head's X and the panel's Close.
    const dock = src("components/dock/dock.tsx");
    expect(dock).toContain("unsent message${n === 1 ? \"\" : \"s\"} kept for later");
    expect(dock).toContain("const dismiss = dismissLabel(`Undock ${rt?.title || entry.title}`, rt);");
    expect(dock).toContain("label={dismissLabel(\"Close\", rt)}");
    // A bare label on either control means one route out is still silent.
    expect(dock).not.toContain("label=\"Close\"");
  });

  test("a drain cannot happen without a head on screen to show it", () => {
    // The argument that makes the resume attended: `SessionRuntimeHost` owns the
    // POST and is rendered once per ENTRY, so no entry ⇒ no host ⇒ no send. If
    // a host were ever mounted from anywhere else, the badge would stop being a
    // guarantee and this would be a silent background send.
    const dock = src("components/dock/dock.tsx");
    expect(dock.split("<SessionRuntimeHost").length - 1).toBe(1);
    const at = dock.indexOf("<SessionRuntimeHost");
    expect(dock.slice(at - 120, at)).toContain("entries.map((e) => (");
  });
});

describe("issue #7 — a parked queue is not a stranded one", () => {
  test("the acceptance bridge re-fires when the session detail lands", () => {
    // `detailRef` is a ref, so a queue that already existed at mount (restored
    // from `telar:dock-queued`, or parked by a close and re-docked) ran the
    // effect once against a null detail and was never revisited: neither the
    // length nor the head changes when the fetch resolves. Without `loaded` in
    // the dependency list the message survives the close and then never sends,
    // which is durability in name only.
    const host = runtimeHost();
    expect(host).toContain("const detailLoaded = rt?.loaded ?? false;");
    expect(host).toContain("}, [id, detailLoaded, queuedLen, queuedHead, sendTurn]);");
    expect(host).not.toContain("}, [id, queuedLen, queuedHead, sendTurn]);");
  });

  test("only a 202 clears an item off the bridge", () => {
    // The whole ownership split rests on this: `dequeue` must not run on a
    // failed POST, or a retained item would be dropped without ever reaching
    // queue.json — the #7 loss, relocated into the send path.
    const host = runtimeHost();
    const at = host.indexOf("const sendTurn = useCallback(");
    const throwAt = host.indexOf("throw new Error(body?.error ?? `HTTP ${res.status}`);", at);
    const dequeueAt = host.indexOf("dequeue(id);", at);
    expect(throwAt).toBeGreaterThan(at);
    expect(dequeueAt).toBeGreaterThan(throwAt);
  });
});

// END TO END, over the PRODUCTION reducers and the same JSON the provider
// actually persists: queue into a bubble, close it, reload. Everything below
// runs `releaseRuntime`/`queuedSlice` themselves — delete either and these fail,
// which is the whole point of importing rather than restating them. `Runtime` is
// built through the real `baseRuntime`, so a field added to it is carried here
// instead of quietly diverging from a 3-field stand-in.
describe("issue #7 — the words are still there after the bubble is gone", () => {
  const runtimeWith = (queued: DockQueuedMessage[], rest: Partial<Runtime> = {}): Runtime => ({
    ...baseRuntime(undefined),
    queued,
    ...rest,
  });

  /** The provider's persist effect, minus localStorage: slice, then budget. */
  const persist = (state: Record<string, Runtime | undefined>): string | null => {
    const { map } = fitQueueMapToBudget(queuedSlice(state));
    return Object.keys(map).length === 0 ? null : JSON.stringify(map);
  };

  test("a pre-ack message queued into a closed bubble survives to the next reload", () => {
    const before: Record<string, Runtime | undefined> = {
      s1: runtimeWith([{ id: "q1", text: "rerun the migration" }], {
        messages: [{ role: "user", text: "old" }],
        loaded: true,
      }),
    };
    const after = releaseRuntime(before, "s1");

    // In memory: the head is gone (the caller filtered `entries`), the words are not.
    expect(after.s1?.queued).toEqual([{ id: "q1", text: "rerun the migration" }]);
    // The stale transcript went with the viewport — it is refetched on re-dock,
    // and `loaded` goes back to false so the host's drain effect re-fires.
    expect(after.s1?.messages).toEqual([]);
    expect(after.s1?.loaded).toBe(false);

    // On disk, and back again: this is what a reload restores.
    const written = persist(after);
    expect(written).not.toBeNull();
    const restored = JSON.parse(written as string) as Record<string, DockQueuedMessage[]>;
    expect(restored.s1[0].text).toBe("rerun the migration");
    // Same id, so re-submission is idempotent against the engine.
    expect(restored.s1[0].id).toBe("q1");
  });

  test("closing a bubble whose queue already drained leaves no tombstone", () => {
    // The reachable release path: `dequeue` emptied `queued` on the engine's
    // 202, so there is nothing to park and the id must go entirely.
    const before: Record<string, Runtime | undefined> = {
      s1: runtimeWith([], { loaded: true }),
    };
    const after = releaseRuntime(before, "s1");
    expect("s1" in after).toBe(false);
    // No key at all rather than `{}` — the drained-session rule `writeQueue`
    // already follows for the session surface's own key.
    expect(persist(after)).toBeNull();
  });

  test("closing one bubble never touches another session's queue", () => {
    const before: Record<string, Runtime | undefined> = {
      s1: runtimeWith([{ id: "q1", text: "mine" }]),
      s2: runtimeWith([{ id: "q2", text: "someone else's" }]),
    };
    const after = releaseRuntime(before, "s1");
    expect(after.s2?.queued).toEqual([{ id: "q2", text: "someone else's" }]);
  });

  test("a parked map cannot grow without a ceiling", () => {
    // Retention removed this key's only pruner (undock/clearAutoDock used to
    // delete an id outright), so a session that can never be delivered to —
    // deleted server-side, POST failing forever — would otherwise be immortal.
    const fat = "x".repeat(200 * 1024);
    const state: Record<string, Runtime | undefined> = {
      oldest: runtimeWith([{ id: "a", text: fat }]),
      middle: runtimeWith([{ id: "b", text: fat }]),
      newest: runtimeWith([{ id: "c", text: fat }]),
    };
    const written = persist(state);
    expect(written).not.toBeNull();
    expect(written!.length).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
    const restored = JSON.parse(written as string) as Record<string, DockQueuedMessage[]>;
    // Oldest-first eviction: the newest parked words are the ones still on the
    // user's mind, same rule as `fitToBudget`'s step 3.
    expect(Object.keys(restored)).toEqual(["middle", "newest"]);
  });
});

describe("fitQueueMapToBudget — the ceiling itself", () => {
  test("a map that fits is handed back untouched, identity and all", () => {
    // Identity matters: the provider memoizes on this and re-serializes on every
    // change, so a fresh object per render would defeat the write gate.
    const map = { s1: [{ id: "a", text: "small" }] };
    const fit = fitQueueMapToBudget(map);
    expect(fit.map).toBe(map);
    expect(fit.droppedSessions).toEqual([]);
  });

  test("sessions are evicted WHOLE, oldest first, until it fits", () => {
    const item = (text: string) => [{ id: text, text }];
    const fit = fitQueueMapToBudget(
      { a: item("aaaa"), b: item("bbbb"), c: item("cccc") },
      // Room for roughly one session's entry.
      40,
    );
    expect(fit.droppedSessions).toEqual(["a", "b"]);
    // Never a partial session: "sends in order" is a promise a queue missing its
    // middle cannot keep.
    expect(fit.map).toEqual({ c: item("cccc") });
  });

  test("one session too large for the budget alone still empties out rather than looping", () => {
    const fit = fitQueueMapToBudget({ only: [{ id: "x", text: "y".repeat(200) }] }, 32);
    expect(fit.droppedSessions).toEqual(["only"]);
    expect(fit.map).toEqual({});
  });
});
