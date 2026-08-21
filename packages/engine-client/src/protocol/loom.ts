/**
 * engine protocol v2 — the Loom orchestrator.
 *
 * The model is `docs/plans/loom-build.md`, which is the buildable half of
 * `docs/plans/orchestrator.md`. Read the first before changing anything here:
 * several of these shapes encode a decision that took an argument to reach, and
 * flattening one back to its "obvious" form silently undoes the argument.
 *
 * THE THREE THAT ARE NOT DATA MODELLING, THEY ARE THE DESIGN:
 *
 *   1. `GateOutcome` IS TRI-STATE, EVERYWHERE, AND NEVER A BOOLEAN. A project's
 *      CI can exit 2 for "nothing failed, but a gate skipped because Docker was
 *      down" — which is not a green light and is not a failure either. A
 *      boolean has to lie about that in one direction or the other, and both
 *      lies are expensive: `unknown → pass` opens red PRs, `unknown → fail`
 *      throws away work that was probably fine. So the third value is carried
 *      all the way to the UI chip, and `onUnknown` is a POLICY THE PROGRAM MUST
 *      ANSWER rather than something the engine infers.
 *
 *   2. THE FOUR COMMAND SLOTS ARE THE ANTI-ABSTRACTION. There is no work-source
 *      interface, no GitHub adapter, no provider registry — a project declares
 *      four shell commands and GitHub is a block of DEFAULT TEXT, never a
 *      branch in code. Anything shaped like `if (source === "github")` in a
 *      consumer of these types is the design being lost.
 *
 *      WHAT IS ABSTRACTED IS THE TRACKER, NOT THE VCS — and the boundary is
 *      worth stating, because "assume nothing" is not what this design says.
 *      GIT IS ASSUMED. `LoomWork.base`, `LoomWork.branchPrefix`, `Loom.branch`
 *      and `Loom.worktreePath` are that assumption made structural, and §8
 *      cuts a worktree and branches off base for every loom regardless of
 *      where the work came from. Even the tracker-less example in §1 publishes
 *      with `git push -u origin $BRANCH`. A TRACKER IS NOT ASSUMED: a project
 *      may have issues, an `inbox.md`, or a `list` command that prints
 *      whatever it likes, and nothing downstream may presume otherwise.
 *
 *      The practical test for a consumer, including UI copy — which is where
 *      the assumption reappears first, because it reads as harmless: "repo",
 *      "branch", "worktree" and "base" are fair; "issue", "milestone",
 *      "assignee" and "repository" (GitHub's own noun for the thing that holds
 *      issues) are not. `apps/web/components/loom/idiom.test.ts` enforces the
 *      second list on shared components.
 *
 *   3. TRIAGE IS A FIRST-CLASS OUTPUT, not a side effect of dispatch. In the
 *      motivating backlog 4 of 37 open issues were dispatchable and the other
 *      33 were blocked on a decision, on credentials, or on decomposition —
 *      with nothing in the repo distinguishing them. A tick that dispatches
 *      nothing and classifies six items correctly was a good tick, so the
 *      classification is a durable, cached artifact with a shape of its own.
 *
 * A NOTE ON THE OLD `Loom`. `packages/core/src/looms.ts` carries a v1 type of
 * the same name. It is not extended, not imported, and shares no field here on
 * purpose (loom-build.md §13): the two systems coexist and ripping v1 out is a
 * separate change with its own blast radius.
 */
import { z } from "zod";
import { Id, Timestamp } from "./common";

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * Never a boolean, nowhere. See the header, decision 1.
 *
 * `unknown` must never be rendered as a pass — it is "could not verify", which
 * is a different sentence from "verified, and it failed".
 */
export const GateOutcome = z.enum(["pass", "fail", "unknown"]);
export type GateOutcome = z.infer<typeof GateOutcome>;

/**
 * What to do with an `unknown` gate. `hold` is the default and the recommended
 * answer: the failure mode of holding is a PR you did not get, and the failure
 * mode of publishing is red CI and burnt Actions minutes, which is worse
 * because it is noisy and lands in someone else's morning.
 */
