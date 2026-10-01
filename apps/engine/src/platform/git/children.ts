const DEFAULT_GIT_CHILDREN_CAP = 16;

/** Every live git child the engine spawned, across all pools and the sync runner. */
export type GitChildren = {
  readonly cap: number;
  live(): number;
  tryAcquire(): boolean;
  release(): void;
  /** Called after every release so a pool can admit what it has queued; returns an unsubscribe. */
  onRelease(wake: () => void): () => void;
};

export function createGitChildren(cap = DEFAULT_GIT_CHILDREN_CAP, warn: (message: string) => void = console.warn): GitChildren {
  let live = 0;
  let saturated = false;
  const wakers = new Set<() => void>();
  return {
    cap,
    live: () => live,
    tryAcquire() {
      if (live < cap) {
        live++;
        return true;
      }
      if (!saturated) {
        saturated = true;
        warn(`[git] ${live} git processes are alive, the cap is ${cap}; new git calls wait until one exits`);
      }
      return false;
    },
    release() {
      if (live === 0) return;
      live--;
      if (live < cap) saturated = false;
      for (const wake of wakers) wake();
    },
    onRelease(wake) {
      wakers.add(wake);
      return () => wakers.delete(wake);
    },
  };
}

export const gitChildren: GitChildren = createGitChildren();
