/**
 * WORK IN FLIGHT — the body agent work in the Spool did not have.
 *
 * A consultation runs fifteen to twenty-two turns and costs real money. Until
 * this file, the only thing representing one was a `busy` boolean inside a React
 * component: it could not survive a navigation, could not be seen from a second
 * surface, could not be cancelled, and could not actually prevent a second pass,
 * because a reload cleared it. The expert route's own header says as much —
 * "the surface's busy state is what prevents the second".
 *
 * ── IN MEMORY, ON PURPOSE ────────────────────────────────────────────────────
 * A pass in flight is not the user's data. If the daemon dies, the pass died
 * with it, and a file on disk claiming otherwise would be a lie the next
 * morning. What a pass PRODUCED is already durable, on the item's own ripening
 * timeline, which is where a human looks and which no code here touches.
 *
 * So this holds the present moment plus a short tail of what just settled. No
 * second archive, nothing accumulating unbounded — the same posture the store
 * keeps, applied to the one thing the store deliberately does not record.
 *
 * ── ONE PASS PER ITEM, AND THIS IS WHERE THAT IS TRUE ────────────────────────
 * `beginWork` refuses to open a second running entry for an item that already
 * has one, and hands back the existing entry instead. That moves the guarantee
 * from a component's state — where a reload defeated it — into the process that
 * would spend the money. Two clicks are now one pass, from anywhere.
 *
 * ── THE NIGHT IS NOT A SPECIAL CASE ──────────────────────────────────────────
 * A night's jobs register here exactly as a hand-triggered pass does, marked
 * `origin: "night"`. One record, one surface, one shape — so the morning can
 * show what ran while you slept beside what is running while you watch, without
 * either being a translation of the other.
 */
import type { SpoolWork, SpoolWorkKind, SpoolWorkOrigin, SpoolWorkState } from "@telar/engine-client";
import type { AgentUsage } from "../agent";

/**
 * How many settled entries survive behind the live ones.
 *
 * Small on purpose. This is a window on "what just happened", not a history —
 * the history is the ripening timeline, per item, where it belongs. A number
 * large enough to be browsed would make this the second archive the store's
 * whole design refuses.
 */
const SETTLED_KEPT = 20;

/**
 * `refused` OR `failed`, and getting this wrong is a lie on the morning report.
 *
 * The night's protocol calls the distinction "the honest half": a refusal is the
 * system WORKING and naming the one thing only a human can do; a failure is the
 * system not working. Collapsing them either hides work you must do or cries
 * wolf about a night that went fine.
 *
 * A CANCELLATION IS A REFUSAL, and this is the case a live run caught. Stopping
 * a pass yourself came back `failed` — a red triangle on the report for a thing
 * you chose. It also mattered upstream: the night halts after three consecutive
 * FAILURES, so three deliberate stops would have ended it with "3 items failed
 * in a row", which is not what happened. `refused` resets that streak.
 *
 * A HEURISTIC OVER PROSE, stated as one, exactly like `isRateLimit`: the runner
 * flattens its typed failure into a sentence before this sees it.
 */
export function classifySettle(reason: string): "refused" | "failed" {
  return /cancelled|floating|belongs to no project|not a project name/i.test(reason) ? "refused" : "failed";
}

export type WorkHandle = {
  readonly id: string;
  /** Report a step. Cheap and total: a settled or evicted entry ignores it
   *  rather than throwing, because the caller is a model loop that must not
   *  care whether anyone is still watching. */
  step(step: { n: number; label: string }): void;
  /** Close the entry. Idempotent — the first call wins, so a caller that
   *  settles in both a success path and a `finally` cannot overwrite the real
   *  outcome with a generic one. */
  settle(outcome: { state: Exclude<SpoolWorkState, "running">; note: string; usage?: AgentUsage }): void;
};

export type WorkRegistry = {
  begin(input: {
    kind: SpoolWorkKind;
    /** Exactly one of these. An item pass names the item; a `threads` pass names
     *  the subject, because it is about all of them at once. */
    itemId?: string;
    subject?: string;
    itemTitle: string;
    project?: string;
    origin: SpoolWorkOrigin;
    started: string;
    abort?: AbortController;
  }): { handle: WorkHandle; already: SpoolWork | null };
  list(): SpoolWork[];
  find(id: string): SpoolWork | undefined;
  runningFor(itemId: string): SpoolWork | undefined;
  /** The subject-scoped half of `runningFor`. Separate rather than one method
   *  taking either, so a caller cannot pass an item id and silently match a
   *  subject that happens to share the string. */
  runningForSubject(subject: string): SpoolWork | undefined;
  cancel(id: string): boolean;
};