export const GateUnknownPolicy = z.enum(["hold", "publish"]);
export type GateUnknownPolicy = z.infer<typeof GateUnknownPolicy>;

/**
 * One gate: a shell command plus WHAT ITS EXIT CODES MEAN IN THIS PROJECT.
 *
 * The table is per project because only the project knows. An UNDECLARED exit
 * code maps to `unknown`, never to `fail` — assuming POSIX convention is
 * exactly the imposition this design exists to avoid, and it is wrong in both
 * directions (a project whose 0 means "skipped everything" is not hypothetical).
 * That rule lives in the classifier, not in this schema; the schema's job is
 * only to say that the table is sparse and that is legal.
 */
export const LoomGate = z.object({
  command: z.string().min(1),
  /**
   * Keys are exit codes. `z.coerce.number().int()` because a JSON object's keys
   * are strings on the wire and integers in the type — a plain `z.number()` key
   * would also accept `"1.5"`, which is not an exit code.
   */
  exits: z.record(z.coerce.number().int(), GateOutcome).default({}),
  onUnknown: GateUnknownPolicy.default("hold"),
});
export type LoomGate = z.infer<typeof LoomGate>;

/**
 * What running one gate produced. `exitCode` is nullable because a command can
 * fail to produce one at all (killed, timed out, never spawned) — and that case
 * is `unknown`, not `fail`, for the same reason as an undeclared code.
 */
export const LoomGateResult = z.object({
  command: z.string(),
  exitCode: z.number().int().nullable(),
  outcome: GateOutcome,
  at: Timestamp.optional(),
});
export type LoomGateResult = z.infer<typeof LoomGateResult>;

// ---------------------------------------------------------------------------
// The Program artifact
// ---------------------------------------------------------------------------

/**
 * The four command slots (loom-build.md §1). Every one is optional, and each
 * absence degrades one capability rather than breaking the system:
 *
 *   probe    Hard contract: prints ONE cheap, LLM-free line; that line IS the
 *            fingerprint. Absent → the sentinel is disabled and the supervisor
 *            falls back to pure heartbeat. Non-zero exit is "unknown, do not
 *            wake", never "changed".
 *   list     Free text. The candidate work items, however the project wants.
 *   detail   Free text, receives `$ITEM`. Everything needed to understand one.
 *   publish  Receives `$BRANCH $TITLE $BODY $BASE`. Exit 0 = published, and the
 *            first URL on stdout is recorded.
 *
 * Substitution is literal `$NAME` replacement into a string run through the
 * shell. This is an execution surface authored by the user, at the same trust
 * level as a `package.json` script — refusing shell would mean building the
 * abstraction this design exists to avoid.
 */
export const LoomCommands = z.object({
  probe: z.string().min(1).optional(),
  list: z.string().min(1).optional(),
  detail: z.string().min(1).optional(),
  publish: z.string().min(1).optional(),
});
export type LoomCommands = z.infer<typeof LoomCommands>;

/** Where work lands and how much of it runs at once. */
export const LoomWork = z.object({
  /** The branch PRs open against. Never pushed to, never force-pushed. */
  base: z.string().min(1).default("main"),
  /** Prefixed onto the slug: `<branchPrefix><slug>`. */
  branchPrefix: z.string().default("t3code/"),
  /** Hard ceiling on simultaneously in-flight looms. Enforced by machinery. */
  concurrency: z.number().int().nonnegative().default(4),
  /** Run once per fresh worktree, e.g. `bun install`. */
  setup: z.string().min(1).optional(),
});
export type LoomWork = z.infer<typeof LoomWork>;

/**
 * The sentinel's schedule, AS THE PROGRAM DECLARES IT — a policy, not a
 * reading. The live counterpart is `LoomWatch` below, which is what the
 * supervisor persists and the deck renders; keeping the two apart is why this
 * one is `…Policy`. `intervalSec` doubles after each quiet probe up to
 * `backoffMaxSec` and resets on any change, because IDLE MUST BE FREE: the
 * supervisor never invokes an agent to discover there is nothing to do.
 */
