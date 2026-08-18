/**
 * THE NIGHT — work the Spool does while nobody is watching.
 *
 * `docs/spool-definition.md` §7.5. Not dispatch: nothing here cuts a worktree,
 * runs a session or opens a pull request. The night ORGANISES what you dumped
 * and drafts approaches for what is already understood, so the morning starts
 * from briefs instead of from fragments.
 *
 * ── THE SHAPE IS DECIDED BY HOW IT ENDS ──────────────────────────────────────
 * The account runs out. That is the ordinary end of a night, not an edge case,
 * and designing around it is why this is a QUEUE OF ATOMIC JOBS rather than one
 * long-running agent:
 *
 *   · One long agent that stops halfway leaves one unfinished thing that
 *     nothing can resume and nobody can trust.
 *   · A queue that stops halfway leaves N finished results and M pending ones,
 *     and "resume" means running the pending ones next time. Nothing more.
 *
 * Every job is one structured call over one item, and the record is written the
 * moment each lands. A rate limit, a crash, a closed lid — each costs at most
 * the single job in flight and never anything already recorded.
 *
 * ── DETERMINISTIC SELECTION, INTELLIGENCE IN THE LEAVES ──────────────────────
 * WHICH items get worked and in WHAT ORDER is decided here, in code a test can
 * read without a provider. No model chooses the night's plan. The same rule the
 * expert already follows, for the same reason: a plan chosen by a model is a
 * plan nobody can predict, audit or reproduce at 3am.
 *
 * ── ORDERED BY VALUE-IF-INTERRUPTED ──────────────────────────────────────────
 * Ripening comes before drafting, always. A night cut short after the ripening
 * has turned every fragment into a brief; one cut short after the drafting has
 * elaborate approaches attached to items whose shorthand is still shorthand.
 * The queue is ordered so that stopping early is always the second-best
 * outcome rather than a random one.
 *
 * ── WHY IT CANNOT KEEP DIGGING ───────────────────────────────────────────────
 * An agent left alone will always find more to do. That is not a tendency to
 * discourage in a prompt; it is a property to remove, and it is removed at three
 * levels because it can appear at three:
 *
 *   1. WITHIN ONE JOB. A structured call is capped at `maxTurns` and holds a
 *      read-only tool wall, so an expert cannot spend the night reading a repo
 *      and no job can spawn a child (`Agent` is denied by name in `agent.ts`).
 *
 *   2. WITHIN ONE NIGHT. `planNight` runs ONCE, when the night opens, and the
 *      loop walks that frozen array. Work that becomes eligible while the night
 *      runs — a ripened item now wanting a draft — is NOT picked up tonight. It
 *      waits for the next run. This is what makes "no budget" bounded rather
 *      than unbounded: the job count can never exceed the items that existed at
 *      open, no matter what the jobs produce.
 *
 *   3. ACROSS NIGHTS. Every job kind is TERMINAL for the item it touches —
 *      ripening sets `fixed` and drafting sets `draft`, and each predicate
 *      excludes what it produced. So the queue drains toward empty instead of
 *      regenerating, and a store nobody adds to converges on `nothing-to-do`.
 *
 * The load-bearing consequence: nothing the night does can enlarge the night.
 * The only thing that adds work to the Spool is a human, or an agent acting on a
 * human's turn — which is the conservation law the queue already states.
 *
 * ── EVERYTHING IT PRODUCES IS A PROPOSAL ─────────────────────────────────────
 * The night has no verb that starts, accepts, completes, promotes or deletes
 * anything. It cannot: the only writers it reaches are the store's audited ones,
 * and every timeline event they append is marked `proposal: true`. "Prepare,
 * never commit" is not enforced by a check here — there is no call it could
 * make that would violate it.
 */
import { z } from "zod";
import type { SpoolItem, SpoolNight, SpoolNightJob, SpoolNightStopReason } from "@telar/engine-client";
import { SpoolNight as NightSchema } from "@telar/engine-client";
import { structuredAgent, type StructuredAgentFailure, type StructuredAgentResult } from "../agent";
import { atomicWrite } from "../atomic";
import fs from "node:fs";
import path from "node:path";
import {
  applyDraft,
  applyVerification,
  capturedLabel,
  factsNeedingVerification,
  getSpoolItem,
  listItems,
  readExpertDigest,
  type SpoolPaths,
} from "./store";
import { runExpertPass, type ExpertPassOutcome } from "./expert";
import { classifySettle } from "./work";

// ── where a night lives ─────────────────────────────────────────────────────

