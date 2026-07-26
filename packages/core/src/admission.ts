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

const isAdmissionClass = (cls: unknown): cls is AdmissionClass =>
  typeof cls === "string" && (ADMISSION_CLASSES as readonly string[]).includes(cls);

// Belt-and-suspenders for callers that bypass the type system (`as any`, a JS
// caller, a class off the wire) — the same guard event-bus.ts's declareEvents
// puts on deliveryClass, and here for a sharper reason: `occupancy` is a fixed
// map keyed by class and sumMap only reduces over ADMISSION_CLASSES, so an
// out-of-enum key is INVISIBLE to availableFor. Unguarded, twenty-five acquires
// under "bogus" are all admitted at once while the snapshot still reports three
// in flight — the ceiling AD-17 exists to enforce, gone, silently.
function assertAdmissionClass(cls: AdmissionClass, fn: string): void {
  if (!isAdmissionClass(cls)) {
    throw new Error(
      `${fn}: ${JSON.stringify(cls)} is not an admission class — expected one of ` +
        `${ADMISSION_CLASSES.join(", ")}. Occupancy is keyed by class, so an unknown key would be ` +
        `invisible to the ceiling and admit without limit (AD-17).`,
    );
  }
}

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

// AC4, unchanged: the policy is initialized AT IMPORT, from process.env, and the
// parse never throws — so admissionCeiling() answers from the first line of the
// first module that imports this one, with no init call anyone can forget.
//
// `envRoot` is the record the ceiling is re-read FROM (see currentPolicy). It
// starts as the live process environment and is re-rooted only by
// resetAdmission(env), which is what lets a suite pin its own record and be
// immune to the shell it runs under.
let envRoot: Record<string, string | undefined> = process.env;
let policy: AdmissionPolicy = defaultAdmissionPolicy();
// Set by an explicit configureAdmission({ceiling}) — a deliberate call from code
// outranks an ambient environment variable.
let ceilingPinned = false;
let occupancy: ClassMap = zeroMap();
const queue: Waiter[] = [];

// The import-time value above is the FIRST answer, not a frozen one: the ceiling
// is re-read from the environment at every entry point, which is the convention
// every other env-derived root in this repo follows (story 1.1: "resolve
// TELAR_HOME lazily in store.ts so dev runs never write production state").
// Without it, a process that exports TELAR_MAX_AGENTS after @telar/core is first
// imported — an Electron main reading a settings file, a Next route reading
// config — keeps ceiling 4 forever and admissionCeiling() reports 4 with no
// warning, which is the one number this module exists to make visible and
// configurable. Eager init and lazy refresh are not in conflict: the import-time
// read is what makes the value present without an init call, and this is what
// keeps it TRUE afterwards.
function currentPolicy(): AdmissionPolicy {
  if (!ceilingPinned) {
    const fromEnv = readCeiling(envRoot);
    if (fromEnv !== policy.ceiling) policy = { ...policy, ceiling: fromEnv };
  }
  return policy;
}

export const admissionCeiling = (): number => currentPolicy().ceiling;

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
  const p = currentPolicy();
  const waiting = zeroMap();
  for (const w of queue) waiting[w.cls]++;
  return {
    policy: {
      ...p,
      weight: { ...p.weight },
      floor: { ...p.floor },
      priority: [...p.priority],
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
  // Resolved ONCE for the whole drain: nothing here awaits (a wake() only
  // resolves a promise, so continuations run later as microtasks), so the policy
  // cannot move underneath the loop, and the env read stays off the inner path.
  const p = currentPolicy();
  for (;;) {
    let admitted = false;

    for (const cls of p.priority) {
      const i = queue.findIndex((w) => w.cls === cls);
      if (i === -1) continue;
      if (!admissionCheck(p, occupancy, cls, { allowBorrow: false }).admit) continue;
      const [w] = queue.splice(i, 1);
      occupancy[cls]++; // taken BEFORE waking, so no arrival can barge the slot
      w!.wake();
      admitted = true;
      break;
    }
    if (admitted) continue;

    const head = queue[0];
    if (head && admissionCheck(p, occupancy, head.cls, { allowBorrow: true }).admit) {
      queue.shift();
      occupancy[head.cls]++; // same rule: the slot is taken before the wake
      head.wake();
      continue;
    }
    return;
  }
}

// The handle for one taken slot, minted AT the moment the slot is taken (T-9 —
// an identity names the thing, never a position or a recomputed count). It
// closes over the class actually charged, so a caller cannot release a class it
// never held: acquiring under "loom-build" and releasing under "other" would
// otherwise leak the build slot for the life of the process while decrementing
// a slot "other" never held, and Math.max(0, …) would swallow both halves.
// Idempotent, so calling it twice is a no-op rather than a decrement of somebody
// else's slot.
function slotHandle(cls: AdmissionClass): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseAdmission(cls);
  };
}

