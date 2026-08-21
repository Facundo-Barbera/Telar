/**
 * THE LOOM STATE MACHINE — a table, not a pile of `if`s.
 *
 * ```
 * queued → working → gating → publishing → published
 *                       ↓          ↓
 *                    stuck ──── (ladder) ──→ parked | asking
 * ```
 *
 * ── WHY A TABLE, AND WHY IT THROWS ───────────────────────────────────────────
 * Four surfaces move looms: the supervisor, the gate runner, the publish
 * runner, and the human. They run in different files, at different times, and
 * two of them can be looking at the same loom across a process restart. A state
 * machine spread across their call sites is a machine nobody can read and
 * everybody can violate — the illegal move that costs you is never the one you
 * were thinking about when you wrote the branch. So the legal edges are DATA,
 * in one object, and `transitionLoom` throws a sentence naming both states when
 * something attempts an edge that is not there. Loudly wrong beats quietly
 * wrong: a loom that slid from `published` back to `working` would re-run work
 * that already opened a PR.
 *
 * ── TERMINAL MEANS TERMINAL ──────────────────────────────────────────────────
 * `published`, `parked` and `cancelled` have NO outgoing edges. Not "usually
 * none" — none. Re-opening one is a new loom, which is honest: it gets its own
 * id, its own worktree, its own attempts, and the old one's history stays
 * readable instead of being overwritten by a second life.
 *
 * ── THE EDGES THAT LOOK SURPRISING, AND ARE NOT ──────────────────────────────
 *   `stuck → working`   how a ladder rung is ENACTED. The engine does not
 *                       interpret rung text; it re-dispatches a worker into the
 *                       same worktree with the rung's label in its prompt.
 *   `stuck → gating`    rung 2 is "run the gate again, it may be flaky", and
 *                       that must not require a whole new session.
 *   `queued → stuck`    dispatch itself can fail — no worktree, or the Program's
 *                       `setup` command exits non-zero — before a session
 *                       exists to fail later.
 *   `gating → parked`   the `neverTouch` check runs on the diff at gate time. A
 *                       loom that touched `.env*` parks; it does not publish
 *                       and it does not get another rung.
 *   `asking → queued`   a human answers hours later, after the worktree was
 *                       reaped. Re-dispatching from scratch is correct; pretending
 *                       the old tree is still there is not.
 */
import { LoomState, type Loom } from "@telar/engine-client";

/** No outgoing edges. See the header. */
export const TERMINAL_LOOM_STATES: ReadonlySet<LoomState> = new Set<LoomState>([
  "published",
  "parked",
  "cancelled",
]);

const stateOf = (l: Loom | LoomState): LoomState => (typeof l === "string" ? l : l.state);

export function isTerminal(l: Loom | LoomState): boolean {
  return TERMINAL_LOOM_STATES.has(stateOf(l));
}

/** Everything that is not terminal. This is what counts against `concurrency`
 *  and what makes an item ineligible for a second dispatch. */
export function isActive(l: Loom | LoomState): boolean {
  return !isTerminal(l);
}

/**
 * The legal edges, exhaustively. Every non-terminal state may be cancelled by
 * the human — that one is not special-cased, it is written into each row, so
 * reading a row tells you everything that state can do.
 */
const TRANSITIONS: Readonly<Record<LoomState, readonly LoomState[]>> = {
  queued: ["working", "stuck", "cancelled"],
  working: ["gating", "stuck", "cancelled"],
  gating: ["publishing", "stuck", "parked", "cancelled"],
  publishing: ["published", "stuck", "cancelled"],
  stuck: ["working", "gating", "asking", "parked", "cancelled"],
  asking: ["queued", "working", "parked", "cancelled"],
  published: [],
  parked: [],
  cancelled: [],
};

/**
 * Is this edge in the table? `canTransition(x, x)` is FALSE on purpose: a
 * re-entry is not a transition, and letting one through would make "advance
 * this loom" a no-op that looks like progress in the ledger.
 */
export function canTransition(from: LoomState, to: LoomState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Everything a transition is allowed to change alongside the state. `id` and
 *  `state` are excluded because the first is identity and the second is the
 *  argument. */
export type LoomPatch = Partial<Omit<Loom, "id" | "state">>;

/**
 * Move a loom, or throw.
 *
 * Pure: the argument is never mutated, and the returned loom is a new object.
 * `updatedAt` is bumped to now unless the patch supplies one — callers that
 * need a deterministic clock (tests, replay) pass it explicitly rather than
 * this module reaching for an injected clock it would only ever use here.
 */
export function transitionLoom(loom: Loom, to: LoomState, patch: LoomPatch = {}): Loom {
  if (!canTransition(loom.state, to)) {
    const legal = TRANSITIONS[loom.state] ?? [];
    throw new Error(
      legal.length === 0
        ? `loom ${loom.id} is ${loom.state}, which is terminal — it cannot become ${to}. Start a new loom instead.`
        : `loom ${loom.id} cannot go from ${loom.state} to ${to}. Legal from ${loom.state}: ${legal.join(", ")}.`,
    );
  }
  return { ...loom, ...patch, state: to, updatedAt: patch.updatedAt ?? Date.now() };
}