/**
 * ONE FILE, REPLACED IN PLACE, rather than one per run.
 *
 * A night is not history the user browses — the ripening timeline on each
 * packet is where the durable record of what an agent did already lives, and it
 * is per item, which is where a human looks. This file exists so a stopped run
 * can be resumed and so the morning has one thing to read. Keeping every night
 * ever run would be a second, agent-written archive nobody asked for, growing
 * without bound in a store whose whole posture is that nothing accumulates
 * silently.
 */
export function nightPath(paths: SpoolPaths): string {
  return path.join(paths.root, "night.json");
}

export function readNight(paths: SpoolPaths): SpoolNight | null {
  try {
    const raw = fs.readFileSync(nightPath(paths), "utf8");
    if (raw.trim() === "") return null;
    const parsed = NightSchema.safeParse(JSON.parse(raw));
    // A NIGHT THAT CANNOT BE READ IS NOT AN ERROR THE USER SHOULD SEE. It is a
    // run record, not their data; the honest recovery is to start fresh rather
    // than to refuse to run at all. Their packets are untouched either way.
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeNight(paths: SpoolPaths, night: SpoolNight): SpoolNight {
  const parsed = NightSchema.parse(night);
  atomicWrite(nightPath(paths), parsed);
  return parsed;
}

// ── what there is to do ─────────────────────────────────────────────────────

/**
 * An item whose shorthand has never been decompressed.
 *
 * `raw` AND NO `fixed` is the whole test. It is deliberately not "has the expert
 * ever run" — a pass that produced nothing should be retried, and one that
 * produced a brief should not be re-run every night forever, quietly rewriting
 * the same packet and appending a timeline event each time.
 */
export function needsRipening(item: SpoolItem): boolean {
  // NEVER A CLOSED ITEM. The user ticked the box (docs/spool-loops.md §9), so
  // there is no work left for a night to prepare — ripening it would spend
  // money briefing a task that is over, and put an agent's fresh output on a
  // packet the human has already closed.
  return !!item.raw && !item.fixed && !!item.project && !item.closed;
}

/**
 * An item understood well enough to propose an approach for, and without one.
 *
 * DRAFTING REQUIRES A BRIEF, not just a title: an approach proposed from
 * shorthand is the invention the expert exists to prevent, and it would be
 * proposed with the same confidence as a good one.
 */
export function needsDrafting(item: SpoolItem): boolean {
  // NEVER A CLOSED ITEM — same guard as `needsRipening`, same reason: the
  // night proposes work, and a closed task has none.
  return !!item.fixed && !item.draft && !!item.project && !item.closed;
}

/**
 * TONIGHT'S PLAN, as a pure function of what is on disk.
 *
 * RIPENING FIRST, IN FULL, THEN DRAFTING — see the header's value-if-interrupted
 * rule. Within each kind the store's own order is kept rather than sorted by
 * anything: there is no clock to sort by and no priority field to invent, and
 * "the order they were captured in" is the one ordering the user already
 * expressed.
 */
/**
 * A CHECKABLE CLAIM AND A VERDICT — the `verify` job's forced answer.
 *
 * DELIBERATELY NARROW. There is no field for a corrected text, because this job
 * may drain a fact and may not rewrite one: an agent quietly editing what a
 * project believes, with no record of the edit, is the thing memory's whole
 * provenance apparatus exists to prevent. Writing a replacement is the next
 * ordinary pass's business.
 */
export const VerifyResult = z.object({
  checked: z
    .array(
      z.object({
        id: z.string().describe("The id of a fact you were given, exactly as it was written."),
        holds: z
          .boolean()
          .describe(
            "true if the checkout still bears this out. false ONLY if you found evidence it is wrong — not if you merely could not find the file. Absence of proof is not disproof, and draining a true fact costs more than keeping an unchecked one.",
          ),
        why: z.string().optional().describe("When it does not hold: what you found instead. Recorded beside it forever."),
      }),
    )
    .describe("One entry per fact you were given. Omit a fact you could not check at all rather than guessing."),
  note: z.string().describe("One line for the morning: what you checked and what moved."),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

/**
 * What a verification pass answers with.
 *
 * `head` RIDES BACK WITH THE ANSWER rather than being read again when the write
 * happens, and the reason is a race: a commit landing mid-pass would otherwise
 * stamp facts with a sha they were never checked against — which is worse than
 * leaving them unstamped, because it would suppress the next check too.
 */
export type VerifyOutcome =
  | { ok: true; value: VerifyResult; head: string; usage?: SpoolNightJob["usage"] }
  | { ok: false; kind: StructuredAgentFailure; reason: string; retryAfter?: number };

/** PURE, like `expertPrompt` and `draftPrompt`, and for the same reason: what a
 *  model is handed at 3am has to be reproducible in a test at noon. */
export function verifyPrompt(input: { subject: string; facts: Array<{ id: string; text: string }> }): string {
  const lines: string[] = [];
  lines.push(`You are checking what Telar remembers about the ${input.subject} project against its actual checkout.`);
  lines.push("");
  lines.push("## What it believes");
  for (const fact of input.facts) lines.push(`- (${fact.id}) ${fact.text}`);
  lines.push("");
  lines.push("## What to do");
  lines.push(
    "For each one, look at the code and decide whether it is still true. You may read, grep and glob; you cannot change anything.",
  );
  lines.push(
    "Say `holds: false` ONLY when you found something that contradicts it — a file that moved, a rule that changed, a name that no longer exists. If you simply could not find what it refers to, leave that fact out of your answer entirely: not finding something is not evidence against it, and draining a true fact costs more than keeping an unchecked one.",
  );
  lines.push("You are not fixing anything and nothing you write changes the code.");
  return lines.join("\n");
}

export function planNight(
  items: SpoolItem[],
  /**
   * WHAT EACH SUBJECT PERMITS, UNATTENDED — §7.6, and the first place the
   * Subject record does work rather than describe.
   *
   * A FUNCTION RATHER THAN THE REGISTRY ITSELF, so this file stays free of
   * `subjects.ts` for the reason the whole runner is dependency-injected: its
   * claim is that every stop signal is drivable in a test without a provider or
   * a daemon. Absent, everything is permitted — which is the behaviour before
   * this record existed, so a caller that has not been updated does not silently
   * stop working.
   */
  permits: (subject: string | undefined, level: "read" | "draft") => boolean = () => true,
  /**
   * Subjects holding facts not yet checked against their checkout — resolved by
   * the caller, because the predicate needs a digest and a HEAD and this
   * function is pure over items.
   */
  verifiable: string[] = [],
): Array<Pick<SpoolNightJob, "kind" | "itemId" | "subject" | "title">> {
  const ripen = items
    .filter((item) => needsRipening(item) && permits(item.project, "read"))
    .map((item) => ({ kind: "ripen" as const, itemId: item.id, title: item.title }));
  const draft = items
    .filter((item) => needsDrafting(item) && permits(item.project, "draft"))
    .map((item) => ({ kind: "draft" as const, itemId: item.id, title: item.title }));
  /**
   * MAINTENANCE GOES LAST, and it is the value-if-interrupted rule deciding
   * again. A night cut short after the ripening has turned every fragment into a
   * brief; one cut short after the drafting has approaches waiting too. One cut
   * short after only VERIFYING has tidied what the assistant believes and shown
   * the user nothing.
   *
   * The counter-argument is real and loses: drafting on an unchecked fact can
   * produce a stale approach. But a draft is a proposal nobody has accepted, and
   * the fact it rested on is still on the packet to be read — whereas a night
   * that produced nothing visible is indistinguishable from one that never ran.
   *
   * `read` IS THE LEVEL IT NEEDS. Checking what is already believed reads the
   * tree and proposes nothing, which is the floor's whole definition.
   */
  const verify = verifiable
    .filter((subject) => permits(subject, "read"))
    .map((subject) => ({ kind: "verify" as const, subject, title: `what it knows about ${subject}` }));
  return [...ripen, ...draft, ...verify];
}

// ── the draft ───────────────────────────────────────────────────────────────

/**
 * A CONCEPTUAL APPROACH, and the schema is what keeps it conceptual.
 *
 * There is no field for a file to change, a command to run, a branch to cut or
 * a step to execute. The widest thing a draft can say is "here is how I would
 * come at this, here is what worries me, and here is what I would need to know
 * first" — which is the thing a human reads over coffee and either recognises or
 * corrects, and which costs nothing to throw away.
 */
export const DraftResult = z.object({
  approach: z
    .string()
    .describe(
      "How you would come at this work, in a short paragraph or two. Concepts and sequence, not commands. Written for the person who will decide whether to do it.",
    ),
  risks: z
    .array(z.string())
    .describe("What could make this harder than it looks, or wrong. [] if you genuinely see none — do not pad."),
  openQuestions: z
    .array(z.string())
    .describe(
      "What you would need answered before starting. These are the questions the user reads first, so ask only what actually blocks a decision.",
    ),
  note: z.string().describe("One line naming what you drafted, for the ripening timeline."),
});
export type DraftResult = z.infer<typeof DraftResult>;

/** PURE, like the expert's own prompt, and for the same reason: a plan handed to
 *  a model at 3am has to be reproducible in a test at noon. */
export function draftPrompt(item: SpoolItem): string {
  const lines: string[] = [];
  lines.push(`You are drafting an approach for one piece of work on the ${item.project} project.`);
  lines.push("");
  lines.push(`## ${item.title}`);
  if (item.fixed) lines.push("", "### The brief", item.fixed);
  if (item.acceptance?.length) {
    lines.push("", "### It is done when");
    for (const a of item.acceptance) lines.push(`- ${a}`);
  }
  if (item.raw) lines.push("", "### What the user originally said", item.raw);
  lines.push("");
  lines.push("## What to do");
  lines.push(
    "Propose how you would approach this. You may read the project's files to ground it. Stay at the level of concepts and sequence — this is something the user reads to decide with, not a plan to execute from.",
  );
  lines.push(
    "You are not starting this work and nothing you write will start it. Say what you would need to know before beginning, and say plainly where you are guessing.",
  );
  lines.push(
    "You do not know what today is. Never turn a time word into a calendar date, and never state or imply the current date.",
  );
  return lines.join("\n");
}

// ── running one job ─────────────────────────────────────────────────────────

export type NightDeps = {
  /** Injected so the whole runner — selection, ordering, every stop signal and
   *  the resume path — is driven in tests without a subprocess or a cent. */
  ripen: (itemId: string) => Promise<ExpertPassOutcome>;
  draft: (item: SpoolItem) => Promise<StructuredAgentResult<DraftResult>>;
  /** Subjects holding facts not checked against their current commit. Read ONCE
   *  when the night opens, like every other half of the plan — a subject that
   *  becomes verifiable mid-night waits for the next run, which is the frozen
   *  plan doing exactly what it does for items. */
  verifiable?: () => string[];
  /**
   * Re-check one subject's `howItWorks` facts against its checkout, answering
   * with the HEAD they were checked at.
   *
   * THE HEAD RIDES BACK WITH THE ANSWER rather than being read again here, and
   * the reason is a race: a commit landing mid-pass would otherwise stamp facts
   * with a sha they were never checked against, which is worse than not
   * stamping them — it would suppress the next check too.
   *
   * OPTIONAL, so a caller that has not been updated simply plans no verify
   * jobs rather than failing every one of them.
   */
  verify?: (subject: string) => Promise<VerifyOutcome>;
  /** True when a person is using the account right now. Checked BEFORE every
   *  job, never once at the start: the whole point is to yield the moment they
   *  come back. */
  humanActive: () => boolean;
  now: () => Date;
  /**
   * WHAT EACH SUBJECT PERMITS UNATTENDED — §7.6, threaded to `planNight` so the
   * night's plan is subject-aware. Optional: absent means everything is
   * permitted, which is the behaviour before the Subject record existed.
   */
  permits?: (subject: string | undefined, level: "read" | "draft") => boolean;
};

/**
 * CEILINGS ARE AVAILABLE AND NONE IS ON BY DEFAULT.
 *
 * The instinct is to cap the spend, and the reason not to — for now — is that a
 * cap would hide whether the REAL stop signals work. A night that always halts
 * at $5 tells you nothing about whether it would ever have halted on its own,
 * and the whole question being tested is what an agent does when nobody is
 * watching and nothing arbitrary interrupts it.
 *
 * THE HONEST CEILING IS STRUCTURAL, NOT NUMERIC, and it is `planNight` freezing
 * the plan at the moment the night opens. See "the night cannot grow" below:
 * the number of jobs is bounded by the items that existed when it started, so
 * "no budget" is bounded by the store rather than unbounded.
 */
export type NightBudget = {
  /** Hard ceiling on jobs in one run. Off by default — the frozen plan is the
   *  real bound. */
  maxJobs?: number;
  /** Hard ceiling on spend, in USD. Off by default; see above. */
  maxCostUsd?: number;
  /** Consecutive failures before the night gives up. NOT a budget — a fault
   *  stop. It stays on, because "the same thing is broken every time" is not a
   *  signal worth paying to rediscover twenty times.  */
  maxConsecutiveFailures?: number;
};

const DEFAULTS: Required<NightBudget> = { maxJobs: 0, maxCostUsd: 0, maxConsecutiveFailures: 3 };

function totalUsage(jobs: SpoolNightJob[]): SpoolNight["usage"] {
  const seen = jobs.map((job) => job.usage).filter((usage): usage is NonNullable<typeof usage> => !!usage);
  if (seen.length === 0) return undefined;
  return {
    tokens: {
      input: seen.reduce((n, u) => n + u.tokens.input, 0),
      output: seen.reduce((n, u) => n + u.tokens.output, 0),
      cacheRead: seen.reduce((n, u) => n + u.tokens.cacheRead, 0),
      cacheCreate: seen.reduce((n, u) => n + u.tokens.cacheCreate, 0),
    },
    // ABSENT STAYS ABSENT. A provider that reported no cost is not the same as
    // a free call, and a night's total that silently counted unknowns as zero
    // would understate what was spent.
    ...(seen.some((u) => u.costUsd !== undefined)
      ? { costUsd: seen.reduce((n, u) => n + (u.costUsd ?? 0), 0) }
      : {}),
  };
}

const spentSoFar = (jobs: SpoolNightJob[]): number => totalUsage(jobs)?.costUsd ?? 0;

// ── the run ─────────────────────────────────────────────────────────────────

/**
 * Run tonight's queue, or continue the one that stopped.
 *
 * RESUME IS NOT A SEPARATE PATH. A stopped night whose jobs are still pending is
 * simply this function called again: it reads the record, finds pending jobs and
 * carries on. There is no "resume" verb to forget to call, and no second code
 * path that could drift from the first.
 */
export async function runNight(
  paths: SpoolPaths,
  deps: NightDeps,
  budget: NightBudget = {},
): Promise<SpoolNight> {
  const limits = { ...DEFAULTS, ...budget };
  const existing = readNight(paths);

  /**
   * CONTINUE A NIGHT THAT STILL HAS WORK, otherwise open a new one. A finished
   * night is not resumed — its jobs are all settled, and re-running it would
   * re-do work the user has already been shown.
   */
  const resuming = existing && existing.jobs.some((job) => job.state === "pending");
  let night: SpoolNight = resuming
    ? { ...existing, state: "running", stop: undefined }
    : {
        id: `night-${crypto.randomUUID().slice(0, 12)}`,
        state: "running",
        opened: capturedLabel(deps.now()),
        // FROZEN HERE, ONCE. Read the header's "why it cannot keep digging":
        // the loop below walks this array and never re-plans, so nothing a job
        // produces can lengthen the night that produced it.
        jobs: planNight(listItems(paths).items, deps.permits, deps.verifiable?.() ?? []).map((job, index) => ({
          ...job,
          id: `job-${index + 1}`,
          state: "pending" as const,
        })),
      };

  /**
   * ONE ARRAY FOR THE WHOLE RUN, held in a local rather than read back off
   * `night` each time.
   *
   * `writeNight` re-parses and returns a NEW object with a NEW jobs array. An
   * earlier version reassigned `night` from it inside the loop, which detached
   * the `for…of` cursor from the record being written: every job after the
   * first mutated an array that was no longer part of the night, so only job
   * one's result was ever persisted — and the totals, the resume set and the
   * failure streak were all computed off it.
   */
  const jobs = night.jobs;

  const halt = (reason: SpoolNightStopReason, note: string, resumeAfter?: number): SpoolNight => {
    night = {
      ...night,
      jobs,
      // `nothing-to-do` IS THE ONLY REASON THAT MEANS FINISHED. Every other one
      // leaves the night stopped with work still in it, which is what the next
      // run looks for.
      state: reason === "nothing-to-do" ? "done" : "stopped",
      stop: { reason, note, ...(resumeAfter ? { resumeAfter } : {}) },
      ...(totalUsage(jobs) ? { usage: totalUsage(jobs) } : {}),
    };
    return writeNight(paths, night);
  };

  if (night.jobs.length === 0) {
    return halt("nothing-to-do", "Nothing needed doing — every item already carries a brief.");
  }

  // Written before the first job so a crash in job one still leaves a record
  // saying a night was under way.
  writeNight(paths, night);

  let ran = 0;
  let consecutiveFailures = 0;

  for (const job of jobs) {
    if (job.state !== "pending") continue;

    /**
     * EVERY STOP CONDITION IS CHECKED BEFORE THE JOB, never after. Checking
     * afterwards would spend the call it was meant to prevent — which for the
     * budget ceiling means overshooting it by exactly one job, every time.
     */
    if (deps.humanActive()) {
      return halt("human-active", "You came back, so the night stood down. What is left runs next time.");
    }
    if (limits.maxJobs > 0 && ran >= limits.maxJobs) {
      return halt("budget", `Reached this run's ceiling of ${limits.maxJobs} items. The rest are still queued.`);
    }
    if (limits.maxCostUsd > 0 && spentSoFar(jobs) >= limits.maxCostUsd) {
      return halt("budget", `Reached this run's spend ceiling. The rest are still queued.`);
    }
    if (consecutiveFailures >= limits.maxConsecutiveFailures) {
      return halt(
        "failing",
        `${consecutiveFailures} items failed in a row, so the night stopped rather than working through the rest to find the same fault.`,
      );
    }

    /**
     * A `verify` JOB HAS NO ITEM — it is the one kind about a SUBJECT. So the
     * item lookup is per kind rather than up front, which is also what keeps
     * "the item went away" an honest refusal instead of a message about an item
     * the job never named.
     */
    let outcome: JobOutcome;
    if (job.kind === "verify") {
      ran += 1;
      outcome = await runVerify(paths, deps, job);
    } else {
      const item = job.itemId ? getSpoolItem(paths, job.itemId) : null;
      if (!item) {
        // The item went away between planning and running. Not a failure of
        // anything — recorded and stepped over.
        job.state = "refused";
        job.note = "This item is no longer in the spool.";
        writeNight(paths, { ...night, jobs });
        continue;
      }
      ran += 1;
      outcome = job.kind === "ripen" ? await runRipen(deps, job, item) : await runDraft(paths, deps, job, item);
    }

    if (outcome.rateLimited) {
      /**
       * THE JOB STAYS PENDING. A rate limit says nothing about this item, so
       * marking it failed would silently drop real work from the queue and the
       * next run would never look at it again.
       */
      return halt("rate-limited", outcome.note, outcome.retryAfter);
    }

    job.state = outcome.state;
    job.note = outcome.note;
    if (outcome.usage) job.usage = outcome.usage;
    if (outcome.openQuestions?.length) job.openQuestions = outcome.openQuestions;
    consecutiveFailures = outcome.state === "failed" ? consecutiveFailures + 1 : 0;

    // AFTER EVERY JOB. This single line is what makes the whole thing
    // resumable: whatever happens next, everything up to here is on disk.
    writeNight(paths, { ...night, jobs });
  }

  return halt("nothing-to-do", "Everything queued for tonight is done.");
}

type JobOutcome = {
  state: "done" | "refused" | "failed";
  note: string;
  usage?: SpoolNightJob["usage"];
  /** What this job could not answer alone. `runDraft` already produced these and
   *  the record dropped them on the floor — see `SpoolNightJob.openQuestions`
   *  for why the night has to hold its own copy. */
  openQuestions?: string[];
  rateLimited?: boolean;
  retryAfter?: number;
};

/**
 * RE-CHECK WHAT A SUBJECT BELIEVES, and stamp or drain each claim.
 *
 * THE ONE JOB THAT MAINTAINS RATHER THAN PRODUCES, and the only one whose
 * predicate its own output falsifies directly: every fact it reports on comes
 * back carrying the HEAD it was checked at, so a second run on an unchanged tree
 * has nothing to select.
 *
 * A SUBJECT WITH NO CHECKOUT IS REFUSED, NOT FAILED. "There is no tree here to
 * check against" is the system working — school and a client engagement are
 * subjects with no repository, which is the ordinary case and not a fault.
 */
async function runVerify(paths: SpoolPaths, deps: NightDeps, job: SpoolNightJob): Promise<JobOutcome> {
  const subject = job.subject;
  if (!subject || !deps.verify) {
    return { state: "refused", note: "Nothing here can check a subject's memory against a checkout." };
  }
  const result = await deps.verify(subject);
  if (!result.ok) {
    if (result.kind === "rate-limited") {
      return {
        state: "failed",
        note: result.reason,
        rateLimited: true,
        ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
      };
    }
    if (result.kind === "aborted") return { state: "refused", note: result.reason };
    // "No checkout" arrives here as an ordinary unavailability; the caller's
    // resolver is what knows the difference and says so in the reason.
    return { state: /no checkout|nothing to check/i.test(result.reason) ? "refused" : "failed", note: result.reason };
  }

  const applied = applyVerification(paths, subject, {
    at: capturedLabel(deps.now()),
    head: result.head,
    checked: result.value.checked,
  });
  if (!applied) return { state: "refused", note: `${subject} has no memory to check.` };

  /**
   * THE NOTE SAYS WHAT MOVED, and says nothing when nothing did. "Checked 9,
   * all still true" is a sentence worth reading once; a morning report that
   * announced every no-op would train the reader to skip it.
   */
  return {
    state: "done",
    note:
      applied.retired > 0
        ? `Checked what it knows about ${subject} — ${applied.retired} no longer true, drained.`
        : `Checked what it knows about ${subject}; all of it still holds.`,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

async function runRipen(deps: NightDeps, job: SpoolNightJob, item: SpoolItem): Promise<JobOutcome> {
  // `item.id`, NOT `job.itemId` — the job's is optional now that `verify` has
  // none, and this one is the item the loop actually resolved and handed over.
  const outcome = await deps.ripen(item.id);
  if (outcome.ok) {
    return {
      state: "done",
      note: outcome.cold
        ? `Read it for the first time — the ${outcome.project} expert had no memory of the project and wrote one.`
        : `The ${outcome.project} expert turned the shorthand into a brief.`,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    };
  }
  if (/rate limited/i.test(outcome.reason)) {
    return { state: "failed", note: outcome.reason, rateLimited: true };
  }
  /**
   * A FLOATING ITEM IS REFUSED, NOT FAILED, and this is the case that makes
   * the morning report worth reading: it is the system telling you the one
   * thing only you can do — say which subject this belongs to. A pass you
   * STOPPED yourself is a refusal for the same reason, and it matters twice
   * over: three deliberate stops would otherwise trip the consecutive-failure
   * halt and report "3 items failed in a row", which is not what happened.
   */
  return { state: classifySettle(outcome.reason), note: outcome.reason };
}

async function runDraft(
  paths: SpoolPaths,
  deps: NightDeps,
  job: SpoolNightJob,
  item: SpoolItem,
): Promise<JobOutcome> {
  const result = await deps.draft(item);
  if (!result.ok) {
    if (result.kind === "rate-limited") {
      return {
        state: "failed",
        note: result.reason,
        rateLimited: true,
        ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
      };
    }
    // `aborted` IS YOUR OWN DECISION, not a fault — see `runRipen` above for
    // why the distinction is load-bearing rather than cosmetic.
    return { state: result.kind === "aborted" ? "refused" : "failed", note: result.reason };
  }

  /**
   * THE WRITE HAPPENS HERE, through the store's own verb, exactly as the expert
   * does it — the model returned a structure and touched nothing. The timeline
   * event is marked a proposal because that is what it is: an agent wrote it and
   * nobody has looked.
   */
  /**
   * THE RISKS STAY IN THE PROSE; THE QUESTIONS DO NOT.
   *
   * Both used to be flattened into one string. A risk is a qualification on the
   * approach and reads correctly beneath it — but a question is addressed to the
   * user, and the morning report has to lead with "here is what it could not
   * answer alone" without parsing a paragraph to find out. So the questions
   * travel as data (`SpoolItem.openQuestions`) and the surfaces render them.
   */
  const body = [
    result.value.approach,
    result.value.risks.length ? `\n\nWhat could go wrong:\n${result.value.risks.map((r) => `- ${r}`).join("\n")}` : "",
  ].join("");

  if (
    !applyDraft(paths, item.id, {
      approach: body,
      note: result.value.note,
      openQuestions: result.value.openQuestions,
    })
  ) {
    return { state: "refused", note: "This item is no longer in the spool." };
  }

  return {
    state: "done",
    note:
      result.value.openQuestions.length > 0
        ? `Drafted an approach, with ${result.value.openQuestions.length} question${result.value.openQuestions.length === 1 ? "" : "s"} for you.`
        : "Drafted an approach.",
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

/** The live dependencies. Kept beside the runner so the injected shape and the
 *  real one cannot drift, and thin enough that reading it is the whole proof. */
/**
 * What the live deps need from the world outside this file.
 *
 * AN OBJECT RATHER THAN SEVEN POSITIONAL PARAMETERS. It was six and growing,
 * and at that length the call site stops saying what it passes — five of them
 * are optional and any two could be swapped without a type error, which is the
 * shape of a bug nothing catches.
 *
 * EVERY OPTIONAL ONE DEGRADES TO "BEHAVE AS BEFORE". A caller that has not been
 * updated plans no verify jobs and gates nothing, rather than failing.
 */
export type NightWorld = {
  humanActive: () => boolean;
  cwdFor: (subject: string) => string | undefined;
  /**
   * When present, each job opens an entry in `spool/work.ts` so the morning can
   * show what ran while you slept in the same shape as what is running while
   * you watch.
   */
  watch?: NightWatch;
  /** §7.6, resolved by the caller against `subjects.ts` — this file stays free
   *  of the registry so the runner remains drivable without one. */
  permits?: (subject: string | undefined, level: "read" | "draft") => boolean;
  /**
   * The commit a subject's checkout is on, or undefined when it has none.
   *
   * INJECTED RATHER THAN SHELLING OUT HERE. This file's whole claim is that
   * every stop signal is drivable without a subprocess; running `git` from it
   * would make a night's plan depend on the machine a test happens to run on.
   */
  headFor?: (subject: string) => string | undefined;
  /** Subjects holding facts not checked against their current commit — the
   *  `verify` job's selection, resolved by the caller for the same reason. */
  verifiable?: () => string[];
};

export function nightDeps(paths: SpoolPaths, world: NightWorld): NightDeps {
  const { humanActive, cwdFor, watch, permits, headFor, verifiable } = world;
  return {
    humanActive,
    now: () => new Date(),
    ...(permits ? { permits } : {}),
    ...(verifiable ? { verifiable } : {}),
    ripen: (itemId) => {
      const item = getSpoolItem(paths, itemId);
      const project = item?.project;
      if (!project) return Promise.resolve({ ok: false as const, reason: "This item is floating — it belongs to no project." });
      const cwd = cwdFor(project);
      /**
       * ONE CONTROLLER PER JOB, HANDED TO THE WATCHER.
       *
       * Without it the morning report showed a stop button on overnight work
       * that silently did nothing — the same class of defect as a panel toggle
       * that opens a panel `display: none` can never show. A night is the work
       * you MOST want to be able to stop, because it is the work you did not
       * watch start.
       */
      const abort = new AbortController();
      const seen = watch?.({ kind: "expert", itemId, itemTitle: item?.title ?? itemId, project, abort });
      return runExpertPass(paths, {
        itemId,
        project,
        ...(cwd ? { cwd } : {}),
        abort,
        ...(seen ? { onStep: seen.step } : {}),
      }).then((outcome) => {
        seen?.settle(
          outcome.ok
            ? { state: "done", note: `The ${outcome.project} expert turned the shorthand into a brief.`, ...(outcome.usage ? { usage: outcome.usage } : {}) }
            : { state: "failed", note: outcome.reason },
        );
        return outcome;
      });
    },
    draft: (item) => {
      const abort = new AbortController();
      const seen = watch?.({
        kind: "draft",
        itemId: item.id,
        itemTitle: item.title,
        ...(item.project ? { project: item.project } : {}),
        abort,
      });
      return structuredAgent(draftPrompt(item), {
        schema: DraftResult,
        label: `draft:${item.project ?? "floating"}`,
        ...(() => {
          const cwd = item.project ? cwdFor(item.project) : undefined;
          return cwd ? { cwd } : {};
        })(),
        abort,
        ...(seen ? { onStep: seen.step } : {}),
      }).then((result) => {
        seen?.settle(
          result.ok
            ? { state: "done", note: result.value.note, ...(result.usage ? { usage: result.usage } : {}) }
            : { state: "failed", note: result.reason },
        );
        return result;
      });
    },
    ...(headFor
      ? {
          verify: async (subject: string): Promise<VerifyOutcome> => {
            /**
             * HEAD IS READ ONCE, BEFORE THE PASS, and travels with the answer.
             * Reading it again at write time would let a commit landing
             * mid-pass stamp facts with a sha they were never checked
             * against — worse than leaving them unstamped, because it would
             * suppress the next check too.
             */
            const head = headFor(subject);
            const cwd = cwdFor(subject);
            if (!head || !cwd) {
              return {
                ok: false,
                kind: "unavailable",
                reason: `${subject} has no checkout on this machine, so there is nothing to check its memory against.`,
              };
            }

            const stale = factsNeedingVerification(readExpertDigest(paths, subject), head);
            if (stale.length === 0) {
              return { ok: false, kind: "unavailable", reason: `nothing to check on ${subject}.` };
            }

            const seen = watch?.({
              kind: "expert",
              itemId: `subject:${subject}`,
              itemTitle: `what it knows about ${subject}`,
              project: subject,
              abort: new AbortController(),
            });
            const result = await structuredAgent(
              verifyPrompt({ subject, facts: stale.map((f) => ({ id: f.id, text: f.text })) }),
              {
                schema: VerifyResult,
                label: `verify:${subject}`,
                cwd,
                ...(seen ? { onStep: seen.step } : {}),
              },
            );
            seen?.settle(
              result.ok
                ? { state: "done", note: result.value.note, ...(result.usage ? { usage: result.usage } : {}) }
                : { state: classifySettle(result.reason), note: result.reason },
            );
            return result.ok
              ? { ok: true, value: result.value, head, ...(result.usage ? { usage: result.usage } : {}) }
              : {
                  ok: false,
                  kind: result.kind,
                  reason: result.reason,
                  ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
                };
          },
        }
      : {}),
  };
}

/**
 * How a night tells someone it is working, without knowing who.
 *
 * A FUNCTION RATHER THAN AN IMPORT of the registry, so this file stays free of
 * it: the runner's whole claim is that it is testable without a provider and
 * without a daemon, and reaching into a process-wide registry would end that.
 */
export type NightWatch = (input: {
  kind: "expert" | "draft";
  itemId: string;
  itemTitle: string;
  project?: string;
  /** The job's own controller, so whoever is watching can stop it. Overnight
   *  work is the work you most want to be able to stop, because it is the work
   *  you did not watch start. */
  abort: AbortController;
}) => { step: (step: { n: number; label: string }) => void; settle: (outcome: NightWatchOutcome) => void } | undefined;

export type NightWatchOutcome = {
  state: "done" | "refused" | "failed";
  note: string;
  usage?: { tokens: { input: number; output: number; cacheRead: number; cacheCreate: number }; costUsd?: number; turns?: number };
};
