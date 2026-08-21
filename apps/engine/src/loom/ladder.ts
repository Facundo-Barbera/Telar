/**
 * THE ESCALATION LADDER — the centrepiece, not a retry counter.
 *
 * The user is asleep. Escalations go to the ORCHESTRATOR first and only reach
 * the human when the ladder is exhausted, or when the Program's "ask me only
 * when" says this is one of the things worth waking up for. A system that pages
 * a human on the first red gate is a system that gets muted by week two.
 *
 * ── THE ENGINE DOES NOT INTERPRET RUNG TEXT ──────────────────────────────────
 * A rung's `label` is prose the human wrote — "narrow the scope and retry once"
 * — and it is handed to the orchestrator agent, which decides how to enact it.
 * Nothing here parses it, matches on it, or branches on it. What this file
 * enforces is the four mechanical rules that make the ladder trustworthy:
 *
 *   1. rungs are tried IN ORDER, cheapest first (that is what the numbering is);
 *   2. a rung is tried ONCE per loom;
 *   3. disabled rungs are skipped entirely — off means off, not "later";
 *   4. past the last enabled rung the loom goes to `asking`. There is no
 *      fourth try on a three-rung ladder.
 *
 * ── `absorbed` IS THE FEEDBACK LOOP ──────────────────────────────────────────
 * It counts the times a rung actually RESOLVED a stuck loom, and it is written
 * back into the Program — the file the human edits — rather than into a metrics
 * sink nobody opens. That is the number that answers "is my ladder any good":
 * a rung with 40 absorbed is carrying the night, a rung with 0 after a hundred
 * looms is a rung to switch off. Without it, the ladder is a guess that never
 * gets corrected.
 */
import type { Loom, LoomProgram, Rung } from "@telar/engine-client";

/** Enabled rungs, cheapest first. Authoring order does not matter; `n` does. */
function enabledRungs(program: LoomProgram): Rung[] {
  return program.ladder.filter((r) => r.enabled).sort((a, b) => a.n - b.n);
}

export type NextRung = { rung: Rung; loom: Loom } | { exhausted: true };

/**
 * The next rung to try for this loom, and the loom with that attempt recorded.
 *
 * `ladderRung` is the `n` of the last rung tried and 0 before the first, which
 * is why rungs are numbered from 1 — it makes "nothing tried yet" and "rung 0"
 * the same value, and the Program parser drops a rung numbered 0 for exactly
 * this reason. Selection is `n > ladderRung`, so re-entering the ladder after a
 * restart resumes rather than repeating: the loom on disk already says how far
 * it got, and no separate attempt log has to agree with it.
 *
 * `attempts` cannot exceed the number of enabled rungs — the second guard below
 * makes that true even if `ladderRung` were somehow corrupted, because the cap
 * is the promise ("there is no fourth try") and it should not depend on one
 * field being intact.
 *
 * ── `attempts` COUNTS RUNGS CONSUMED, NOT SESSIONS STARTED, AND `nextRung` IS
 * ── ITS SOLE WRITER ─────────────────────────────────────────────────────────
 * A freshly dispatched loom is `attempts: 0, ladderRung: 0`; rung N sets
 * `attempts: N`. Dispatch must NOT bump it. This is not a stylistic preference,
 * it is the only reading under which both guards above agree, and the bug it
 * prevents is silent: if the initial dispatch ate an attempt, a two-rung ladder
 * would try rung 1, then hit `1 >= 2` on the second stuck and escalate — so the
 * LAST enabled rung of every ladder would never run, and §5's "each rung is
 * tried once" would be quietly false on every project. Found in review by the
 * runtime layer; pinned by the two-rung test in `loom-ladder.test.ts`.
 *
 * A surface rendering this field should label it "rungs tried", not "attempt N".
 *
 * Exhausted means the CALLER moves the loom to `asking`. Deliberately not done
 * here: this function is a pure question about the ladder, and a helper that
 * silently mutated lifecycle state would put a second state machine in a file
 * that has no business owning one.
 */
export function nextRung(loom: Loom, program: LoomProgram): NextRung {
  const rungs = enabledRungs(program);
  if (loom.attempts >= rungs.length) return { exhausted: true };
  const rung = rungs.find((r) => r.n > loom.ladderRung);
  if (!rung) return { exhausted: true };
  return {
    rung,
    loom: { ...loom, attempts: loom.attempts + 1, ladderRung: rung.n, updatedAt: Date.now() },
  };
}

/** How many rungs this loom still has. What "already tried 2 of 3" is read off. */
export function rungsRemaining(loom: Loom, program: LoomProgram): number {
  return Math.max(0, enabledRungs(program).filter((r) => r.n > loom.ladderRung).length);
}

/**
 * Credit rung `n` with resolving a stuck loom.
 *
 * Returns a new Program — the caller persists it, because writing `.telar/loom.md`
 * is not this file's business. An unknown `n` returns the Program UNCHANGED and
 * by identity: it means the human edited the ladder while a loom was mid-flight,
 * which is allowed and is not an error worth failing a tick over. The credit is
 * simply lost, which is the right trade against throwing inside the recovery
 * path of an already-stuck loom.
 */
export function absorbRung(program: LoomProgram, n: number): LoomProgram {
  if (!program.ladder.some((r) => r.n === n)) return program;
  return {
    ...program,
    ladder: program.ladder.map((r) => (r.n === n ? { ...r, absorbed: r.absorbed + 1 } : r)),
  };
}
