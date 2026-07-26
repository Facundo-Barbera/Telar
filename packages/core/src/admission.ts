// Admission control for engine.agent(): ONE visible ceiling on concurrent
// model calls, divided into classes by weight, with a priority order (AD-17).
//
// WHAT IT REPLACES. engine.ts held a module-private `MAX_CONCURRENT = 4` with
// no exported hook, while a loom Charter promises `budget.maxAgents` (default
// 12) and Ultra stacks its own run-local cap of 3 on top. So the charter's
// number was unreachable and the real ceiling was invisible to everything that
// reasons about fan-out. Worse, that gate was a plain FIFO with no notion of
// *who* was asking, so a build fan-out could occupy every slot while
// verification queued behind it — the loom system's own diagnosed failure
// ("verification never reliably closed the loop") reproduced mechanically by
// the scheduler. It could also drift ABOVE its own ceiling: a woken waiter did
// `active++` without re-checking, so an arrival landing between release() and
// that resumption over-committed the pool by one.
//
// THE TRADE-OFF, stated plainly, because it is the decision most likely to be
// re-litigated: `loom-verify` gets PRECEDENCE, not a held-open slot. A hard
// reservation — keeping one slot empty whenever the verifier is idle — was
// specified first, BUILT, and then REJECTED ON EVIDENCE: it broke
// packages/core/test/ultra-runner.test.ts's `peak === 4` (a pure-Ultra workload
// can only reach 3 when a slot is held back), and on a 4-slot laptop it
// permanently burns 25% of capacity to insure against a wait that is already
// bounded. Do not re-derive it. The mechanism that buys the same protection for
// free: new arrivals never barge a non-empty queue, and a release admits
// entitled waiters in class-priority order before any borrower. So verification
// waits at most one in-flight call, never a whole fan-out, and no slot ever
// sits idle with work queued.
//
// SCOPE. This gates `agent()` LEAF CALLS only — the schema-forced,
// capability-walled model calls. It deliberately does NOT gate interactive chat
// sessions: those call the SDK's query() directly from the chat route and never
// enter engine.agent(), so a fleet can never make the cockpit wait, and there is
// no `interactive-session` class because a slot reserved for one would reserve
// nothing. Long-lived processes (labs, declared services, borrowed infra) take
// no slot either — they are governed by the run lease (runner/lease.ts) and the
// per-repo worktree mutex. Ultra's run-local cap of 3 (ultra/executor.ts's
// RUN_CONCURRENCY) stacks ON TOP of this and stays.
//
// AD-20: admission's accounting is shared runtime state belonging to no module.
// It is owned here and written only through these functions; nobody reaches in.
//
// The policy half is PURE (NFR-RF-6): entitlement / availableFor /
// admissionCheck take policy and occupancy as arguments — no I/O, no clock, no
// implicit module state — so the whole policy space is testable without a
// queue. Only the queue below holds mutable state. That is the project's design
// law (deterministic control flow in code) applied to the scheduler itself.

export type AdmissionClass = "loom-build" | "loom-verify" | "ultra" | "other";

export const ADMISSION_CLASSES: readonly AdmissionClass[] = [
  "loom-build",
  "loom-verify",
  "ultra",
  "other",
] as const;

export type ClassMap = Record<AdmissionClass, number>;

export type AdmissionPolicy = {
  // Total concurrent agent() calls allowed process-wide.
  ceiling: number;
  // Share of the ceiling, proportional to weight.
  weight: ClassMap;
  // Minimum entitlement, so a heavier class can never starve a lighter one
  // outright. At a small ceiling this dominates the weights, which is correct
  // on a 4-slot machine: one each, borrow the rest.
  floor: ClassMap;
  // Who gets a freed slot first among waiters that are within entitlement.
  // Verification leads — that is the whole point of the class system.
  priority: readonly AdmissionClass[];
};

// Preserves the historical engine.ts value, so adopting this controller is not
// itself a throughput change (NFR-RF-8). Raise it with TELAR_MAX_AGENTS when the
// fleet actually wants more concurrent spend.
export const DEFAULT_ADMISSION_CEILING = 4;

const zeroMap = (): ClassMap => ({ "loom-build": 0, "loom-verify": 0, ultra: 0, other: 0 });
const sumMap = (m: ClassMap): number => ADMISSION_CLASSES.reduce((n, c) => n + m[c], 0);

// Tolerant parse: a missing, blank, non-integer or sub-1 value falls back to the
// default rather than throwing at import time and taking the whole server down.
export function readCeiling(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TELAR_MAX_AGENTS;
  if (raw == null || raw.trim() === "") return DEFAULT_ADMISSION_CEILING;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_ADMISSION_CEILING;
  return n;
}

export function defaultAdmissionPolicy(
  env: Record<string, string | undefined> = process.env,
): AdmissionPolicy {
  return {
    ceiling: readCeiling(env),
    weight: { "loom-build": 3, "loom-verify": 2, ultra: 2, other: 1 },
    floor: { "loom-build": 1, "loom-verify": 1, ultra: 1, other: 0 },
    priority: ["loom-verify", "loom-build", "ultra", "other"],
  };
}

// --- pure policy -----------------------------------------------------------