/**
 * WHAT THE DEDUPE ACTUALLY KEYS ON.
 *
 * PREFIXED, so a subject named exactly like an item id cannot collide with it.
 * Both halves are free-form strings the user controls, and "these two can never
 * be equal" is not a property either one has.
 */
function addressOf(work: { itemId?: string; subject?: string }): string | undefined {
  if (work.itemId) return `item:${work.itemId}`;
  if (work.subject) return `subject:${work.subject}`;
  return undefined;
}

type Entry = { work: SpoolWork; abort?: AbortController };

/**
 * A registry, made rather than imported as a singleton, so a test can hold its
 * own and the daemon's state object can own one the way it owns everything else.
 */
export function createWorkRegistry(): WorkRegistry {
  /** Insertion-ordered, which is also newest-last — the order a surface reads
   *  them in, so nothing has to sort by a clock nobody is allowed to render. */
  const entries = new Map<string, Entry>();

  /**
   * Drop the oldest SETTLED entries past the cap. Running ones are never
   * evicted, at any count: an entry that vanished while its call was still
   * spending money is exactly the invisibility this file exists to end.
   */
  const trim = (): void => {
    const settled = [...entries.values()].filter((entry) => entry.work.state !== "running");
    for (const entry of settled.slice(0, Math.max(0, settled.length - SETTLED_KEPT))) {
      entries.delete(entry.work.id);
    }
  };

  return {
    begin(input) {
      /**
       * THE DEDUPE, AND IT IS THE POINT OF THE FILE. An item already being read
       * hands back the running entry, so the caller can report "this is already
       * happening" instead of paying to find out.
       */
      const address = addressOf(input);
      const already = address
        ? [...entries.values()].find(
            (entry) => entry.work.state === "running" && addressOf(entry.work) === address,
          )
        : undefined;
      if (already) {
        return { handle: handleFor(already.work.id), already: already.work };
      }

      const id = `work-${crypto.randomUUID().slice(0, 12)}`;
      entries.set(id, {
        work: {
          id,
          kind: input.kind,
          ...(input.itemId ? { itemId: input.itemId } : {}),
          ...(input.subject ? { subject: input.subject } : {}),
          itemTitle: input.itemTitle,
          ...(input.project ? { project: input.project } : {}),
          origin: input.origin,
          started: input.started,
          state: "running",
        },
        ...(input.abort ? { abort: input.abort } : {}),
      });
      trim();
      return { handle: handleFor(id), already: null };
    },

    // COPIES, NOT THE RECORDS. A caller that mutated what it was handed would
    // edit the registry through the back door, which is how a "done" entry ends
    // up running again in someone else's surface.
    list: () => [...entries.values()].map((entry) => ({ ...entry.work })),
    find: (id) => {
      const entry = entries.get(id);
      return entry ? { ...entry.work } : undefined;
    },
    runningFor: (itemId) => {
      const entry = [...entries.values()].find((e) => e.work.state === "running" && e.work.itemId === itemId);
      return entry ? { ...entry.work } : undefined;
    },
    runningForSubject: (subject) => {
      const entry = [...entries.values()].find((e) => e.work.state === "running" && e.work.subject === subject);
      return entry ? { ...entry.work } : undefined;
    },

    /**
     * ABORT AND LEAVE THE ENTRY RUNNING. The pass itself settles it when the
     * SDK unwinds, with `structuredAgent`'s own "the call was cancelled;
     * nothing was written" — settling here would race that and could report a
     * cancellation for a call that had already emitted.
     */
    cancel(id) {
      const entry = entries.get(id);
      if (!entry?.abort || entry.work.state !== "running") return false;
      entry.abort.abort();
      return true;
    },
  };

  function handleFor(id: string): WorkHandle {
    return {
      id,
      step(step) {
        const entry = entries.get(id);
        if (!entry || entry.work.state !== "running") return;
        entry.work = { ...entry.work, step };
      },
      settle(outcome) {
        const entry = entries.get(id);
        // The idempotence: only a running entry settles, so a `finally` after a
        // real outcome is a no-op rather than an overwrite.
        if (!entry || entry.work.state !== "running") return;
        entry.work = {
          ...entry.work,
          state: outcome.state,
          note: outcome.note,
          ...(outcome.usage ? { usage: outcome.usage } : {}),
          // The step is dropped on settle: "Read reconciliation.ts" beside a
          // finished result describes a moment that is over, and reads as though
          // the pass were still there.
          step: undefined,
        };
        trim();
      },
    };
  }
}
