// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import type { Subscription } from "@telar/engine-client";
import { applyReads, applyUnfollow, claim, createFollowingController, emptyFollowing, generationOf, lockKey, release } from "./following";

const sub = (id: string, target = "watched"): Subscription =>
  ({ id, subscriberSessionId: "coord", targetSessionId: target, events: ["turn_completed"], createdAt: 1 }) as Subscription;

const read = (key: string, subscriptions?: readonly Subscription[], startedAt = 0) => ({
  key,
  startedAt,
  ...(subscriptions ? { subscriptions } : {}),
});

test("a failed read preserves the last good answer; a first failure shows nothing", () => {
  // An empty group claims nothing is followed; a failure is not that evidence.
  const good = applyReads(emptyFollowing(), [read("k", [sub("s1")])]);
  expect(applyReads(good, [read("k")]).byCoordinator.get("k")).toHaveLength(1);
  expect(applyReads(emptyFollowing(), [read("k")]).byCoordinator.has("k")).toBe(false);
});

test("a failed unfollow keeps the row and reports failure; a successful one removes it", () => {
  const state = applyReads(emptyFollowing(), [read("k", [sub("s1")])]);
  const bad = applyUnfollow(state, "k", [{ subscriptionId: "s1", removed: false }]);
  expect(bad.failed).toBe(true);
  expect(bad.state.byCoordinator.get("k")).toHaveLength(1);

  const good = applyUnfollow(state, "k", [{ subscriptionId: "s1", removed: true }]);
  expect(good.failed).toBe(false);
  expect(good.state.byCoordinator.get("k")).toEqual([]);
});

test("a target followed TWICE unfollows both; a partial failure keeps what survived", () => {
  const state = applyReads(emptyFollowing(), [read("k", [sub("s1"), sub("s2")])]);
  const both = applyUnfollow(state, "k", [
    { subscriptionId: "s1", removed: true },
    { subscriptionId: "s2", removed: true },
  ]);
  expect(both.state.byCoordinator.get("k")).toEqual([]);

  const partial = applyUnfollow(state, "k", [
    { subscriptionId: "s1", removed: true },
    { subscriptionId: "s2", removed: false },
  ]);
  expect(partial.state.byCoordinator.get("k")?.map((s) => s.id)).toEqual(["s2"]);
  expect(partial.failed).toBe(true);
});

test("a read STARTED BEFORE a delete cannot resurrect the row when it resolves after", async () => {
  // An in-flight read carries the pre-delete list and must not restore it.
  let state = applyReads(emptyFollowing(), [read("k", [sub("s1")])]);

  const startedAt = generationOf(state, "k");
  let settle!: (value: readonly Subscription[]) => void;
  const inFlight = new Promise<readonly Subscription[]>((resolve) => (settle = resolve));

  state = applyUnfollow(state, "k", [{ subscriptionId: "s1", removed: true }]).state;
  expect(state.byCoordinator.get("k")).toEqual([]);

  settle([sub("s1")]);
  state = applyReads(state, [read("k", await inFlight, startedAt)]);
  expect(state.byCoordinator.get("k")).toEqual([]);
});

test("a read started AFTER a delete is honoured", async () => {
  let state = applyReads(emptyFollowing(), [read("k", [sub("s1")])]);
  state = applyUnfollow(state, "k", [{ subscriptionId: "s1", removed: true }]).state;
  const startedAt = generationOf(state, "k");
  state = applyReads(state, [read("k", [sub("s9")], startedAt)]);
  expect(state.byCoordinator.get("k")?.map((s) => s.id)).toEqual(["s9"]);
});

test("UNPIN then REPIN starts clean rather than showing a stale list", () => {
  let state = applyReads(emptyFollowing(), [read("k", [sub("s1")])]);
  state = applyReads(state, []); // unpinned: dropped entirely
  expect(state.byCoordinator.size).toBe(0);
  state = applyReads(state, [read("k")]);
  expect(state.byCoordinator.has("k")).toBe(false);
});

test("the lock is SYNCHRONOUS, so two clicks before a render start one request", async () => {
  // A `useState` updater is not a lock: React may defer it and StrictMode runs it twice.
  const locks = new Set<string>();
  const key = lockKey(undefined, "coord", "local:watched");
  const requests: string[] = [];

  let settle!: () => void;
  const pending = new Promise<void>((resolve) => (settle = resolve));
  const click = async () => {
    if (!claim(locks, key)) return;
    requests.push(key);
    await pending;
    release(locks, key);
  };

  const first = click();
  const second = click();
  expect(requests).toHaveLength(1);

  settle();
  await Promise.all([first, second]);
  await click();
  expect(requests).toHaveLength(2);
});