// A class's steady-state allowance: its weighted slice of the ceiling, never
// below its floor. Entitlements may sum to less than the ceiling (the floor()
// leaves slack) or, at a small ceiling, to more; either way the borrow path and
// the availability check keep the real total honest.
export function entitlement(policy: AdmissionPolicy, cls: AdmissionClass): number {
  const totalWeight = sumMap(policy.weight);
  const share =
    totalWeight > 0 ? Math.floor((policy.ceiling * policy.weight[cls]) / totalWeight) : 0;
  return Math.max(policy.floor[cls], share);
}

// Free slots. Work-conserving by construction — nothing is held back for a
// class that has not asked (see THE TRADE-OFF above).
export function availableFor(policy: AdmissionPolicy, occupancy: ClassMap): number {
  return policy.ceiling - sumMap(occupancy);
}

export type AdmissionReason = "entitled" | "borrowed" | "at-ceiling" | "over-share";

// The whole decision, as a pure function of policy + occupancy. `allowBorrow` is
// the fairness lever: false means "take only what you are entitled to" (applied
// while others are queued), true means "idle capacity is yours".
export function admissionCheck(
  policy: AdmissionPolicy,
  occupancy: ClassMap,
  cls: AdmissionClass,
  opts: { allowBorrow: boolean },
): { admit: boolean; reason: AdmissionReason } {
  if (availableFor(policy, occupancy) <= 0) return { admit: false, reason: "at-ceiling" };
  if (occupancy[cls] < entitlement(policy, cls)) return { admit: true, reason: "entitled" };
  if (opts.allowBorrow) return { admit: true, reason: "borrowed" };
  return { admit: false, reason: "over-share" };
}

// --- the queue (the only mutable state) ------------------------------------

type Waiter = { cls: AdmissionClass; wake: () => void };

let policy: AdmissionPolicy = defaultAdmissionPolicy();
let occupancy: ClassMap = zeroMap();
const queue: Waiter[] = [];

export const admissionCeiling = (): number => policy.ceiling;

// The observability read (AC5's "names why"): policy — including the priority
// order — occupancy, waiting-by-class, in-flight and queued, so a reader can
// reconstruct the decision instead of guessing why a fan-out is parked. Deep-
// copied on the way out: a surface that mutates what it rendered must not be
// able to move the scheduler.
export function admissionSnapshot(): {
  policy: AdmissionPolicy;
  occupancy: ClassMap;
  waiting: ClassMap;
  inFlight: number;
  queued: number;
} {
  const waiting = zeroMap();
  for (const w of queue) waiting[w.cls]++;
  return {
    policy: {
      ...policy,
      weight: { ...policy.weight },
      floor: { ...policy.floor },
      priority: [...policy.priority],
    },
    occupancy: { ...occupancy },
    waiting,
    inFlight: sumMap(occupancy),
    queued: queue.length,
  };
}

// Wake whoever may now proceed.
// Pass 1: entitled waiters, in class-priority order (FIFO within a class) —
//         this is where loom-verify gets ahead of a build fan-out.
// Pass 2: if capacity remains and nobody was entitled, the FIFO-first waiter
//         borrows. Without pass 2, several classes each sitting exactly at
//         their entitlement would stall with free slots on the floor (AC7).
function pump(): void {
  for (;;) {
    let admitted = false;

    for (const cls of policy.priority) {
      const i = queue.findIndex((w) => w.cls === cls);
      if (i === -1) continue;
      if (!admissionCheck(policy, occupancy, cls, { allowBorrow: false }).admit) continue;
      const [w] = queue.splice(i, 1);
      occupancy[cls]++; // taken BEFORE waking, so no arrival can barge the slot
      w!.wake();
      admitted = true;
      break;
    }
    if (admitted) continue;

    const head = queue[0];
    if (head && admissionCheck(policy, occupancy, head.cls, { allowBorrow: true }).admit) {
      queue.shift();
      occupancy[head.cls]++; // same rule: the slot is taken before the wake
      head.wake();
      continue;
    }
    return;
  }
}

// Take a slot, waiting if necessary. Pair with releaseAdmission in a `finally`,
// and resolve the class ONCE into a local first so the two can never disagree.
export async function acquireAdmission(cls: AdmissionClass = "other"): Promise<void> {
  // No barging: once anyone is queued, new arrivals queue too. The old gate let
  // an arrival take the slot a just-woken waiter was about to claim, which is
  // how `active` could drift ABOVE the ceiling (AC6).
  if (queue.length === 0 && admissionCheck(policy, occupancy, cls, { allowBorrow: true }).admit) {
    occupancy[cls]++;
    return;
  }
  await new Promise<void>((wake) => {
    queue.push({ cls, wake });
  });
  // Slot already accounted for by pump() before it woke us — nothing to do.
}

export function releaseAdmission(cls: AdmissionClass = "other"): void {
  // Floors at zero: a double release must not MINT capacity (AC9).
  occupancy[cls] = Math.max(0, occupancy[cls] - 1);
  pump();
}

// Test seam. Throws rather than silently stranding pending waiters, which would
// hang a suite in a way that is miserable to diagnose — bun runs every test file
// in ONE process, so this is not hypothetical.
export function configureAdmission(next: Partial<AdmissionPolicy>): void {
  if (queue.length > 0) throw new Error("configureAdmission: waiters still queued");
  policy = { ...policy, ...next };
}

export function resetAdmission(env?: Record<string, string | undefined>): void {
  if (queue.length > 0) throw new Error("resetAdmission: waiters still queued");
  policy = defaultAdmissionPolicy(env);
  occupancy = zeroMap();
}
