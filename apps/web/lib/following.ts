import type { Subscription } from "@telar/engine-client";

/**
 * The Following state a sidebar holds, and the three rules that make it honest.
 *
 * Extracted from the component so it is testable as itself: every bug this
 * replaced was a state bug — a removal claimed on a failed request, an empty
 * list asserted from a failed read, a stale read resurrecting a deleted row.
 */

/** Subscriptions per coordinator, keyed by `sessionKey`. */
export type FollowingState = {
  byCoordinator: ReadonlyMap<string, readonly Subscription[]>;
  /**
   * How many mutations each coordinator has seen. A read that started before a
   * delete and resolved after it carries a stale generation and is discarded —
   * otherwise it would put the removed row back.
   */
  generation: ReadonlyMap<string, number>;
};

export const emptyFollowing = (): FollowingState => ({ byCoordinator: new Map(), generation: new Map() });

export const generationOf = (state: FollowingState, key: string): number => state.generation.get(key) ?? 0;

/** One coordinator's read result. `undefined` means the request failed. */
export type FollowingRead = { key: string; subscriptions?: readonly Subscription[]; startedAt: number };

/**
 * Fold reads in.
 *
 * A failed read PRESERVES the last good answer — an empty group claims nothing
 * is followed, and a failure is not evidence of that. A read older than the
 * coordinator's current generation is dropped, so a delete cannot be undone by
 * a request that was already in flight. Coordinators absent from `reads` are
 * dropped: they are no longer pinned.
 */
export function applyReads(
  state: FollowingState,
  reads: readonly FollowingRead[],
  /**
   * A FULL read represents the whole pinned set, so coordinators absent from it
   * are no longer pinned and are dropped. A SCOPED read speaks for the
   * coordinators it names and no others — merging is the only correct fold, or
   * refreshing one row would delete every other row's state.
   */
  mode: "full" | "scoped" = "full",
): FollowingState {
  const byCoordinator = mode === "scoped" ? new Map(state.byCoordinator) : new Map<string, readonly Subscription[]>();
  const generation = mode === "scoped" ? new Map(state.generation) : new Map<string, number>();
  for (const read of reads) {
    // MEMBERSHIP IS AUTHORITY for a scoped fold. A full read that dropped this
    // coordinator did so because it is no longer pinned; a scoped answer that
    // arrived afterwards must not put it back.
    if (mode === "scoped" && !state.byCoordinator.has(read.key)) continue;
    const stale = read.startedAt < generationOf(state, read.key);
    const kept = read.subscriptions !== undefined && !stale ? read.subscriptions : state.byCoordinator.get(read.key);
    if (kept) byCoordinator.set(read.key, kept);
    else if (mode === "full") byCoordinator.delete(read.key);
    generation.set(read.key, generationOf(state, read.key));
  }
  return { byCoordinator, generation };
}

/**
 * Apply an unfollow: drop ONLY what the engine removed, and bump the generation
 * so a read already in flight cannot resurrect it.
 */
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
 * A synchronous lock, so a second click cannot start a second request.
 *
 * A `useState` updater is NOT a lock: React does not promise to run it before
 * the next event, and StrictMode invokes it twice. This is a plain `Set` on a
 * ref — checked and claimed in the same tick as the click.
 *
 * Keyed by coordinator AND target, so unfollowing one row never blocks another.
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
 * Owns Following state, generations, locks and the read epoch — outside React,
 * because mutating refs inside a `setState` updater is impure (StrictMode
 * invokes updaters twice) and because `live` on an effect guards starting a
 * read, not its completion. A read carries the epoch it began in; an answer
 * from a superseded epoch is dropped.
 */export type FollowingFetch = (session: { id: string; hostId?: string }) => Promise<readonly Subscription[]>;
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
      // A superseded epoch's answer describes a pinned set that no longer
      // exists; applying it would reintroduce sessions the rail has dropped.
      if (started !== epoch) return false;
      publish(applyReads(state, reads));
      return true;
    },

    /**
     * Start following, then refresh just this coordinator.
     *
     * SCOPED: the refresh speaks for one coordinator, so it merges rather than
     * rebuilding the map, and it does NOT bump the shared epoch — a full read
     * in flight still describes the pinned set and must not be superseded by a
     * single row's follow-up.
     */
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
        /**
         * A NEW SUBSCRIPTION EXISTS, so every read that began before it is now
         * stale: bump this coordinator's generation, or a full read already in
         * flight would resolve with the pre-follow list and erase it.
         */
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
