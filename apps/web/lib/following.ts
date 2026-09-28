import type { Subscription } from "@telar/engine-client";

/** The sidebar's Following state, extracted so its state rules are testable. */

/** Subscriptions per coordinator, keyed by `sessionKey`. */
export type FollowingState = {
  byCoordinator: ReadonlyMap<string, readonly Subscription[]>;
  /** Mutations seen per coordinator; a read that started before a delete carries a stale generation and is discarded. */
  generation: ReadonlyMap<string, number>;
};

export const emptyFollowing = (): FollowingState => ({ byCoordinator: new Map(), generation: new Map() });

export const generationOf = (state: FollowingState, key: string): number => state.generation.get(key) ?? 0;

/** One coordinator's read result. `undefined` means the request failed. */
export type FollowingRead = { key: string; subscriptions?: readonly Subscription[]; startedAt: number };

/**
 * A failed read preserves the last good answer; a read older than the current generation is
 * dropped, so an in-flight read cannot undo a delete.
 */
export function applyReads(
  state: FollowingState,
  reads: readonly FollowingRead[],
  /**
   * `full` represents the whole pinned set, so absent coordinators are dropped;
   * `scoped` merges only the coordinators it names.
   */
  mode: "full" | "scoped" = "full",
): FollowingState {
  const byCoordinator = mode === "scoped" ? new Map(state.byCoordinator) : new Map<string, readonly Subscription[]>();
  const generation = mode === "scoped" ? new Map(state.generation) : new Map<string, number>();
  for (const read of reads) {
    // For a scoped fold, a coordinator a full read already dropped must not come back.
    if (mode === "scoped" && !state.byCoordinator.has(read.key)) continue;
    const stale = read.startedAt < generationOf(state, read.key);
    const kept = read.subscriptions !== undefined && !stale ? read.subscriptions : state.byCoordinator.get(read.key);
    if (kept) byCoordinator.set(read.key, kept);
    else if (mode === "full") byCoordinator.delete(read.key);
    generation.set(read.key, generationOf(state, read.key));
  }
  return { byCoordinator, generation };
}

/** Drop only what the engine removed, and bump the generation so an in-flight read cannot resurrect it. */
export function applyUnfollow(
  state: FollowingState,
  key: string,
  outcomes: readonly { subscriptionId: string; removed: boolean }[],
): { state: FollowingState; failed: boolean } {
  const removed = new Set(outcomes.filter((outcome) => outcome.removed).map((outcome) => outcome.subscriptionId));
  const byCoordinator = new Map(state.byCoordinator);
  byCoordinator.set(key, (byCoordinator.get(key) ?? []).filter((subscription) => !removed.has(subscription.id)));
  const generation = new Map(state.generation);
  generation.set(key, generationOf(state, key) + 1);
  return { state: { byCoordinator, generation }, failed: !outcomes.every((outcome) => outcome.removed) };
}

/**
 * A synchronous lock key, since a `useState` updater is not a lock (StrictMode runs it twice).
 * Keyed by coordinator and target, so one row never blocks another.
 */
export function lockKey(hostId: string | undefined, coordinatorId: string, targetKey: string): string {
  return `${hostId ?? "local"}:${coordinatorId}:${targetKey}`;
}

export function claim(locks: Set<string>, key: string): boolean {
  if (locks.has(key)) return false;
  locks.add(key);
  return true;
}

export const release = (locks: Set<string>, key: string): void => void locks.delete(key);

/**
 * The controller below lives outside React: mutating refs in a `setState` updater is impure,
 * and a read carries the epoch it began in so a superseded answer is dropped.
 */
export type FollowingFetch = (session: { id: string; hostId?: string }) => Promise<readonly Subscription[]>;
export type FollowingUnfollow = (session: { id: string; hostId?: string }, subscriptionId: string) => Promise<void>;

export function createFollowingController(onChange: (state: FollowingState) => void) {
  let state = emptyFollowing();
  let epoch = 0;
  const locks = new Set<string>();

  const publish = (next: FollowingState) => {
    state = next;
    onChange(state);
  };

  return {
    snapshot: () => state,
    /** Invalidate in-flight reads. Called when the pinned set changes. */
    bump: () => void (epoch += 1),
    locked: (key: string) => locks.has(key),

    async read(sessions: readonly { id: string; hostId?: string; key: string }[], fetch: FollowingFetch): Promise<boolean> {
      const started = (epoch += 1);
      const reads = await Promise.all(
        sessions.map(async (session) => {
          const startedAt = generationOf(state, session.key);
          const subscriptions = await fetch(session).then((value) => value, () => undefined);
          return { key: session.key, startedAt, ...(subscriptions ? { subscriptions } : {}) };
        }),
      );
      // A superseded epoch's answer would reintroduce sessions the rail has dropped.
      if (started !== epoch) return false;
      publish(applyReads(state, reads));
      return true;
    },

    /** Scoped refresh of one coordinator: merges, and does not bump the shared epoch. */
    async follow(
      coordinator: { id: string; hostId?: string; key: string },
      target: { id: string; key: string },
      create: (coordinator: { id: string; hostId?: string }, targetSessionId: string) => Promise<void>,
      fetch: FollowingFetch,
    ): Promise<{ started: boolean; failed: boolean }> {
      const lock = lockKey(coordinator.hostId, coordinator.id, target.key);
      if (!claim(locks, lock)) return { started: false, failed: false };
      try {
        const ok = await create(coordinator, target.id).then(() => true, () => false);
        if (!ok) return { started: true, failed: true };
        /** Bump this coordinator's generation, or an in-flight full read would erase the new subscription. */
        const generation = new Map(state.generation);
        generation.set(coordinator.key, generationOf(state, coordinator.key) + 1);
        state = { byCoordinator: state.byCoordinator, generation };
        const startedAt = generationOf(state, coordinator.key);
        const subscriptions = await fetch(coordinator).then((value) => value, () => undefined);
        publish(applyReads(state, [{ key: coordinator.key, startedAt, ...(subscriptions ? { subscriptions } : {}) }], "scoped"));
        return { started: true, failed: false };
      } finally {
        release(locks, lock);
      }
    },

    async unfollow(
      coordinator: { id: string; hostId?: string; key: string },
      targetKey: string,
      subscriptionIds: readonly string[],
      unfollowOne: FollowingUnfollow,
    ): Promise<{ started: boolean; failed: boolean }> {
      const lock = lockKey(coordinator.hostId, coordinator.id, targetKey);
      if (!claim(locks, lock)) return { started: false, failed: false };
      try {
        const outcomes = await Promise.all(
          subscriptionIds.map(async (subscriptionId) => ({
            subscriptionId,
            removed: await unfollowOne(coordinator, subscriptionId).then(() => true, () => false),
          })),
        );
        const applied = applyUnfollow(state, coordinator.key, outcomes);
        publish(applied.state);
        return { started: true, failed: applied.failed };
      } finally {
        release(locks, lock);
      }
    },
  };
}
export type FollowingController = ReturnType<typeof createFollowingController>;