test("locks are per coordinator AND target, so one row never blocks another", () => {
  const locks = new Set<string>();
  expect(claim(locks, lockKey(undefined, "coord", "local:a"))).toBe(true);
  expect(claim(locks, lockKey(undefined, "coord", "local:b"))).toBe(true);
  expect(claim(locks, lockKey("other-mac", "coord", "local:a"))).toBe(true);
  expect(claim(locks, lockKey(undefined, "coord", "local:a"))).toBe(false);
});

function deferredFetch() {
  const waiting = new Map<string, (value: readonly Subscription[]) => void>();
  const calls: string[] = [];
  const fetch = (session: { id: string }) => {
    calls.push(session.id);
    return new Promise<readonly Subscription[]>((resolve) => waiting.set(session.id, resolve));
  };
  return { fetch, calls, settle: (id: string, value: readonly Subscription[]) => waiting.get(id)?.(value) };
}

const pinned = (id: string) => ({ id, key: `local:${id}` });

test("a LATE read from a superseded pinned set is dropped", async () => {
  // Unpin A, pin B, A's answer arrives last. `live` guards starting a read, not
  // its completion, so the epoch must discard A.
  const seen: ReturnType<typeof emptyFollowing>[] = [];
  const controller = createFollowingController((state) => seen.push(state));
  const a = deferredFetch();
  const b = deferredFetch();

  const readA = controller.read([pinned("A")], a.fetch);
  controller.bump();
  const readB = controller.read([pinned("B")], b.fetch);

  b.settle("B", [sub("s_b")]);
  expect(await readB).toBe(true);

  a.settle("A", [sub("s_a")]);
  expect(await readA).toBe(false);

  const final = controller.snapshot();
  expect(final.byCoordinator.has("local:A")).toBe(false);
  expect(final.byCoordinator.get("local:B")?.map((s) => s.id)).toEqual(["s_b"]);
});

test("two OVERLAPPING ticks: the older response loses", async () => {
  const controller = createFollowingController(() => {});
  const first = deferredFetch();
  const second = deferredFetch();

  const older = controller.read([pinned("A")], first.fetch);
  const newer = controller.read([pinned("A")], second.fetch);

  second.settle("A", [sub("s_new")]);
  expect(await newer).toBe(true);
  first.settle("A", [sub("s_old")]);
  expect(await older).toBe(false);

  expect(controller.snapshot().byCoordinator.get("local:A")?.map((s) => s.id)).toEqual(["s_new"]);
});

test("the controller's lock stops a second unfollow before the first resolves", async () => {
  const controller = createFollowingController(() => {});
  await controller.read([pinned("A")], async () => [sub("s1")]);

  const sent: string[] = [];
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => (settle = resolve));
  const unfollowOne = async (_session: { id: string }, subscriptionId: string) => {
    sent.push(subscriptionId);
    await pending;
  };

  const one = controller.unfollow(pinned("A"), "local:watched", ["s1"], unfollowOne);
  const two = controller.unfollow(pinned("A"), "local:watched", ["s1"], unfollowOne);
  expect(await two).toEqual({ started: false, failed: false });
  expect(sent).toEqual(["s1"]);

  settle();
  expect(await one).toMatchObject({ started: true, failed: false });
  expect(controller.snapshot().byCoordinator.get("local:A")).toEqual([]);
});

test("a read in flight during an unfollow cannot resurrect the removed row", async () => {
  const controller = createFollowingController(() => {});
  await controller.read([pinned("A")], async () => [sub("s1")]);

  const slow = deferredFetch();
  const reading = controller.read([pinned("A")], slow.fetch);
  await controller.unfollow(pinned("A"), "local:watched", ["s1"], async () => undefined);
  expect(controller.snapshot().byCoordinator.get("local:A")).toEqual([]);

  slow.settle("A", [sub("s1")]);
  await reading;
  expect(controller.snapshot().byCoordinator.get("local:A")).toEqual([]);
});

test("a FAILED follow reports failure and changes nothing", async () => {
  // A rejected POST must not look like a successful follow.
  const controller = createFollowingController(() => {});
  await controller.read([pinned("A")], async () => []);
  const outcome = await controller.follow(
    pinned("A"),
    { id: "watched", key: "local:watched" },
    async () => {
      throw new Error("no");
    },
    async () => [sub("s1")],
  );
  expect(outcome).toEqual({ started: true, failed: true });
  expect(controller.snapshot().byCoordinator.get("local:A")).toEqual([]);
});

test("two FOLLOW clicks before the first resolves send one request", async () => {
  const controller = createFollowingController(() => {});
  const sent: string[] = [];
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => (settle = resolve));
  const create = async (_c: { id: string }, target: string) => {
    sent.push(target);
    await pending;
  };

  const one = controller.follow(pinned("A"), { id: "watched", key: "local:watched" }, create, async () => [sub("s1")]);
  const two = controller.follow(pinned("A"), { id: "watched", key: "local:watched" }, create, async () => [sub("s1")]);
  expect(await two).toEqual({ started: false, failed: false });
  expect(sent).toEqual(["watched"]);
  settle();
  expect(await one).toMatchObject({ started: true, failed: false });
});

