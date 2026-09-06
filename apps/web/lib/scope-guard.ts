/**
 * A monotonic scope stamp for guarding ASYNC RESULTS against a REUSED owner.
 *
 * The desktop browser surface (browser-live.tsx) is one React component
 * instance reused across sessions — Next reuses it when only the `sessionId`
 * prop changes. An action or a state read started under the OLD session can
 * resolve AFTER the switch; applying it would paint the old project's tabs
 * under the new one and then index against the new scope. This is the guard:
 *
 *   const guard = makeScopeGuard();
 *   // on scope change:            guard.bump();
 *   // at the start of an async op: const gen = guard.capture();
 *   // before applying its result: if (guard.isCurrent(gen)) apply(result);
 *
 * `bump` is NOT called on first use — the initial load must apply.
 */
export type ScopeGuard = {
  /** Advance the scope: every generation captured before now is stale. */
  bump(): void;
  /** The current generation, to capture at the start of an async op. */
  capture(): number;
  /** Whether a captured generation is still the current one. */
  isCurrent(captured: number): boolean;
};

export function makeScopeGuard(): ScopeGuard {
  let generation = 0;
  return {
    bump() {
      generation += 1;
    },
    capture() {
      return generation;
    },
    isCurrent(captured) {
      return captured === generation;
    },
  };
}
