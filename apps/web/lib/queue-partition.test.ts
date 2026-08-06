// ISSUE #31 — WHO OWNS A MESSAGE, AND WHEN.
//
// The bug was a one-line membership rule: the queue box was fed by a filter
// that removed only the TERMINAL states, so a message the engine had already
// claimed and was answering stayed under "Queued · sends in order", badged
// RUNNING, while the same message rendered as a sent user bubble above it.
//
// What is worth proving here is not that `running` is gone — a wider filter
// would do that and would ALSO silently swallow `failed`, which is the strictly
// worse bug. It is that the three groups stay three: a message is waiting, or
// in flight, or broken, and each has exactly one owner.
//
// Kept out of `message-queue.test.ts` deliberately: that file is about the
// order of sacrifice under a byte budget, a different policy with a different
// reason to change.

// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SessionQueueState } from "@telar/core";
import {
  isTerminalQueueState,
  partitionQueue,
  type QueueItemLifecycle,
} from "./message-queue";

const WEB_ROOT = new URL("../", import.meta.url);
const sessionView = () =>
  readFileSync(new URL("components/session/session-view.tsx", WEB_ROOT), "utf8");

type Item = { id: string; state?: QueueItemLifecycle; accepted?: boolean; error?: string };
const item = (id: string, state?: QueueItemLifecycle): Item => ({ id, state });
const ids = (items: Item[]) => items.map((i) => i.id);

