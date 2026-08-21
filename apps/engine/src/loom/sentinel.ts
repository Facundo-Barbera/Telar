/**
 * THE SENTINEL — "did anything change?" for the cost of one command.
 *
 * IDLE MUST BE FREE. The supervisor must never invoke an agent to discover that
 * there is nothing to do: a project with a quiet backlog should cost one cheap
 * shell command per interval and nothing else, forever. That is the constraint
 * this file exists to satisfy, and it is why the probe's contract is one line
 * of stdout and no model in the loop.
 *
 * Running the command is the engine's job. Everything here is the diff logic:
 * hash it, compare it, decide when to look again.
 *
 * ── WHY A HAND-ROLLED HASH ───────────────────────────────────────────────────
 * FNV-1a, eight lines, no import. This is not a cryptographic decision — the
 * input is a string this machine just produced and nobody is attacking it — it
 * is a STABILITY decision: the fingerprint is persisted to `sentinel.json` and
 * compared against one written by a previous process, possibly a previous
 * version of the daemon. A digest whose output depends only on the bytes in
 * front of it, with no library version, no platform variation and no algorithm
 * negotiation, cannot drift between those two writes. The failure mode of
 * drift is silent and expensive: every probe looks like a change, every
 * interval wakes an agent, and the "idle is free" property is gone with nothing
 * in the logs to say so.
 */
import type { Fingerprint, LoomProgram } from "@telar/engine-client";

/**
 * FNV-1a, 32-bit, hex. Deterministic across processes and versions by
 * construction — see the header for why that matters more than the algorithm.
 */
export function digest(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // The 32-bit FNV prime, as shifts, so this stays in integer range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The probe's stdout, as a fingerprint.
 *
 * TRIMMED BEFORE HASHING. A trailing newline is an artifact of how the command
 * was invoked, not a change in the world, and a shell that adds one on Tuesday
 * would otherwise wake an agent for nothing. The trimmed line is kept beside
 * the hash because a hash alone is undebuggable: when the answer looks wrong at
 * 2am, the question is always "what did it actually compare", and the contract
 * says that is one line.
 */
export function fingerprintFrom(stdout: string, at: number): Fingerprint {
  const probe = stdout.trim();
  return { hash: digest(probe), at, probe };
}

/**
 * NO PREVIOUS FINGERPRINT IS A CHANGE. The first probe after a restart, or on a
 * project nobody has watched before, has nothing to compare against — and
 * "nothing to compare against" must not read as "nothing happened". Erring
 * toward one extra tick on first sight is cheap; erring the other way means a
 * newly-watched project sits idle until something else happens to move.
 */
export function hasChanged(prev: Fingerprint | null | undefined, next: Fingerprint): boolean {
  if (!prev) return true;
  return prev.hash !== next.hash;
}

/**
 * How long to wait before the next probe.
 *
 * Doubles on every quiet check up to `backoffMaxSec`, resets to `intervalSec`
 * the moment anything changes. A repo nobody touched over a weekend costs a
 * handful of probes instead of five hundred; the first commit on Monday puts it
 * straight back to full attention.
 *
 * A `current` below the floor (a fresh watch, a hand-edited file, a Program
 * whose interval was just raised) is clamped up rather than doubled from
 * garbage, so the schedule always converges on what the Program actually says.
 */
export function nextInterval(current: number, changed: boolean, program: LoomProgram): number {
  const { intervalSec, backoffMaxSec } = program.watch;
  if (changed) return intervalSec;
  const floor = Number.isFinite(current) && current >= intervalSec ? current : intervalSec;
  return Math.min(floor * 2, Math.max(intervalSec, backoffMaxSec));
}