test("following ONE coordinator preserves every other coordinator's state", async () => {
  // A single coordinator passed to a full read rebuilds the map without the others.
  const controller = createFollowingController(() => {});
  await controller.read([pinned("A"), pinned("B")], async (session) =>
    session.id === "A" ? [sub("s_a")] : [sub("s_b")],
  );
  await controller.follow(
    pinned("A"),
    { id: "watched", key: "local:watched" },
    async () => undefined,
    async () => [sub("s_a"), sub("s_a2")],
  );
  const state = controller.snapshot();
  expect(state.byCoordinator.get("local:A")?.map((s) => s.id)).toEqual(["s_a", "s_a2"]);
  expect(state.byCoordinator.get("local:B")?.map((s) => s.id)).toEqual(["s_b"]);
});

test("a follow's scoped refresh does NOT supersede a full read in flight", async () => {
  // A scoped refresh must not bump the shared epoch and discard a running full read.
  const controller = createFollowingController(() => {});
  const slow = deferredFetch();
  const fullRead = controller.read([pinned("A"), pinned("B")], slow.fetch);

  await controller.follow(pinned("A"), { id: "w", key: "local:w" }, async () => undefined, async () => [sub("s_a")]);

  slow.settle("A", [sub("s_a_full")]);
  slow.settle("B", [sub("s_b")]);
  expect(await fullRead).toBe(true);
  expect(controller.snapshot().byCoordinator.get("local:B")?.map((s) => s.id)).toEqual(["s_b"]);
});

test("a pinned-set change while a follow awaits does not resurrect an unpinned coordinator", async () => {
  const controller = createFollowingController(() => {});
  await controller.read([pinned("A"), pinned("B")], async (session) => (session.id === "A" ? [sub("s_a")] : [sub("s_b")]));

  await controller.read([pinned("A")], async () => [sub("s_a")]);
  expect(controller.snapshot().byCoordinator.has("local:B")).toBe(false);

  await controller.follow(pinned("A"), { id: "w", key: "local:w" }, async () => undefined, async () => [sub("s_a")]);
  expect(controller.snapshot().byCoordinator.has("local:B")).toBe(false);
});

test("a coordinator UNPINNED during the POST is not resurrected by the follow", async () => {
  const controller = createFollowingController(() => {});
  await controller.read([pinned("A"), pinned("B")], async (session) => (session.id === "A" ? [sub("s_a")] : [sub("s_b")]));

  let releasePost!: () => void;
  const post = new Promise<void>((resolve) => (releasePost = resolve));
  const following = controller.follow(
    pinned("A"),
    { id: "w", key: "local:w" },
    async () => post,
    async () => [sub("s_a"), sub("s_new")],
  );

  await controller.read([pinned("B")], async () => [sub("s_b")]);
  expect(controller.snapshot().byCoordinator.has("local:A")).toBe(false);

  releasePost();
  await following;
  expect(controller.snapshot().byCoordinator.has("local:A")).toBe(false);
  expect(controller.snapshot().byCoordinator.get("local:B")?.map((s) => s.id)).toEqual(["s_b"]);
});

test("a coordinator UNPINNED during the FETCH is not resurrected either", async () => {
  const controller = createFollowingController(() => {});
  await controller.read([pinned("A"), pinned("B")], async (session) => (session.id === "A" ? [sub("s_a")] : [sub("s_b")]));

  const slow = deferredFetch();
  const following = controller.follow(pinned("A"), { id: "w", key: "local:w" }, async () => undefined, slow.fetch);
  await controller.read([pinned("B")], async () => [sub("s_b")]);

  slow.settle("A", [sub("s_a"), sub("s_new")]);
  await following;
  expect(controller.snapshot().byCoordinator.has("local:A")).toBe(false);
});

test("a STALE full read resolving AFTER a successful follow cannot erase the new subscription", async () => {
  // Without bumping the coordinator's generation, the pre-create read would land
  // last and delete what was just added.
  const controller = createFollowingController(() => {});
  await controller.read([pinned("A")], async () => [sub("s_a")]);

  const slow = deferredFetch();
  const stale = controller.read([pinned("A")], slow.fetch);

  await controller.follow(pinned("A"), { id: "w", key: "local:w" }, async () => undefined, async () => [sub("s_a"), sub("s_new")]);
  expect(controller.snapshot().byCoordinator.get("local:A")?.map((s) => s.id)).toEqual(["s_a", "s_new"]);

  slow.settle("A", [sub("s_a")]);
  await stale;
  expect(controller.snapshot().byCoordinator.get("local:A")?.map((s) => s.id)).toEqual(["s_a", "s_new"]);
});