// Take a slot, waiting if necessary. RETURNS THE RELEASE HANDLE for the slot it
// took — call that in a `finally` and the pair can never disagree about which
// class is being handed back. releaseAdmission(cls) stays exported for callers
// that genuinely hold the class in a local, but the handle is the safe form.
export async function acquireAdmission(cls: AdmissionClass = "other"): Promise<() => void> {
  assertAdmissionClass(cls, "acquireAdmission");
  const p = currentPolicy();
  // No barging: once anyone is queued, new arrivals queue too. The old gate let
  // an arrival take the slot a just-woken waiter was about to claim, which is
  // how `active` could drift ABOVE the ceiling (AC6).
  if (queue.length === 0 && admissionCheck(p, occupancy, cls, { allowBorrow: true }).admit) {
    occupancy[cls]++;
    return slotHandle(cls);
  }
  await new Promise<void>((wake) => {
    queue.push({ cls, wake });
  });
  // Slot already accounted for by pump() before it woke us — nothing to do.
  return slotHandle(cls);
}

// Hand a slot back BY CLASS. Prefer the handle acquireAdmission returns; this
// form exists because AC9's floor-at-zero is asserted directly against it.
//
// WHAT IT CANNOT DETECT, stated so nobody assumes otherwise: it trusts the class
// it is given. Releasing "other" while the caller actually holds a "loom-build"
// slot leaves the build slot held for the life of the process and decrements a
// class that held nothing — and the floor below swallows the second half without
// a sound. Nothing here can tell the two apart: the only evidence of a mismatch
// is `occupancy[cls] === 0`, and AC9 requires that case to floor silently rather
// than throw, which is exactly what a double release looks like. That is why the
// handle exists and why engine.ts releases through it — the handle closes over
// the class actually charged, so the pair cannot disagree at all.
export function releaseAdmission(cls: AdmissionClass = "other"): void {
  assertAdmissionClass(cls, "releaseAdmission");
  // Floors at zero: a double release must not MINT capacity (AC9).
  occupancy[cls] = Math.max(0, occupancy[cls] - 1);
  pump();
}

// Test seam. Throws rather than silently stranding pending waiters, which would
// hang a suite in a way that is miserable to diagnose — bun runs every test file
// in ONE process, so this is not hypothetical.
export function configureAdmission(next: Partial<AdmissionPolicy>): void {
  if (queue.length > 0) throw new Error("configureAdmission: waiters still queued");
  // A ceiling below 1 admits NOBODY: the next acquire queues and never resolves,
  // and from that moment both recovery seams refuse to run because a waiter is
  // queued — a wedge with no route back short of a process restart, reached
  // THROUGH the guard written to prevent stranded waiters. `"ceiling" in next`
  // rather than `!== undefined` because the spread below would otherwise write
  // an explicit `undefined` straight into the policy.
  if ("ceiling" in next && (!Number.isInteger(next.ceiling) || (next.ceiling as number) < 1)) {
    throw new Error(
      `configureAdmission: ceiling must be an integer >= 1, got ${JSON.stringify(next.ceiling)}. ` +
        `At 0 nothing can ever be admitted, the next acquire queues forever, and both ` +
        `configureAdmission and resetAdmission then throw "waiters still queued". readCeiling ` +
        `applies the same bound to TELAR_MAX_AGENTS.`,
    );
  }
  if ("ceiling" in next) ceilingPinned = true;
  policy = { ...policy, ...next };
}

export function resetAdmission(env?: Record<string, string | undefined>): void {
  if (queue.length > 0) throw new Error("resetAdmission: waiters still queued");
  // Live occupancy is the other half of the same invariant, and the queue guard
  // does not cover it: with the pool full and nobody queued, zeroing occupancy
  // MINTS the whole ceiling — four fresh calls are admitted immediately, eight
  // real model calls run against a ceiling of four, and the original four
  // releases are then absorbed by Math.max(0, …) so occupancy under-reports
  // permanently, with no error and no log. Same rule as releaseAdmission two
  // functions up: a reset must not mint capacity (AC9). A test that trips this
  // is a test that leaked a slot — drain it rather than reaching for a force
  // flag.
  const held = sumMap(occupancy);
  if (held > 0) {
    const by = ADMISSION_CLASSES.filter((c) => occupancy[c] > 0)
      .map((c) => `${c}=${occupancy[c]}`)
      .join(", ");
    throw new Error(
      `resetAdmission: ${held} slot(s) still held (${by}) — resetting would mint capacity for ` +
        `calls that are still in flight. Release them first (the handle acquireAdmission returned, ` +
        `or releaseAdmission for each held class).`,
    );
  }
  envRoot = env ?? process.env;
  policy = defaultAdmissionPolicy(envRoot);
  ceilingPinned = false;
  occupancy = zeroMap();
}
