/**
 * TICKS IN FLIGHT — the Loom's copy of `spool/work.ts`, and deliberately still
 * not durable.
 *
 * A tick costs real money and takes real seconds. Until something represents one
 * in the process that is spending it, the only thing that knows a tick is
 * running is the surface that started it: it cannot survive a navigation, cannot
 * be seen from a second window, and cannot be cancelled. `spool/work.ts` was
 * written to end exactly that, and the argument transfers without a word
 * changed.
 *
 * ── IN MEMORY, ON PURPOSE ───────────────────────────────────────────────────
 * A tick in flight is not the user's data. If the daemon dies, the tick died
 * with it, and a file on disk claiming a tick is still running would be a lie
 * the next morning — the worst kind, because the deck's whole job is to be
 * readable at 2am without a second opinion. What a tick PRODUCED is already
 * durable: the ledger, the triage cache, the loom records. Those are written by
 * the store as the tick goes, and nothing here touches them.
 *
 * So this holds the present moment plus a short tail of what just settled. No
 * second archive, nothing accumulating with uptime — which is the same property
 * §3.2 demands of a tick's context, applied to the registry that watches it.
 *
 * ── ONE TICK PER PROJECT, AND THIS IS WHERE THAT IS TRUE ────────────────────
 * `runningFor(projectId)` is what lets a caller refuse a second concurrent tick
 * for a project rather than pay to discover that the first one already
 * dispatched the item. The supervisor asks it before every wake; a human
 * hammering "tick now" gets one tick.
 */
import type { LoomRun, LoomRunKind } from "@telar/engine-client";

/**
 * How many settled runs survive behind the live ones.
 *
 * Small on purpose, and the same number the spool chose. This is a window on
 * "what just happened", not a history — the history is the ledger, which is
 * append-only, per project, and where a human actually looks. A number large
 * enough to browse would make this the second archive §9 refuses.
 */
const SETTLED_KEPT = 20;

export type LoomRunHandle = {
  readonly id: string;
  /**
   * Report a step. Cheap and total: a settled or evicted run ignores it rather
   * than throwing, because the caller is a lifecycle loop that must not care
   * whether anyone is still watching.
   */
  step(note: string): void;
  /**
   * Close the run. Idempotent — the first call wins, so a caller that settles
   * in both a success path and a `finally` cannot overwrite the real outcome
   * with a generic one.
   */
  settle(patch: Partial<LoomRun>): void;
  /** Aborts when the run is cancelled. Threaded into every `exec` the tick makes. */
  readonly signal: AbortSignal;
};

export type LoomRunRegistry = {
  begin(input: { projectId: string; kind: LoomRunKind }): LoomRunHandle;
  list(): LoomRun[];
  find(id: string): LoomRun | undefined;
  runningFor(projectId: string): LoomRun | undefined;
  cancel(id: string): boolean;
};

type Entry = { run: LoomRun; abort: AbortController };

/**
 * A registry, made rather than imported as a singleton, so a test can hold its
 * own and the daemon's state object can own one the way it owns everything else.
 */
export function createLoomRuns(now: () => Date = () => new Date()): LoomRunRegistry {
  /** Insertion-ordered, which is also newest-last — the order a surface reads
   *  them in, so nothing has to sort by a clock nobody is allowed to render. */
  const entries = new Map<string, Entry>();

  /**
   * Drop the oldest SETTLED runs past the cap. Running ones are never evicted,
   * at any count: a run that vanished while its agent call was still spending
   * money is exactly the invisibility this file exists to end.
   */
  const trim = (): void => {
    const settled = [...entries.values()].filter((entry) => entry.run.state !== "running");
    for (const entry of settled.slice(0, Math.max(0, settled.length - SETTLED_KEPT))) {
      entries.delete(entry.run.id);
    }
  };

  const handleFor = (id: string, signal: AbortSignal): LoomRunHandle => ({
    id,
    signal,
    step(note) {
      const entry = entries.get(id);
      if (!entry || entry.run.state !== "running") return;
      entry.run = { ...entry.run, step: note };
    },
    settle(patch) {
      const entry = entries.get(id);
      // The idempotence: only a running run settles, so a `finally` after a real
      // outcome is a no-op rather than an overwrite.
      if (!entry || entry.run.state !== "running") return;
      entry.run = {
        ...entry.run,
        ...patch,
        state: patch.state && patch.state !== "running" ? patch.state : "done",
        settledAt: patch.settledAt ?? now().getTime(),
        // The step is dropped on settle: "running gates" beside a finished
        // result describes a moment that is over, and reads as though the tick
        // were still there.
        step: undefined,
      };
      trim();
    },
  });

  return {
    begin(input) {
      const id = `loomrun-${crypto.randomUUID().slice(0, 12)}`;
      const abort = new AbortController();
      entries.set(id, {
        abort,
        run: {
          id,
          projectId: input.projectId,
          kind: input.kind,
          state: "running",
          startedAt: now().getTime(),
          dispatched: [],
        },
      });
      trim();
      return handleFor(id, abort.signal);
    },

    // COPIES, NOT THE RECORDS. A caller that mutated what it was handed would
    // edit the registry through the back door, which is how a "done" run ends
    // up running again in someone else's surface.
    list: () => [...entries.values()].map((entry) => ({ ...entry.run })),
    find: (id) => {
      const entry = entries.get(id);
      return entry ? { ...entry.run } : undefined;
    },
    runningFor: (projectId) => {
      const entry = [...entries.values()].find((e) => e.run.state === "running" && e.run.projectId === projectId);
      return entry ? { ...entry.run } : undefined;
    },

    /**
     * ABORT AND LEAVE THE RUN RUNNING. The tick itself settles when its own
     * unwinding reaches the `finally`, with the reason it actually observed —
     * settling here would race that and could report a cancellation for a tick
     * that had already dispatched.
     */
    cancel(id) {
      const entry = entries.get(id);
      if (!entry || entry.run.state !== "running") return false;
      entry.abort.abort();
      return true;
    },
  };
}