export const LoomWatchPolicy = z.object({
  intervalSec: z.number().int().positive().default(300),
  backoffMaxSec: z.number().int().positive().default(3600),
});
export type LoomWatchPolicy = z.infer<typeof LoomWatchPolicy>;

/**
 * One rung of the escalation ladder (loom-build.md §5).
 *
 * THE ENGINE DOES NOT INTERPRET `label`. Rungs are authored by the human in
 * prose and handed to the orchestrator agent, which decides how to enact one.
 * What the engine enforces is mechanical and small: in order, cheapest first,
 * each once per loom, disabled ones skipped, and past the last enabled rung the
 * loom goes to `asking` rather than trying anything else.
 *
 * `absorbed` counts the times this rung RESOLVED a stuck loom. It is the number
 * that tells the human whether their ladder is any good, which is why it lives
 * in the artifact they edit rather than in a metrics sink they never open.
 */
export const Rung = z.object({
  n: z.number().int().positive(),
  label: z.string(),
  enabled: z.boolean().default(true),
  absorbed: z.number().int().nonnegative().default(0),
});
export type Rung = z.infer<typeof Rung>;

/**
 * The Program: one markdown file per project at `.telar/loom.md`, parsed.
 *
 * HUMAN-FIRST, READ AT 2AM. The machine-readable parts are fenced blocks under
 * known headings and EVERYTHING ELSE IN THE FILE IS PROSE that lands in
 * `notes` and is passed verbatim to the agent. An unknown heading is never an
 * error: a Program with a typo degrades, it does not fail to parse. That is the
 * property that makes the file safe to hand-edit half asleep.
 */
export const LoomProgram = z.object({
  version: z.literal(1).default(1),
  /** Free text, from the `# Loom program — <project>` heading. Cosmetic. */
  project: z.string().default(""),
  commands: LoomCommands.default({}),
  gates: z.array(LoomGate).default([]),
  work: LoomWork.default({ base: "main", branchPrefix: "t3code/", concurrency: 4 }),
  /**
   * Globs the work may never touch, enforced by the harness AFTER the worker
   * exits: a diff touching one of these parks the loom instead of publishing
   * it. Enforced on the diff rather than asked of the agent, because the
   * failure mode of asking is silent and compounding.
   */
  neverTouch: z.array(z.string()).default([]),
  ladder: z.array(Rung).default([]),
  /** When to wake the human at all. Prose; read by the agent, not matched. */
  askWhen: z.array(z.string()).default([]),
  watch: LoomWatchPolicy.default({ intervalSec: 300, backoffMaxSec: 3600 }),
  /** What setup guessed and wants confirmed. Surfaces as a badge, not a block. */
  assumed: z.array(z.string()).default([]),
  /** Everything the parser did not claim, verbatim, including its headings. */
  notes: z.string().default(""),
});
export type LoomProgram = z.infer<typeof LoomProgram>;

// ---------------------------------------------------------------------------
// The Loom record
// ---------------------------------------------------------------------------

/**
 * ```
 * queued → working → gating → publishing → published
 *                       ↓          ↓
 *                    stuck ──── (ladder) ──→ parked | asking
 * ```
 *
 * TERMINAL IS AN OPEN PR, NOT A MERGE. `published` is as far as this system
 * goes: merging stays the human's call in the morning.
 *
 * `stuck` is not a failure state, it is the ladder's entry point — the loom is
 * alive and something cheap has not been tried yet. `asking` is where a loom
 * ends up when the ladder is exhausted, and `parked` when there is a written
 * reason not to continue. Both are visible; neither is silent.
 */
export const LoomState = z.enum([
  "queued",
  "working",
  "gating",
  "publishing",
  "published",
  "stuck",
  "parked",
  "asking",
  "cancelled",
]);
export type LoomState = z.infer<typeof LoomState>;

