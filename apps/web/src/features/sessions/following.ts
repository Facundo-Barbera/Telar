import type { Subscription } from "@telar/engine-client";

export type FollowingState = {
  byCoordinator: ReadonlyMap<string, readonly Subscription[]>;
  generation: ReadonlyMap<string, number>;
};

export const emptyFollowing = (): FollowingState => ({ byCoordinator: new Map(), generation: new Map() });

export const generationOf = (state: FollowingState, key: string): number => state.generation.get(key) ?? 0;

export type FollowingRead = { key: string; subscriptions?: readonly Subscription[]; startedAt: number };

export function applyReads(
  state: FollowingState,
  reads: readonly FollowingRead[],
  mode: "full" | "scoped" = "full",
): FollowingState {
  const byCoordinator = mode === "scoped" ? new Map(state.byCoordinator) : new Map<string, readonly Subscription[]>();
  const generation = mode === "scoped" ? new Map(state.generation) : new Map<string, number>();
  for (const read of reads) {
    if (mode === "scoped" && !state.byCoordinator.has(read.key)) continue;
    const stale = read.startedAt < generationOf(state, read.key);
    const kept = read.subscriptions !== undefined && !stale ? read.subscriptions : state.byCoordinator.get(read.key);
    if (kept) byCoordinator.set(read.key, kept);
    else if (mode === "full") byCoordinator.delete(read.key);
    generation.set(read.key, generationOf(state, read.key));
  }
  return { byCoordinator, generation };
}

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

export function lockKey(hostId: string | undefined, coordinatorId: string, targetKey: string): string {
  return `${hostId ?? "local"}:${coordinatorId}:${targetKey}`;
}

export function claim(locks: Set<string>, key: string): boolean {
  if (locks.has(key)) return false;
  locks.add(key);
  return true;
}

export const release = (locks: Set<string>, key: string): void => void locks.delete(key);

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
      if (started !== epoch) return false;
      publish(applyReads(state, reads));
      return true;
    },

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
