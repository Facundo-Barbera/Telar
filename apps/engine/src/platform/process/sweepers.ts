/** A periodic pass (`every`) or a one-off after a delay (`once`); `null` skips it. */
export type Sweep = { name?: string; run: () => unknown } & ({ every: number } | { once: number | null });

type Observe = <T>(operation: string, section: () => T) => T;

/**
 * Starts every sweep unref'd, so none holds the process open. A throw or a rejected promise is swallowed:
 * a failed tick waits for the next, and never takes the engine down. One `stop()` clears them all.
 */
export function startSweepers(sweeps: readonly Sweep[], observe: Observe = (_, section) => section()): { stop(): void } {
  const tick = (sweep: Sweep) => () => {
    try {
      const result = observe(`sweep ${sweep.name ?? "unnamed"}`, sweep.run);
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      /* the next tick tries again */
    }
  };
  const intervals: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  for (const sweep of sweeps) {
    if ("every" in sweep) intervals.push(setInterval(tick(sweep), sweep.every));
    else if (sweep.once !== null) timeouts.push(setTimeout(tick(sweep), sweep.once));
  }
  for (const timer of [...intervals, ...timeouts]) timer.unref();
  return {
    stop() {
      for (const timer of intervals) clearInterval(timer);
      for (const timer of timeouts) clearTimeout(timer);
    },
  };
}