/**
 * One dispatched unit of work: a worktree, a session, one item, one PR.
 *
 * IN-FLIGHT STATE IS RE-DERIVED, NEVER REMEMBERED. The orchestrator dies every
 * tick, so a killed worker has to be distinguishable from a running one from
 * disk alone — which is what `sessionId` and `pid` are for. There is
 * deliberately NO heartbeat field: the session store already knows whether a
 * session is alive, and a second source of truth only invites the two to
 * disagree.
 */
export const Loom = z.object({
  id: Id,
  projectId: Id,
  /** The work item's ref, as the project's own `list` command names it. */
  item: z.string().min(1),
  title: z.string(),
  state: LoomState,

  /** The Telar session doing the work, and its OS pid. Both absent until
   *  dispatch, and both are LIVENESS EVIDENCE rather than identity. */
  sessionId: Id.optional(),
  pid: z.number().int().positive().optional(),

  worktreePath: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),

  /**
   * How many ladder rungs have been spent, and which one was last tried.
   * `attempts` is CAPPED at the number of enabled rungs — there is no "fourth
   * try" past a three-rung ladder. `ladderRung` is 0 before the first rung.
   *
   * BOTH COUNT RUNGS CONSUMED, NOT SESSIONS STARTED, and `nextRung` is their
   * sole writer: a freshly provisioned loom is `0, 0`, and rung N sets
   * `attempts: N`. Anything that bumps `attempts` at dispatch makes the LAST
   * enabled rung of every ladder unreachable, silently — a two-rung ladder
   * would try rung 1, then hit the cap and escalate.
   *
   * `.default(0)` IS TOLERANCE FOR AN OLD RECORD, NOT A LICENCE TO OMIT. It
   * exists so a loom written before these fields did not fail to load. The
   * hazard it carries is that a reader or writer which DROPPED the field would
   * be silently forgiven and would refund the loom a rung — invisible, and it
   * would look exactly like the ladder working. That is guarded at the
   * persistence boundary (`loom-store.test.ts`, "never invents or resets
   * `attempts`") rather than by making the field required here, because a hard
   * requirement would break the tolerant read this default is for.
   */
  attempts: z.number().int().nonnegative().default(0),
  ladderRung: z.number().int().nonnegative().default(0),

  /** The last gate result, for the tri-state chip. Absent = never gated, which
   *  is NOT the same as `unknown` and must not render as one. */
  gate: LoomGateResult.optional(),

  /** Written when the loom parks. A park with no reason is a bug. */
  parkedReason: z.string().optional(),
  /** What the loom is asking the human, set on the way into `asking`. */
  question: z.string().optional(),
  /** First URL the `publish` command printed. */
  publishedUrl: z.string().optional(),

  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** When the session actually started — absent while `queued`. */
  dispatchedAt: Timestamp.optional(),
});
export type Loom = z.infer<typeof Loom>;

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** What kind of thing happened. Deliberately coarse: the ledger is a narrative
 *  a human reads at 40 lines a tick, not a metrics stream. */
export const LedgerKind = z.enum([
  "tick",
  "dispatch",
  "gate",
  "publish",
  "park",
  "escalate",
  "triage",
  "ask",
  "cancel",
  "error",
]);
export type LedgerKind = z.infer<typeof LedgerKind>;

/**
 * One line of `ledger.jsonl`. ONE JSON OBJECT PER LINE, appended with
 * `O_APPEND`, so a torn write costs one line and not the file — which is also
 * why the reader skips a malformed line rather than throwing.
 */