describe("partitionQueue — the queue box shows what is WAITING, not what is taken", () => {
  test("a claimed or running message leaves the queue entirely — the transcript owns it", () => {
    // THE REGRESSION ITSELF. Before the fix both of these survived into the
    // rendered queue because neither is `committed` or `cancelled`.
    const p = partitionQueue([item("a", "claimed"), item("b", "running")]);
    expect(ids(p.waiting)).toEqual([]);
    expect(ids(p.inFlight)).toEqual(["a", "b"]);
    expect(ids(p.attention)).toEqual([]);
  });

  test("the count the badge renders is the WAITING set, not the tracked set", () => {
    // A badge reading 1 beside a message the agent is visibly answering is the
    // specific thing that reads as a pending duplicate send.
    const p = partitionQueue([item("answering", "running"), item("next", "queued")]);
    expect(p.waiting.length).toBe(1);
    expect(ids(p.waiting)).toEqual(["next"]);
  });

  test("failed and ambiguous are KEPT — a message that did not send may never vanish", () => {
    // The anti-regression for the tempting fix ("keep only queued"). Losing a
    // message the user committed to is the failure #5 and #7 exist to prevent;
    // showing it twice was merely confusing.
    const p = partitionQueue([item("f", "failed"), item("g", "ambiguous")]);
    expect(ids(p.attention)).toEqual(["f", "g"]);
    expect(ids(p.waiting)).toEqual([]);
    expect(ids(p.inFlight)).toEqual([]);
  });

  test("failed items are NOT in the waiting set — they are errors, not a send order", () => {
    const p = partitionQueue([item("f", "failed"), item("q", "queued")]);
    expect(ids(p.waiting)).toEqual(["q"]);
    expect(p.waiting).not.toContainEqual(item("f", "failed"));
  });

  test("terminal items are dropped from every group", () => {
    const p = partitionQueue([item("c", "committed"), item("x", "cancelled")]);
    expect(p.waiting.length + p.inFlight.length + p.attention.length).toBe(0);
  });

  test("a local pre-ack item with no state yet is WAITING, not lost", () => {
    // Items exist client-side between Enter and the engine's acknowledgement
    // (attachment upload). They have no `state` at all, and dropping them would
    // make a just-queued message flicker out of its own chip.
    const p = partitionQueue([item("local", undefined)]);
    expect(ids(p.waiting)).toEqual(["local"]);
  });

  test("every member of the lifecycle union is classified — no state falls through", () => {
    // A CLOSED LIST, AND NOW CLOSED OVER SOMETHING. This used to enumerate a
    // local `QueueItemLifecycle[]` literal, which proved nothing: TypeScript
    // never requires an array to COVER a union, so a state added to the engine
    // compiled here untouched and `partitionQueue` defaulted it into `waiting`
    // — the exact failure this file exists to prevent.
    //
    // A `Record` over the union IS exhaustive: a member added to core's
    // SessionQueueState makes this object a compile error until someone decides
    // which surface owns the new state. `partitionQueue`'s `never` default is
    // the other half — the two together are the closed list.
    const expected: Record<SessionQueueState, "waiting" | "inFlight" | "attention" | "dropped"> = {
      queued: "waiting",
      claimed: "inFlight",
      running: "inFlight",
      failed: "attention",
      ambiguous: "attention",
      committed: "dropped",
      cancelled: "dropped",
    };
    const classified: Record<string, string> = {};
    for (const state of Object.keys(expected) as SessionQueueState[]) {
      const p = partitionQueue([item(state, state)]);
      if (p.waiting.length) classified[state] = "waiting";
      else if (p.inFlight.length) classified[state] = "inFlight";
      else if (p.attention.length) classified[state] = "attention";
      else classified[state] = "dropped";
    }
    expect(classified).toEqual(expected);
  });

  test("the lifecycle type IS the engine's union, not a copy of it", () => {
    // Belt to the Record's braces: if `QueueItemLifecycle` ever drifts back
    // into a hand-maintained literal, these two assignments stop compiling.
    const fromCore: QueueItemLifecycle = "ambiguous" satisfies SessionQueueState;
    const toCore: SessionQueueState = fromCore;
    expect(toCore).toBe("ambiguous");
  });

  test("a local message the engine REFUSED is attention, not a promise to send", () => {
    // `enqueueWithEngine`'s catch records an error and no state, and the retry
    // effect skips any item carrying an error — so this message will never
    // send. Under "Queued · sends in order", with no state and therefore no
    // badge, it was pixel-identical to one that would.
    const refused: Item = { id: "refused", error: "HTTP 500", accepted: false };
    const uploading: Item = { id: "uploading" };
    const p = partitionQueue([refused, uploading]);
    expect(ids(p.attention)).toEqual(["refused"]);
    expect(ids(p.waiting)).toEqual(["uploading"]);
  });

  test("an ACCEPTED item's stale error does not drag it out of its engine state", () => {
    // `refreshEngineQueue` copies `error` off the envelope, and a failed item
    // already carries one. Only the never-accepted case is a local refusal.
    const p = partitionQueue([{ id: "a", state: "queued", accepted: true, error: "old" }]);
    expect(ids(p.waiting)).toEqual(["a"]);
  });

  test("send order is preserved within the waiting group", () => {
    // The heading promises "sends in order"; the chips are numbered 1..n from
    // this array, so a reordering partition would mislabel the send order.
    const p = partitionQueue([
      item("1", "queued"),
      item("taken", "running"),
      item("2", "queued"),
      item("3"),
    ]);
    expect(ids(p.waiting)).toEqual(["1", "2", "3"]);
  });

  test("partitioning is total — nothing is duplicated across groups", () => {
    const input = [
      item("a", "queued"),
      item("b", "running"),
      item("c", "failed"),
      item("d", "committed"),
    ];
    const p = partitionQueue(input);
    const seen = [...p.waiting, ...p.inFlight, ...p.attention].map((i) => i.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(["a", "b", "c"]);
  });
});

// A pure partition is only half the fix — the view has to actually use it. This
// app has no component harness (story 3.1 hard rule 9), so the SOURCE TEXT is
// the executable form of "this list is wired to that group", the same way
// `composer-disable.test.ts` and `right-panel-mount.test.ts` already work.
describe("issue #31 — session-view renders the partition, not the tracked set", () => {
  test("the old terminal-only filter is gone", () => {
    const src = sessionView();
    // The exact expression that caused the bug. Its absence is the fix.
    expect(src).not.toContain('item.state !== "committed" && item.state !== "cancelled"');
    expect(src).toContain("!isTerminalQueueState(item.state)");
  });

  test("the queue box and its badge are both driven by the WAITING group", () => {
    const src = sessionView();
    expect(src).toContain("{queueView.waiting.length > 0 && (");
    expect(src).toContain("{queueView.waiting.map((m, i) => (");
    expect(src).toContain("{queueView.waiting.length}");
    // The badge and the list must not disagree: if either still reads the
    // tracked set, a running item is being counted or drawn again.
    expect(src).not.toContain("{messageQueue.length}");
    expect(src).not.toContain("{messageQueue.map(");
  });

  test("the two blocks are disjoint: each heading sits in exactly one of them", () => {
    const src = sessionView();
    const waitingAt = src.indexOf("{queueView.waiting.length > 0 && (");
    const attentionAt = src.indexOf("{queueView.attention.length > 0 && (");
    expect(waitingAt).toBeGreaterThan(-1);
    expect(attentionAt).toBeGreaterThan(waitingAt);

    const waitingBlock = src.slice(waitingAt, attentionAt);
    const attentionBlock = src.slice(attentionAt);
    // "sends in order" is a promise about a send that has not happened yet, so
    // it may only ever appear over the waiting group.
    expect(waitingBlock).toContain("Queued · sends in order");
    expect(attentionBlock).not.toContain("Queued · sends in order");
    // Errors get their own copy, and must not be able to borrow the queue's.
    expect(attentionBlock).toContain("Not sent · needs your attention");
    expect(waitingBlock).not.toContain("Not sent · needs your attention");
  });

  test("the un-numbered attention chips carry no ordinal implying a send order", () => {
    const src = sessionView();
    const attentionBlock = src.slice(src.indexOf("{queueView.attention.length > 0 && ("));
    expect(attentionBlock).toContain("{queueView.attention.map((m) => (");
    expect(attentionBlock).not.toContain("index={");
  });

  test("in-flight items render ONLY where nothing else is speaking for them", () => {
    const src = sessionView();
    // WAS `not.toContain("queueView.inFlight")`, and that rule was right about
    // half the world and wrong about the other half. A claimed message is
    // owned by the transcript ONLY while this mount is streaming it; a queued
    // turn drained server-side (kickSessionQueue → its own POST /api/chat) is
    // fed to no mount at all, so hiding the chip there left the user's message
    // with no representation anywhere. `!busy` is exactly "this mount is not
    // streaming the answer", so the anti-duplicate rule survives intact and is
    // now stated where it is actually true.
    const gate = "{!busy && queueView.inFlight.length > 0 && (";
    const at = src.indexOf(gate);
    expect(at).toBeGreaterThan(-1);
    // Nothing outside that gate may touch the group — one render site, always
    // behind the busy check.
    const end = src.indexOf("{queueView.attention.length > 0 && (", at);
    expect(end).toBeGreaterThan(at);
    expect(src.slice(0, at)).not.toContain("queueView.inFlight");
    expect(src.slice(end)).not.toContain("queueView.inFlight");
    // In-flight chips carry no ordinal and no controls: core admits neither an
    // edit nor a cancel once an item is claimed.
    const block = src.slice(at, end);
    expect(block).not.toContain("index={");
    expect(block).not.toContain("onEdit");
    expect(block).not.toContain("onRemove");
  });

  test("Resume is reachable in the state the engine actually pauses in", () => {
    const src = sessionView();
    // The engine pauses when it mints an attention item (failSessionTurn then
    // pauseSessionQueue; recoverSessionQueue behind an `ambiguous`), so the
    // canonical paused queue has ZERO waiting items. Nested in the waiting
    // block, the heading and the Resume button were both unreachable exactly
    // then — and `claimNextSessionTurn` returns null while paused, so that is a
    // stopped queue the user cannot see or restart.
    const pausedAt = src.indexOf("{engineQueuePaused && (");
    const waitingAt = src.indexOf("{queueView.waiting.length > 0 && (");
    expect(pausedAt).toBeGreaterThan(-1);
    expect(pausedAt).toBeLessThan(waitingAt);
    // Exactly one Resume control, and it is in that block.
    expect(src.split("resumeEngineQueue()").length - 1).toBe(1);
    expect(src.slice(pausedAt, waitingAt)).toContain("resumeEngineQueue()");
  });

  test("the attention block offers only the acts the engine will honour", () => {
    const src = sessionView();
    const at = src.indexOf("{queueView.attention.length > 0 && (");
    const block = src.slice(at, src.indexOf("{attachmentError && (", at));
    // An ACCEPTED failed/ambiguous item cannot be edited (core: "only queued
    // items may be edited"), so it is handed no editor at all rather than a
    // pencil that cannot fire and a "Click to edit" tooltip that lies.
    expect(block).toContain("onEdit={m.accepted ? undefined : () => setEditingQueueId(m.id)}");
    // Removal is the one act that must work, or the block is a permanent
    // undismissable red box. It reaches DELETE for engine-owned items…
    expect(block).toContain("if (m.accepted) void removeEngineQueueItem(m);");
    // …which now has a transition to land on.
    const route = readFileSync(
      new URL("app/api/chat/[sessionId]/queue/[itemId]/route.ts", WEB_ROOT),
      "utf8",
    );
    expect(route).toContain("dismissFailedSessionTurn");
  });

  test("an edit interrupted by the engine is closed and admitted, not dropped in silence", () => {
    const src = sessionView();
    // A chip that leaves the editable set unmounts, and React fires no blur on
    // unmount — the draft went nowhere and `editingQueueId` was left pointing
    // at a row rendered in no block. The edit was unappliable either way
    // ("only queued items may be edited"); saying so is the difference between
    // a curated list and one that quietly discards what you type into it.
    expect(src).toContain("if (!tracked.accepted || tracked.state === \"queued\") return;");
    expect(src).toContain(
      "The agent took that message before your edit landed — the edit was not applied.",
    );
  });

  test("the 2s poll still measures the TRACKED set, so in-flight items keep it alive", () => {
    const src = sessionView();
    // If this stop condition were narrowed to `queueView.waiting.length`, the
    // poll would stop the moment the engine claimed the last item and the queue
    // would never learn it committed — the stale-until-you-navigate-away
    // symptom, reintroduced underneath the fix for it.
    expect(src).toContain("if (!busy && messageQueue.length === 0) return;");
    expect(src).not.toContain("queueView.waiting.length === 0) return;");
  });
});

describe("isTerminalQueueState — the poll's stop condition depends on it", () => {
  test("only committed and cancelled are terminal", () => {
    // `refreshEngineQueue` drops terminal items from the tracked set, and the
    // 2s poll stops when that set is empty. Calling an in-flight state terminal
    // here would stop the poll before the item ever reaches `committed` — the
    // stale-until-you-navigate-away symptom, reintroduced from the other side.
    expect(isTerminalQueueState("committed")).toBe(true);
    expect(isTerminalQueueState("cancelled")).toBe(true);
    for (const live of ["queued", "claimed", "running", "failed", "ambiguous"] as const) {
      expect(isTerminalQueueState(live)).toBe(false);
    }
    expect(isTerminalQueueState(undefined)).toBe(false);
  });
});