export const LedgerEntry = z.object({
  at: Timestamp,
  kind: LedgerKind,
  loomId: Id.optional(),
  item: z.string().optional(),
  /** One line, human-first. This is what the deck renders. */
  summary: z.string(),
  /** Anything longer, kept out of the summary so the narrative stays scannable. */
  detail: z.string().optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

/**
 * Why an item is or is not dispatchable. The middle three are the finding this
 * whole surface exists for: they are the reasons a well-written backlog is
 * still not actionable, and nothing in a typical repo distinguishes them.
 */
export const Classification = z.enum([
  "dispatchable",
  "needs-decision",
  "needs-credentials",
  "needs-split",
  "never",
  "done",
]);
export type Classification = z.infer<typeof Classification>;

/**
 * One cached classification.
 *
 * TWO TIMESTAMPS, AND THEY ARE NOT REDUNDANT. `updatedAt` is the OPAQUE
 * revision token the project's own `list` command reported for this item — a
 * string, never parsed, only compared for equality, because it may be an ISO
 * date from `gh`, a mtime, or a hash from `cat inbox.md`. `at` is when WE last
 * classified it. The pair is what makes reading a whole comment thread
 * affordable: it happens once per item per change, not once per tick.
 *
 * `ask` is the distilled CURRENT intent, and it is the expensive half. The
 * newest comment routinely retracts the body — "ya no hace falta, mejor X" —
 * so the body alone is not the request, and re-deriving that distillation every
 * five minutes is exactly the cost this cache exists to avoid.
 */
export const TriageEntry = z.object({
  item: z.string().min(1),
  updatedAt: z.string(),
  classification: Classification,
  reason: z.string(),
  ask: z.string(),
  at: Timestamp,
});
export type TriageEntry = z.infer<typeof TriageEntry>;

// ---------------------------------------------------------------------------
// Sentinel
// ---------------------------------------------------------------------------

/**
 * The answer to "did anything change?" for the cost of one command.
 *
 * `probe` is the probe's own stdout line, kept beside the hash so a human can
 * see WHAT was compared when the answer looks wrong — a hash alone is
 * undebuggable at 2am, and the line is one line by contract.
 */
export const Fingerprint = z.object({
  hash: z.string().min(1),
  at: Timestamp,
  probe: z.string(),
});
export type Fingerprint = z.infer<typeof Fingerprint>;

// ---------------------------------------------------------------------------
// The tick's output
// ---------------------------------------------------------------------------

/** The durable output of a tick, cached per item. */
export const TickTriage = z.object({
  item: z.string().min(1),
  classification: Classification,
  reason: z.string(),
  ask: z.string().default(""),
});
export type TickTriage = z.infer<typeof TickTriage>;

/** A proposal, not an instruction: machinery re-checks concurrency and
 *  duplicate items before any of these becomes a worktree. */
export const TickDispatch = z.object({
  item: z.string().min(1),
  title: z.string(),
  /** Normalized by machinery — see `slugify`. A model-authored slug is a
   *  suggestion, and branch names are not the place to trust one. */
  branchSlug: z.string().default(""),
  brief: z.string().default(""),
});
export type TickDispatch = z.infer<typeof TickDispatch>;

export const TickPark = z.object({
  loomId: Id,
  reason: z.string(),
});
export type TickPark = z.infer<typeof TickPark>;

/**
 * Waking the human. `loomId` and `item` are both optional because the three
 * real cases differ: a stuck loom past its ladder has a loom, an item that
 * needs a product decision before anyone touches it has only an item, and a
 * question about the Program itself has neither.
 */
export const TickAsk = z.object({
  loomId: Id.optional(),
  item: z.string().min(1).optional(),
  question: z.string(),
  why: z.string().default(""),
});
export type TickAsk = z.infer<typeof TickAsk>;

/**
 * Everything one tick decided, as a single structured object.
 *
 * EVERY ARRAY DEFAULTS TO EMPTY. A tick that only classifies emits `triage`
 * and nothing else, and that is a good tick — the shape must not push a model
 * toward inventing a dispatch to fill a required field.
 */
export const TickDecision = z.object({
  triage: z.array(TickTriage).default([]),
  dispatch: z.array(TickDispatch).default([]),
  park: z.array(TickPark).default([]),
  ask: z.array(TickAsk).default([]),
  /** One line for the ledger, in the orchestrator's own words. */
  note: z.string().default(""),
});
export type TickDecision = z.infer<typeof TickDecision>;

// ---------------------------------------------------------------------------
// The seam (loom-build.md §15.6) — what the store returns and the deck renders
// ---------------------------------------------------------------------------

/**
 * The Program as it exists ON DISK, which is not the same question as "what
 * does the Program say".
 *
 * `exists: false` with `program: null` is the ordinary state of a project
 * nobody has set up yet, NOT an error — and `markdown` is carried beside the
 * parsed form because the Program tab edits text, while everything else reads
 * structure. `warnings` is the parser's output verbatim: a file that parsed
 * with complaints still has a `program`, because the parser has no error path.
 */
export const LoomProgramDoc = z.object({
  projectId: Id,
  path: z.string(),
  exists: z.boolean(),
  markdown: z.string(),
  program: LoomProgram.nullable(),
  warnings: z.array(z.string()).default([]),
});
export type LoomProgramDoc = z.infer<typeof LoomProgramDoc>;

/**
 * THE SENTINEL AS IT IS RIGHT NOW — the runtime counterpart to the Program's
 * `LoomWatchPolicy`. The policy says "every 300s, backing off to 3600s"; this
 * says "running, 4 quiet checks deep, next probe at 12:41, and the last one
 * failed because `gh` is not authenticated".
 *
 * `quietChecks` is the backoff's own state and is the reason this is persisted
 * rather than derived: a restart that reset it to zero would re-probe a silent
 * repo every five minutes forever, which is precisely the cost the backoff
 * exists to avoid. `lastError` is a STRING, not a flag — "could not probe" is
 * only actionable if it says why.
 */
export const LoomWatch = z.object({
  projectId: Id,
  running: z.boolean(),
  intervalSec: z.number().int().positive(),
  quietChecks: z.number().int().nonnegative().default(0),
  lastProbeAt: Timestamp.optional(),
  lastChangeAt: Timestamp.optional(),
  nextProbeAt: Timestamp.optional(),
  lastError: z.string().optional(),
  /**
   * THE PROJECT'S WORLD COULD NOT BE READ, AND THIS IS WHY — set when the
   * tick's `list` did not run, cleared when a later one does.
   *
   * NOT THE SAME FIELD AS `lastError`, and the difference is the reason this
   * one exists. `lastError` is one string several writers share: a failing
   * probe overwrites it, and a probe that starts working again clears it. That
   * is correct for the probe, which answers only for itself — but it means
   * `lastError` cannot answer "is this project's backlog still unreadable?",
   * and that question has a consequence the message does not: A PROJECT NOBODY
   * CAN READ IS NOT A QUIET ONE. A pass that finds nothing while this is set is
   * not evidence of quiet, so it must not be spent on the backoff. Without
   * that, a credential that expired at midnight decays the project to an hourly
   * cadence on evidence that was never gathered, and it stops being retried at
   * the rate its human configured precisely while it is broken.
   *
   * PERSISTED, AND THAT IS THE POINT. Held in memory it was re-earned on the
   * next tick — so a daemon that restarted mid-outage backed the broken project
   * off once per restart, and a crash loop could walk it all the way to the
   * ceiling while it was still broken. A STRING rather than a flag, for the
   * same reason `lastError` is one: the deck can only be acted on if it says
   * which command failed and what it said.
   */
  worldUnreadable: z.string().optional(),
});
export type LoomWatch = z.infer<typeof LoomWatch>;

/**
 * A dry run is a REAL tick that dispatches nothing. It is the trust surface at
 * setup (§12): what it would do right now, and what it noticed that you did not
 * say. Same code path, same output shape — a separate "preview" implementation
 * would preview something other than what runs.
 */
export const LoomRunKind = z.enum(["tick", "dry-run"]);
export type LoomRunKind = z.infer<typeof LoomRunKind>;

export const LoomRunState = z.enum(["running", "done", "failed", "cancelled"]);
export type LoomRunState = z.infer<typeof LoomRunState>;

/**
 * One in-flight (or just-finished) orchestrator invocation.
 *
 * `step` and `note` exist because a tick that reads a 200-issue backlog takes
 * long enough that a spinner is not an answer: the run says what it is doing
 * while it does it. `dispatched` lists the looms this run actually created —
 * which is NOT `decision.dispatch`, because machinery drops proposals the
 * agent had no right to make, and the difference between the two is the most
 * interesting line in the run.
 */
export const LoomRun = z.object({
  id: Id,
  projectId: Id,
  kind: LoomRunKind,
  state: LoomRunState,
  startedAt: Timestamp,
  settledAt: Timestamp.optional(),
  step: z.string().optional(),
  note: z.string().optional(),
  decision: TickDecision.optional(),
  dispatched: z.array(z.string()).default([]),
  error: z.string().optional(),
});
export type LoomRun = z.infer<typeof LoomRun>;

/**
 * A file the store could not read, named rather than swallowed.
 *
 * ONE BAD ROW MUST NOT TAKE OUT THE LIST. The alternative — validating the
 * whole directory as an array — turns a single corrupt loom into an empty
 * deck, and the person reading it has no way to know that is what happened.
 */
export const LoomUnreadable = z.object({
  file: z.string(),
  reason: z.string(),
});
export type LoomUnreadable = z.infer<typeof LoomUnreadable>;

export const LoomProjectSummary = z.object({
  projectId: Id,
  name: z.string(),
  root: z.string(),
  hasProgram: z.boolean(),
  programPath: z.string(),
  watch: LoomWatch,
  /** Every state present, so the deck's chips do not have to guess at zero. */
  counts: z.record(LoomState, z.number().int().nonnegative()),
  /** Program `assumed` items still awaiting confirmation — a badge, not a block. */
  assumed: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  /**
   * The project's orchestrator session, if one has been started.
   *
   * ABSENT IS A STATE, NOT A FAILURE: it means nobody has run setup here yet,
   * and the surface renders the invitation rather than an empty cockpit. The
   * centre pane is the STOCK session cockpit — this field is the only thing the
   * loom surface needs in order to point at it, which is the whole reason the
   * chat is not reimplemented.
   */
  orchestratorSessionId: Id.optional(),
});
export type LoomProjectSummary = z.infer<typeof LoomProjectSummary>;

/**
 * ONE CALL FOR THE WHOLE DECK.
 *
 * Not five endpoints on five cadences. Two surfaces fetched separately
 * disagree, and nothing in the payload says which half is stale — the spool
 * learned that the expensive way, and the rule is written into its store. A
 * snapshot is internally consistent by construction.
 */
/**
 * A TRIAGE ENTRY, ATTRIBUTED. The cache on disk is per project, so an entry
 * inside it needs no owner; the overview MERGES every project's cache into one
 * array, and the moment it does, "seen and not taken" for one project is
 * underivable from the snapshot. The alternative — a second read of
 * `GET /api/looms/triage` — is two cadences disagreeing with nothing saying
 * which is stale, which is the rule this whole shape exists to keep.
 */
export const OverviewTriageEntry = TriageEntry.extend({
  /**
   * OPTIONAL, AND NOT BECAUSE THE ENGINE MIGHT SKIP IT — it never does. A
   * DAEMON OLDER THAN THIS FIELD IS A REAL STATE: the engine is a long-lived
   * process and the cockpit reloads under it, so a UI that treated the field as
   * guaranteed would blank the classification pile for whoever is holding the
   * old daemon. Consumers resolve an unattributed entry themselves —
   * `apps/web/lib/loom-deck.ts`'s `scopeOverview` is the one that does, and it
   * attributes rather than guesses.
   */
  projectId: Id.optional(),
});
export type OverviewTriageEntry = z.infer<typeof OverviewTriageEntry>;

export const LoomOverview = z.object({
  projects: z.array(LoomProjectSummary).default([]),
  looms: z.array(Loom).default([]),
  triage: z.array(OverviewTriageEntry).default([]),
  runs: z.array(LoomRun).default([]),
  unreadable: z.array(LoomUnreadable).default([]),
});
export type LoomOverview = z.infer<typeof LoomOverview>;
