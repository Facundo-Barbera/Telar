/**
 * THE TICK AND THE LOOM LIFECYCLE.
 *
 * ── WHY THE ORCHESTRATOR IS STATELESS AND THIS FILE IS WHERE THAT IS TRUE ────
 * `orchestrator.md` §3.2: a fresh orchestrator on every tick. Read the world,
 * decide, dispatch, write down the reasoning, exit. That kills the three things
 * that killed the long-lived agent — degraded choices from long context,
 * auto-compaction near 1M, and cost ramping with uptime — but it buys them with
 * one obligation, and `advanceLooms` is that obligation paid:
 *
 *   **IN-FLIGHT STATE IS RE-DERIVED, NEVER REMEMBERED.** The orchestrator that
 *   dispatched a loom is gone. Nothing survives it but files. So every tick
 *   re-asks, from the outside: is that session still alive? does that worktree
 *   have commits? A system that instead remembered "I dispatched #47" would be
 *   wrong the first time a laptop lid closed.
 *
 * There is deliberately NO heartbeat file (§4, decided). The session store
 * already knows whether a session is alive, and a second source of truth exists
 * only to disagree with the first at 4am.
 *
 * ── THE AGENT DECIDES, THE MACHINERY ENFORCES ───────────────────────────────
 * §3.4. `validateDecision` is the wall: an item that already has a non-terminal
 * loom is not dispatched twice, `concurrency` is not exceeded, a park or ask
 * naming a loom that does not exist is dropped. And **every drop is reported** —
 * to the ledger, and to the dry-run report. A decision quietly trimmed is worse
 * than one refused, because the human reads the tick as having been obeyed.
 *
 * ── ONE STEP AT A TIME, BUT NOT ONE STEP PER INTERVAL ───────────────────────
 * `advanceOne` moves a loom exactly one edge. `advanceLooms` then re-runs it
 * until the loom lands on a state that waits for something outside the process —
 * `working` (a session), `asking` (a human), or terminal. A finished worker
 * therefore reaches `published` in the SAME pass rather than three intervals
 * later, which at a 300s cadence would be fifteen minutes of a machine sitting
 * on a green gate. The loop is bounded by `MAX_ADVANCE_STEPS` so a transition
 * bug costs a bounded pass rather than a spin.
 */
import type { Loom, LoomProgram, LoomRun, TriageEntry } from "@telar/engine-client";
import { createSessionWorktree, type GitRunner } from "../worktree";
import { slugify, validateDecision } from "./decide";
import { nextRung } from "./ladder";
import { isActive, isTerminal, transitionLoom } from "./machine";
import { pruneCache, staleItems } from "./triage";
import {
  appendLedger,
  getLoom,
  listLooms,
  readLedger,
  readSentinel,
  readTriage,
  readWatchRecord,
  writeLoom,
  writeTriage,
  writeWatchRecord,
  type LoomPaths,
  type LoomRuntime,
} from "./store";
import { baseRefFor, gateLoom, publishLoom, type LoomGateDeps } from "./gate";
import { dryRunReport, LEDGER_WINDOW, orchestratorPrompt, setupPrompt, workerPrompt } from "./prompt";
import { withSlots, type LoomExec } from "./exec";
import { createLoomRuns, type LoomRunHandle, type LoomRunRegistry } from "./run";
import { createLoomSupervisor, type LoomSupervisor } from "./supervisor";
import type { TickDecision } from "@telar/engine-client";

/**
 * How many items get their `detail` read in one tick.
 *
 * §7's cap. `detail` is the expensive command — "read the whole comment thread"
 * — and the triage cache exists so it happens once per item per change rather
 * than once per tick. But a backlog that moves all at once (a milestone closed,
 * a label swept) can make thirty items stale in one minute, and thirty `gh issue
 * view --comments` calls is a tick that costs more than the work it decides.
 *
 * THE CAP IS ANNOUNCED, NOT SILENT. What the orchestrator is told, and what the
 * dry-run report prints, is that N items were NOT read. Silent truncation reads
 * as "that was all of them", which is exactly how a `needs-credentials` item
 * gets classified `dispatchable` from its title alone.
 */
export const DETAIL_CAP = 8;

/** See the header. A bound on a loop that should converge in three. */
const MAX_ADVANCE_STEPS = 6;

export type LoomAgent = (
  prompt: string,
  /**
   * WHICH PROJECT THIS TICK IS ABOUT, and where its checkout is.
   *
   * OPTIONAL, and that is the whole of its compatibility story: a fake that
   * takes only a prompt still satisfies this type, so every test that stubs the
   * orchestrator is untouched. The real agent needs it because a `LoomAgent` is
   * built ONCE per daemon and asked about every project — without a per-call
   * root, its `Read`/`Grep` would be pointed at the engine's own cwd, and an
   * orchestrator that cannot open the repository it is triaging is deciding
   * from titles.
   *
   * `cwd` is the project's OWN root, never a loom's worktree: the tick reasons
   * about the project as it is, and a worktree is one item's private copy of it.
   */
  context?: { projectId: string; cwd: string },
) => Promise<{ ok: true; value: TickDecision } | { ok: false; reason: string }>;

/**
 * How the runtime reaches Telar sessions.
 *
 * A PORT, not an import of the session store, for the reason every expensive
 * thing in this daemon is injected (`daemon.ts:51-85`): the whole lifecycle has
 * to be drivable by a test that never starts a provider, never loads the Claude
 * SDK and never spends a token.
 *
 * `status` is the ONLY done-detection there is (§4, decided). `gone` and `done`
 * are treated identically here — both mean "the worker is no longer running" —
 * but they are kept apart in the type because the surface distinguishes a
 * session that ended from one that was reaped, and collapsing them in the port
 * would make that unrecoverable.
 */
export type LoomSessionPort = {
  /**
   * A WORKER: a session in THE worktree this dispatch already cut, with the
   * brief as its first turn.
   *
   * `worktree`, `branch` and `baseRef` TRAVEL TOGETHER AND THE BRANCH IS THE
   * REASON. The checkout is cut here, on the branch the Program names, off the
   * base the Program declares, with the Program's `setup` run in it — and the
   * session ADOPTS it. A port that took only a path would leave the session
   * free to record a different branch than the one the work lands on, which is
   * exactly the divergence that made a finished worker look idle: `publish`
   * pushes the recorded branch and the gate counts commits on the real one.
   *
   * `baseRef` is absent when a re-provisioned loom adopts a worktree cut hours
   * ago whose base no longer resolves; the store drops it rather than refusing.
   */
  start(input: {
    projectId: string;
    worktree: string;
    branch: string;
    baseRef?: string;
    prompt: string;
    title: string;
  }): Promise<{ sessionId: string }>;
  /**
   * THE ORCHESTRATOR SESSION: a conversational session pinned to the project's
   * OWN ROOT, not to a worktree.
   *
   * Separate from `start` because the difference is the point. A worker is
   * headless, disposable, scoped to one item and isolated in its own checkout
   * so its diff is attributable. This one is the human's counterpart — it reads
   * the repository and proposes, it never implements — and pinning it to a
   * worktree would have it reading a stale copy of the project it is describing.
   */
  create(input: { projectId: string; cwd: string; title: string; prompt?: string }): Promise<{ sessionId: string }>;
  status(sessionId: string): Promise<"running" | "done" | "gone">;
  stop(sessionId: string): Promise<void>;
};

export type LoomTickDeps = LoomGateDeps & {
  runs: LoomRunRegistry;
  agent: LoomAgent;
  session: LoomSessionPort;
  git: GitRunner;
  exec: LoomExec;
  engineRoot: string;
  readProgram: (projectId: string) => LoomProgram | null;
  /** The Program's own markdown, when the caller has it, so the prompt quotes
   *  the human's file rather than a re-render of it. */
  readProgramMarkdown?: (projectId: string) => string | null;
};

export type TickOptions = {
  dryRun?: boolean;
  handle?: LoomRunHandle;
  /** What the supervisor observed, for the prompt's "did anything change". */
  probeChanged?: boolean;
};

export type TickResult = { decision: TickDecision; dispatched: Loom[]; report?: string };

// ── the tick ────────────────────────────────────────────────────────────────

export async function runLoomTick(
  deps: LoomTickDeps,
  projectId: string,
  opts: TickOptions = {},
): Promise<TickResult> {
  const program = deps.readProgram(projectId);
  if (!program) {
    // A SENTENCE A HUMAN CAN ACT ON, not a code. This is the single most likely
    // first-run failure and the recovery is one file.
    throw new Error(
      `project ${projectId} has no Loom Program, so there is nothing to tick: no probe to run, no way to list work, and no gate to hold a change to. Create \`.telar/loom.md\` in the project repo — the Program tab writes it for you, or run setup and answer six questions.`,
    );
  }
  const root = deps.projectRoot(projectId);
  if (!root) {
    throw new Error(
      `project ${projectId} has no checkout on this machine, so its commands have nowhere to run. Open the project in Telar once, or fix its recorded root.`,
    );
  }

  const now = deps.now();
  const at = now.getTime();
  const handle = opts.handle;

  // §6's first branch: reconcile before deciding. An orchestrator shown a loom
  // as `working` that finished an hour ago decides against a world that no
  // longer exists — and might dispatch the item again.
  handle?.step("reconciling looms in flight");
  await advanceLooms(deps, projectId);

  handle?.step("reading the work list");
  const list = program.commands.list
    ? await deps.exec({
        command: program.commands.list,
        cwd: root,
        ...(deps.signal ? { signal: deps.signal } : {}),
      })
    : null;
  const listed = parseListed(list?.code === 0 ? list.stdout : "");

  const cache = readTriage(deps.paths, projectId);
  const stale = program.commands.detail ? staleItems(cache, listed) : [];
  const chosen = stale.slice(0, DETAIL_CAP);
  const skipped = stale.length - chosen.length;

  const details: Array<{ item: string; detail: string }> = [];
  for (const item of chosen) {
    handle?.step(`reading item ${item}`);
    const run = await deps.exec(
      withSlots({
        command: program.commands.detail as string,
        cwd: root,
        ...(deps.signal ? { signal: deps.signal } : {}),
        vars: { ITEM: item },
      }),
    );
    // A FAILED `detail` IS HANDED TO THE AGENT AS A FAILURE, not dropped. An
    // item silently missing from the prompt is an item the tick had no opinion
    // about and no way to say so.
    details.push({
      item,
      detail: run.code === 0 ? run.stdout : `the detail command exited ${run.code}:\n${run.stderr || run.stdout}`,
    });
  }

  const fingerprint = readSentinel(deps.paths, projectId);
  const looms = listLooms(deps.paths, projectId).looms;
  const context = {
    projectId,
    now,
    program,
    ...(deps.readProgramMarkdown?.(projectId) ? { markdown: deps.readProgramMarkdown(projectId) as string } : {}),
    probe: fingerprint ? { output: fingerprint.probe, changed: opts.probeChanged ?? true } : null,
    list: list ? { output: `${list.stdout}${list.stderr.trim() ? `\n${list.stderr}` : ""}`, code: list.code } : null,
    looms,
    details,
    staleCount: stale.length,
    skipped,
    ledger: readLedger(deps.paths, projectId, LEDGER_WINDOW),
  };

  handle?.step("asking the orchestrator");
  // The root goes with the prompt: see `LoomAgent`. One agent serves every
  // project, so the project is named per call rather than at construction.
  const answer = await deps.agent(orchestratorPrompt(context), { projectId, cwd: root });
  if (!answer.ok) throw new Error(answer.reason);

  const { decision, rejected } = validateDecision(answer.value, {
    looms,
    concurrency: program.work.concurrency,
  });

  if (opts.dryRun) {
    // NOTHING IS PERSISTED AND NOTHING IS DISPATCHED. §4.2: the dry run is the
    // trust surface, and a trust surface with side effects is not one.
    return { decision, dispatched: [], report: dryRunReport(decision, { ...context, rejected }) };
  }

  handle?.step("recording the decision");
  persistTriage(deps, projectId, decision, listed, at);

  appendLedger(deps.paths, projectId, {
    at,
    kind: "tick",
    summary: decision.note.trim() || "tick with no note",
    detail:
      `${decision.triage.length} triaged · ${decision.dispatch.length} to dispatch · ${decision.park.length} to park · ${decision.ask.length} to ask` +
      (skipped > 0 ? ` · ${skipped} stale item(s) not read (per-tick detail cap ${DETAIL_CAP})` : ""),
  });

  // EVERY DROP IS REPORTED. See the header.
  for (const rejection of rejected) {
    appendLedger(deps.paths, projectId, {
      at,
      kind: "error",
      summary: "the harness dropped part of the decision",
      detail: rejection,
    });
  }

  for (const park of decision.park) applyPark(deps, projectId, park.loomId, park.reason, at);
  for (const ask of decision.ask) applyAsk(deps, projectId, ask, at);

  const dispatched: Loom[] = [];
  for (const item of decision.dispatch) {
    handle?.step(`dispatching ${item.item}`);
    try {
      dispatched.push(
        await dispatchLoom(deps, projectId, {
          item: item.item,
          title: item.title,
          brief: item.brief,
          branchSlug: item.branchSlug,
        }),
      );
    } catch (error) {
      // One item that cannot be dispatched must not cost the other three.
      appendLedger(deps.paths, projectId, {
        at,
        kind: "error",
        item: item.item,
        summary: `could not dispatch ${item.item}`,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { decision, dispatched };
}

function persistTriage(
  deps: LoomTickDeps,
  projectId: string,
  decision: TickDecision,
  listed: Array<{ item: string; updatedAt: string }>,
  at: number,
): void {
  const cache: Record<string, TriageEntry> = { ...readTriage(deps.paths, projectId) };
  for (const entry of decision.triage) {
    cache[entry.item] = {
      item: entry.item,
      // KEYED BY THE `updatedAt` THE LIST REPORTED, which is what makes the
      // cache invalidate on its own. An item we could not find in the list gets
      // an empty string, so it re-reads next tick rather than sticking forever.
      updatedAt: listed.find((row) => row.item === entry.item)?.updatedAt ?? "",
      classification: entry.classification,
      reason: entry.reason,
      ask: entry.ask,
      at,
    };
  }
  // PRUNE ONLY WHEN THE LIST WAS READABLE AND STRUCTURED. `list` is free text by
  // contract, so an empty `listed` usually means "we could not extract items",
  // not "the backlog is empty" — and pruning on that would throw away every
  // classification the system has ever made.
  writeTriage(deps.paths, projectId, listed.length > 0 ? pruneCache(cache, listed) : cache);
}

function applyPark(deps: LoomTickDeps, projectId: string, loomId: string, reason: string, at: number): void {
  const loom = getLoom(deps.paths, loomId);
  if (!loom || isTerminal(loom)) return;
  writeLoom(deps.paths, transitionLoom(loom, "parked", { parkedReason: reason, updatedAt: at }));
  appendLedger(deps.paths, projectId, { at, kind: "park", loomId, item: loom.item, summary: reason });
}

function applyAsk(
  deps: LoomTickDeps,
  projectId: string,
  ask: { loomId?: string; item?: string; question: string; why: string },
  at: number,
): void {
  appendLedger(deps.paths, projectId, {
    at,
    kind: "ask",
    ...(ask.loomId ? { loomId: ask.loomId } : {}),
    ...(ask.item ? { item: ask.item } : {}),
    summary: ask.question,
    detail: ask.why,
  });
  if (!ask.loomId) return;
  const loom = getLoom(deps.paths, ask.loomId);
  if (!loom || isTerminal(loom) || loom.state === "asking") return;
  writeLoom(deps.paths, transitionLoom(loom, "asking", { question: ask.question, updatedAt: at }));
}

// ── reconciliation ──────────────────────────────────────────────────────────

/**
 * Walk every non-terminal loom forward. See the header for why this is what
 * makes a stateless orchestrator possible at all.
 */
export async function advanceLooms(deps: LoomTickDeps, projectId: string): Promise<Loom[]> {
  const program = deps.readProgram(projectId);
  const root = deps.projectRoot(projectId);
  if (!program || !root) return [];

  const { looms } = listLooms(deps.paths, projectId);
  const advanced: Loom[] = [];

  for (const start of looms) {
    if (isTerminal(start)) continue;
    let loom = start;
    for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
      let next: Loom;
      try {
        next = await advanceOne(deps, loom, program, root);
      } catch (error) {
        // A loom that cannot be advanced becomes a loom that says why, not an
        // exception that unwinds the whole pass and strands its five siblings.
        next = stick(deps, loom, error instanceof Error ? error.message : String(error));
      }
      const settled = next.state === loom.state;
      loom = next;
      // `working` waits on a session, `asking` waits on a human, terminal waits
      // on nothing. None of them can be advanced by trying again right now.
      //
      // `stuck` STOPS THE PASS TOO, and that one is a judgement rather than a
      // necessity: the ladder could be walked immediately. It is not, because a
      // rung enacted in the same breath as the failure it answers is a retry
      // nobody saw — the deck would never render the state, and rung 2 ("run
      // the gate again — it may be flaky") would re-run a suite against a tree
      // that has not had a second to change. One rung per pass also paces the
      // ladder against the supervisor's own cadence, which is the pacing the
      // human configured.
      if (settled || loom.state === "working" || loom.state === "asking" || loom.state === "stuck" || isTerminal(loom)) break;
    }
    advanced.push(loom);
  }

  return advanced;
}

async function advanceOne(deps: LoomTickDeps, loom: Loom, program: LoomProgram, root: string): Promise<Loom> {
  const at = deps.now().getTime();

  switch (loom.state) {
    case "queued":
      return provisionLoom(deps, loom, program, root, {});

    case "working": {
      if (!loom.sessionId) {
        return stick(deps, loom, "this loom is `working` but records no session, so nothing is actually running for it.");
      }
      const status = await deps.session.status(loom.sessionId);
      if (status === "running") return loom;

      // §4's done-detection, and the whole reason `sessionId` is recorded.
      const commits = countCommits(deps, loom, program);
      if (commits === 0) {
        return stick(
          deps,
          loom,
          `the worker's session ${status === "gone" ? "disappeared" : "ended"} without committing anything to the worktree. There is nothing to gate.`,
        );
      }
      appendLedger(deps.paths, loom.projectId, {
        at,
        kind: "gate",
        loomId: loom.id,
        item: loom.item,
        summary: `the worker finished with ${commits} commit(s); gating`,
      });
      return writeLoom(deps.paths, transitionLoom(loom, "gating", { updatedAt: at }));
    }

    case "gating": {
      const verdict = await gateLoom(deps, loom, program);
      const gate = verdict.results.at(-1);
      if (verdict.verdict === "park") {
        appendLedger(deps.paths, loom.projectId, {
          at,
          kind: "park",
          loomId: loom.id,
          item: loom.item,
          summary: verdict.reason,
        });
        return writeLoom(deps.paths, transitionLoom(loom, "parked", { parkedReason: verdict.reason, updatedAt: at }));
      }
      if (verdict.verdict === "stuck") {
        appendLedger(deps.paths, loom.projectId, {
          at,
          kind: "gate",
          loomId: loom.id,
          item: loom.item,
          summary: verdict.reason,
        });
        return writeLoom(
          deps.paths,
          transitionLoom(loom, "stuck", {
            parkedReason: verdict.reason,
            updatedAt: at,
            ...(gate ? { gate } : {}),
          }),
        );
      }
      appendLedger(deps.paths, loom.projectId, {
        at,
        kind: "gate",
        loomId: loom.id,
        item: loom.item,
        summary: gate ? `gate ${gate.outcome} (exit ${gate.exitCode ?? "killed"})` : "no gate declared; nothing was verified",
      });
      return writeLoom(
        deps.paths,
        transitionLoom(loom, "publishing", { updatedAt: at, ...(gate ? { gate } : {}) }),
      );
    }

    case "publishing":
      return publishLoom(deps, loom, program);

    case "stuck": {
      // §5, the centrepiece. The engine does NOT interpret rung text — it hands
      // the human's own words to an agent working in the loom's own worktree and
      // lets it enact them. Which is why rung 2 ("run the gate again — it may be
      // flaky") and rung 3 ("narrow the scope") need no special case here.
      const step = nextRung(loom, program);
      if ("exhausted" in step) {
        const question = `${loom.parkedReason ?? "this loom is stuck"}\n\nEvery enabled rung of the ladder has been tried. What should happen to ${loom.item}?`;
        appendLedger(deps.paths, loom.projectId, {
          at,
          kind: "escalate",
          loomId: loom.id,
          item: loom.item,
          summary: "the ladder is exhausted; asking",
          detail: question,
        });
        return writeLoom(deps.paths, transitionLoom(loom, "asking", { question, updatedAt: at }));
      }
      appendLedger(deps.paths, loom.projectId, {
        at,
        kind: "escalate",
        loomId: loom.id,
        item: loom.item,
        summary: `rung ${step.rung.n}: ${step.rung.label}`,
        ...(loom.parkedReason ? { detail: loom.parkedReason } : {}),
      });
      return provisionLoom(deps, step.loom, program, root, {
        rung: step.rung,
        ...(loom.parkedReason ? { reason: loom.parkedReason } : {}),
      });
    }

    // `asking` waits on a human. Nothing here can move it; `answerLoom` does.
    default:
      return loom;
  }
}

/** Stuck, with the reason on the record, once. */
function stick(deps: LoomTickDeps, loom: Loom, reason: string): Loom {
  const at = deps.now().getTime();
  if (loom.state === "stuck") return loom;
  appendLedger(deps.paths, loom.projectId, {
    at,
    kind: "error",
    loomId: loom.id,
    item: loom.item,
    summary: reason,
  });
  return writeLoom(deps.paths, transitionLoom(loom, "stuck", { parkedReason: reason, updatedAt: at }));
}

function countCommits(deps: LoomTickDeps, loom: Loom, program: LoomProgram): number {
  if (!loom.worktreePath) return 0;
  const counted = deps.git(loom.worktreePath, ["rev-list", "--count", `${program.work.base}..HEAD`]);
  if (counted.status !== 0) return 0;
  const value = Number.parseInt(counted.stdout.trim(), 10);
  return Number.isFinite(value) ? value : 0;
}

// ── dispatch ────────────────────────────────────────────────────────────────

export type DispatchInput = { item: string; title?: string; brief?: string; branchSlug?: string };

export async function dispatchLoom(deps: LoomTickDeps, projectId: string, input: DispatchInput): Promise<Loom> {
  const program = deps.readProgram(projectId);
  if (!program) throw new Error(`project ${projectId} has no Loom Program, so nothing can be dispatched. Create \`.telar/loom.md\` in the project repo.`);
  const root = deps.projectRoot(projectId);
  if (!root) throw new Error(`project ${projectId} has no checkout on this machine, so there is nowhere to cut a worktree.`);
  if (input.item.trim() === "") throw new Error("a dispatch needs an item; the Program's `list` command is what names them.");

  const { looms } = listLooms(deps.paths, projectId);

  // §8.1 and §8.2, enforced HERE as well as in `validateDecision`, because this
  // is also the entry point a human clicking "dispatch" in the deck comes
  // through — and that path never sees a TickDecision.
  const existing = looms.find((loom) => loom.item === input.item && isActive(loom));
  if (existing) {
    throw new Error(
      `item ${input.item} already has loom ${existing.id}, currently ${existing.state}. Cancel that one before dispatching the item again — two looms on one item produce two branches nobody can attribute.`,
    );
  }
  const active = looms.filter((loom) => isActive(loom)).length;
  if (active >= program.work.concurrency) {
    throw new Error(
      `${projectId} already has ${active} loom(s) in flight and the Program's concurrency is ${program.work.concurrency}. Raise \`concurrency\` in \`.telar/loom.md\` if the machine can take it — the ceiling is usually RAM, not policy.`,
    );
  }

  const at = deps.now().getTime();
  const title = (input.title ?? "").trim() || `item ${input.item}`;
  const queued: Loom = {
    id: `loom-${crypto.randomUUID().slice(0, 12)}`,
    projectId,
    item: input.item,
    title,
    state: "queued",
    attempts: 0,
    ladderRung: 0,
    createdAt: at,
    updatedAt: at,
  };
  writeLoom(deps.paths, queued);
  appendLedger(deps.paths, projectId, {
    at,
    kind: "dispatch",
    loomId: queued.id,
    item: input.item,
    summary: `queued ${input.item} — ${title}`,
    ...(input.brief ? { detail: input.brief } : {}),
  });

  return provisionLoom(deps, queued, program, root, {
    ...(input.brief ? { brief: input.brief } : {}),
    ...(input.branchSlug ? { slug: input.branchSlug } : {}),
  });
}

type ProvisionOptions = {
  brief?: string;
  slug?: string;
  rung?: { n: number; label: string };
  reason?: string;
  answer?: string;
};

/**
 * Worktree, setup, brief, session. The one path from "we decided to" to "it is
 * running", used by a first dispatch, by a ladder rung and by a human's answer
 * alike — so all three get the same boundaries and the same prohibitions.
 */
async function provisionLoom(
  deps: LoomTickDeps,
  loom: Loom,
  program: LoomProgram,
  root: string,
  opts: ProvisionOptions,
): Promise<Loom> {
  const at = deps.now().getTime();
  try {
    let worktree = loom.worktreePath;
    let branch = loom.branch;
    /**
     * WHAT THE WORKTREE WAS CUT FROM, carried to the session so it is recorded
     * once rather than re-derived later against a base that has since moved.
     * Only known here on the pass that cuts it; a re-provisioned loom asks the
     * worktree itself below.
     */
    let baseRef: string | undefined;

    if (!worktree || !branch) {
      const slug = slugify(opts.slug ?? loom.title, loom.item);
      branch = `${program.work.branchPrefix}${slug}`;
      const created = createSessionWorktree(deps.git, {
        engineRoot: deps.engineRoot,
        projectRoot: root,
        sessionId: loom.id,
        baseRef: program.work.base,
      });
      worktree = created.path;
      baseRef = created.baseRef;

      // `createSessionWorktree` names the branch `telar/<sessionId>` — correct
      // for a detached session, wrong here, because the Program declares the
      // branch prefix a human will see on the PR. `-B` moves the worktree onto
      // the declared name; the engine-owned `telar/` branch it came in on is
      // then dead weight pointing at base, so it is removed rather than left to
      // accumulate one stale ref per loom forever.
      if (created.branch !== branch) {
        const moved = deps.git(worktree, ["checkout", "-B", branch]);
        if (moved.status !== 0) {
          throw new Error(`could not put the worktree on ${branch}: ${moved.stderr.trim() || moved.stdout.trim()}`);
        }
        deps.git(root, ["branch", "-D", created.branch]);
      }

      if (program.work.setup) {
        const setup = await deps.exec({
          ...withSlots({
            command: program.work.setup,
            cwd: worktree,
            vars: { ITEM: loom.item, BRANCH: branch, TITLE: loom.title, BASE: program.work.base },
          }),
          ...(deps.signal ? { signal: deps.signal } : {}),
        });
        if (setup.code !== 0) {
          throw new Error(
            `the Program's setup command (\`${program.work.setup}\`) exited ${setup.code} in the fresh worktree: ${(setup.stderr.trim() || setup.stdout.trim() || "no output").split("\n").slice(0, 6).join(" ")}`,
          );
        }
      }
    }

    const detail = program.commands.detail
      ? await deps.exec(
          withSlots({
            command: program.commands.detail,
            cwd: root,
            ...(deps.signal ? { signal: deps.signal } : {}),
            vars: { ITEM: loom.item },
          }),
        )
      : null;

    const prompt = workerPrompt({
      program,
      loom: { ...loom, branch, worktreePath: worktree },
      base: program.work.base,
      branch,
      worktree,
      detail: detail?.code === 0 ? detail.stdout : (detail?.stderr ?? ""),
      ...(opts.brief ? { brief: opts.brief } : {}),
      ...(opts.rung ? { rung: opts.rung } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.answer ? { answer: opts.answer } : {}),
    });

    if (baseRef === undefined) {
      // A LOOM BEING RE-PROVISIONED adopts the checkout it already had, and the
      // only base worth recording is the one the gate measures against. Absent
      // if it no longer resolves, which is a stale base rather than a failure —
      // `SessionWorkspace.baseRef` is optional for exactly this.
      const resolved = deps.git(worktree, ["rev-parse", "--verify", "--quiet", `${program.work.base}^{commit}`]);
      if (resolved.status === 0 && resolved.stdout.trim()) baseRef = resolved.stdout.trim();
    }

    /**
     * THE SESSION ADOPTS THIS CHECKOUT; it does not cut another.
     *
     * The branch travels with the path because the two must not diverge: this
     * is the branch `setup` ran on, the branch the gate counts commits on, and
     * the branch `publish` pushes. A session that recorded a different one
     * would send the night's work nowhere without failing.
     */
    const { sessionId } = await deps.session.start({
      projectId: loom.projectId,
      worktree,
      branch,
      ...(baseRef ? { baseRef } : {}),
      prompt,
      title: `${loom.item} — ${loom.title}`,
    });

    const working = transitionLoom(loom, "working", {
      sessionId,
      worktreePath: worktree,
      branch,
      // `attempts` IS NOT TOUCHED HERE, and that is the whole meaning of the
      // field: it counts LADDER RUNGS CONSUMED, not sessions started. `nextRung`
      // owns it and refuses past `attempts >= enabled rungs`, so counting the
      // first dispatch would silently eat rung 1 — a two-rung ladder would only
      // ever try one, and §5's "rungs are tried in order, each once" would be
      // false for the last one on every project.
      dispatchedAt: at,
      updatedAt: at,
      // The reason belonged to the attempt that just ended. Leaving it on a
      // running loom makes the deck show a live worker beside the sentence
      // explaining why it stopped.
      parkedReason: undefined,
      question: undefined,
    });
    appendLedger(deps.paths, loom.projectId, {
      at,
      kind: "dispatch",
      loomId: loom.id,
      item: loom.item,
      summary: `dispatched to session ${sessionId} on ${branch}`,
    });
    return writeLoom(deps.paths, working);
  } catch (error) {
    return stick(deps, loom, error instanceof Error ? error.message : String(error));
  }
}

export async function cancelLoom(deps: LoomTickDeps, loomId: string): Promise<Loom> {
  const loom = getLoom(deps.paths, loomId);
  if (!loom) throw new Error(`there is no loom ${loomId} on this machine.`);
  // IDEMPOTENT. Cancelling a published loom is a double-click, not an error, and
  // `transitionLoom` would throw on the terminal edge.
  if (isTerminal(loom)) return loom;

  if (loom.sessionId) {
    // Best effort: a session that is already gone is exactly what we wanted.
    await deps.session.stop(loom.sessionId).catch(() => undefined);
  }
  const at = deps.now().getTime();
  appendLedger(deps.paths, loom.projectId, {
    at,
    kind: "cancel",
    loomId: loom.id,
    item: loom.item,
    summary: "cancelled by a human",
  });
  // THE WORKTREE AND BRANCH SURVIVE, on purpose, and `worktree.ts` already
  // argues why: the branch is the session's entire output, and destroying
  // commits is a separate human decision from stopping a run.
  return writeLoom(deps.paths, transitionLoom(loom, "cancelled", { updatedAt: at }));
}

export async function answerLoom(deps: LoomTickDeps, loomId: string, answer: string): Promise<Loom> {
  const loom = getLoom(deps.paths, loomId);
  if (!loom) throw new Error(`there is no loom ${loomId} on this machine.`);
  if (loom.state !== "asking") {
    throw new Error(
      `loom ${loomId} is ${loom.state}, not waiting on you — an answer would go nowhere. Only a loom in "asking" has a question open.`,
    );
  }
  if (answer.trim() === "") throw new Error("an answer needs some words; an empty one would restart the worker knowing exactly what it knew before.");

  const program = deps.readProgram(loom.projectId);
  const root = deps.projectRoot(loom.projectId);
  if (!program || !root) throw new Error(`project ${loom.projectId} has no Program or no checkout on this machine, so the answer cannot be acted on.`);

  const at = deps.now().getTime();
  appendLedger(deps.paths, loom.projectId, {
    at,
    kind: "ask",
    loomId: loom.id,
    item: loom.item,
    summary: "answered by a human",
    detail: answer,
  });

  return provisionLoom(deps, loom, program, root, { answer, ...(loom.parkedReason ? { reason: loom.parkedReason } : {}) });
}

// ── reading a free-text `list` ──────────────────────────────────────────────

/**
 * Pull `{item, updatedAt}` pairs out of whatever `list` printed.
 *
 * `list` is FREE TEXT BY CONTRACT (§1) and its output goes to the agent
 * verbatim regardless. This function exists only to feed the triage cache's
 * invalidation, which needs a per-item version string. Two shapes are
 * understood, in this order:
 *
 *   1. A JSON array of objects — what every `gh ... --json` invocation prints,
 *      which is the overwhelmingly common case.
 *   2. Lines of `<item>\t<version>`, for a project rolling its own.
 *
 * ANYTHING ELSE YIELDS NOTHING, and that is a deliberate degradation rather than
 * a guess: with no items extracted, no `detail` is pre-fetched and no cache is
 * pruned, so the tick costs less and the agent still sees the whole list. A
 * heuristic that invented item ids out of prose would produce a triage cache
 * keyed on garbage, which is worse than an empty one.
 */
export function parseListed(stdout: string): Array<{ item: string; updatedAt: string }> {
  const text = stdout.trim();
  if (text === "") return [];

  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        const rows: Array<{ item: string; updatedAt: string }> = [];
        for (const row of parsed) {
          if (!row || typeof row !== "object") continue;
          const record = row as Record<string, unknown>;
          const item = record.item ?? record.number ?? record.id ?? record.key ?? record.name;
          if (item === undefined || item === null) continue;
          const version = record.updatedAt ?? record.updated_at ?? record.version ?? record.sha ?? "";
          rows.push({ item: String(item), updatedAt: String(version) });
        }
        return rows;
      }
    } catch {
      // Not JSON after all. Fall through to the line form.
    }
  }

  const rows: Array<{ item: string; updatedAt: string }> = [];
  for (const line of text.split("\n")) {
    const [item, version] = line.split("\t");
    if (!item || item.trim() === "" || version === undefined) continue;
    rows.push({ item: item.trim(), updatedAt: version.trim() });
  }
  return rows;
}

// ── the conversational orchestrator session ─────────────────────────────────

/**
 * The session the human talks to, created once per project and remembered.
 *
 * THE SECOND AGENT SURFACE, and keeping it apart from the tick is the design.
 * The tick is headless, structured, fresh every time, and holds no transcript —
 * that is why its cost does not grow with uptime (§3.2). This one is an ordinary
 * Telar session with an ordinary transcript, because §4.3's correction loop
 * *needs* continuity: "no, `listo` means triaged" only makes sense as a reply.
 *
 * A DEAD RECORDED SESSION IS REPLACED, NOT RETURNED. The id survives a daemon
 * restart on the watch record, but the session behind it may not have — and
 * handing a surface an id that renders an empty cockpit is worse than making a
 * new one, because nothing on screen says which of the two happened.
 */
export async function ensureLoomSession(
  deps: LoomTickDeps,
  projectId: string,
): Promise<{ sessionId: string; created: boolean }> {
  const root = deps.projectRoot(projectId);
  if (!root) {
    throw new Error(
      `project ${projectId} has no checkout on this machine, so there is nowhere to hold a conversation about it.`,
    );
  }

  const record = readWatchRecord(deps.paths, projectId);
  const existing = record.orchestratorSessionId;
  if (existing) {
    const status = await deps.session.status(existing).catch(() => "gone" as const);
    if (status === "running" || status === "done") return { sessionId: existing, created: false };
  }

  const markdown = deps.readProgramMarkdown?.(projectId) ?? null;
  const { sessionId } = await deps.session.create({
    projectId,
    cwd: root,
    title: `Loom — ${projectId}`,
    // SEEDED ONLY ON CREATION. Re-seeding an existing session would put the
    // setup brief in the middle of a conversation that has moved past it.
    prompt: setupPrompt({
      projectId,
      projectRoot: root,
      now: deps.now(),
      ...(markdown ? { existingMarkdown: markdown } : {}),
    }),
  });

  writeWatchRecord(deps.paths, projectId, { ...record, orchestratorSessionId: sessionId });
  appendLedger(deps.paths, projectId, {
    at: deps.now().getTime(),
    kind: "tick",
    summary: `opened the orchestrator session ${sessionId}`,
  });
  return { sessionId, created: true };
}

// ── the composer ────────────────────────────────────────────────────────────

export type LoomRuntimeDeps = Omit<LoomTickDeps, "runs"> & {
  runs?: LoomRunRegistry;
  supervisor?: LoomSupervisor;
  interval?: (fn: () => void, ms: number) => { clear(): void };
  pollMs?: number;
  /** Setup's Program draft. Owned elsewhere; absent means the verb says so. */
  suggest?: (projectId: string) => { markdown: string; findings: string[] };
};

/**
 * The `LoomRuntime` verbs, composed out of the plain functions above.
 *
 * CONSTRUCTION IS INERT. It allocates a run registry and a supervisor and
 * touches nothing else: no network, no probe, no timer. A first-run daemon with
 * no project configured and no Program on disk must still start, and a
 * supervisor armed at boot would be running somebody's `gh` quota with nobody
 * watching. The interval is armed by `startLoomWatch` and cleared by `close()`.
 *
 * `tickLoom` AND `dryRunLoom` RETURN IMMEDIATELY and work on a detached promise,
 * because §15.2 makes them 202s — a route that awaited a tick would hold an HTTP
 * connection open for an agent call plus a fifteen-minute gate suite.
 *
 * EVERY DETACHED PROMISE ENDS IN `.catch(() => undefined)`. Not defensive
 * style: an unhandled rejection on a background promise takes the whole daemon
 * down in Bun, which `state.ts:2112-2126` learned the hard way.
 */
export function createLoomRuntime(deps: LoomRuntimeDeps): LoomRuntime & { close(): void; resume(): void } {
  const runs = deps.runs ?? createLoomRuns(deps.now);
  const tickDeps: LoomTickDeps = { ...deps, runs };

  const supervisor =
    deps.supervisor ??
    createLoomSupervisor({
      paths: deps.paths,
      exec: deps.exec,
      now: deps.now,
      projectRoot: deps.projectRoot,
      readProgram: deps.readProgram,
      onWake: (projectId, reason) => {
        appendLedgerQuietly(tickDeps, projectId, reason);
        detach(projectId, "tick");
      },
      onAdvance: (projectId) => {
        // NO AGENT. §6's first branch: a loom in flight is walked forward by
        // machinery — a session status check and a few git commands — and
        // waking a model to discover that is the cost trap in a new costume.
        void advanceLooms(tickDeps, projectId).catch(() => undefined);
      },
      ...(deps.interval ? { interval: deps.interval } : {}),
      ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
    });

  function detach(projectId: string, kind: "tick" | "dry-run"): { run: LoomRun } {
    const already = runs.runningFor(projectId);
    // One tick per project. A human hammering "tick now" gets one tick, and the
    // second click is told about the first rather than paying for a duplicate.
    if (already) return { run: already };

    const handle = runs.begin({ projectId, kind });
    void runLoomTick(tickDeps, projectId, { handle, dryRun: kind === "dry-run" })
      .then((result) => {
        handle.settle({
          state: "done",
          decision: result.decision,
          note: result.report ?? result.decision.note,
          dispatched: result.dispatched.map((loom) => loom.id),
        });
      })
      .catch((error: unknown) => {
        handle.settle({ state: "failed", error: error instanceof Error ? error.message : String(error) });
      })
      .catch(() => undefined);

    const run = runs.find(handle.id);
    if (!run) throw new Error("the run registry lost the run it had just created");
    return { run };
  }

  return {
    loomWork: () => ({ runs: runs.list() }),
    startLoomWatch: (projectId) => ({ watch: supervisor.setWatch(projectId, true) }),
    stopLoomWatch: (projectId) => ({ watch: supervisor.setWatch(projectId, false) }),
    tickLoom: (projectId) => detach(projectId, "tick"),
    dryRunLoom: (projectId) => detach(projectId, "dry-run"),
    dispatchLoom: async (projectId, input) => ({ loom: await dispatchLoom(tickDeps, projectId, input) }),
    cancelLoom: async (loomId) => ({ loom: await cancelLoom(tickDeps, loomId) }),
    answerLoom: async (loomId, answer) => ({ loom: await answerLoom(tickDeps, loomId, answer) }),
    ensureLoomSession: (projectId) => ensureLoomSession(tickDeps, projectId),
    suggestLoomProgram: (projectId) => {
      const suggested = deps.suggest?.(projectId);
      if (!suggested) {
        throw new Error(
          "drafting a Program is part of setup, which is a conversation rather than a call. Open the project's orchestrator session and ask it there, or write `.telar/loom.md` by hand.",
        );
      }
      return suggested;
    },
    /**
     * PICK BACK UP THE WATCHES A HUMAN ALREADY TURNED ON.
     *
     * The daemon calls this once at startup, after recovery and after discovery
     * is published. Without it the seam tells a lie rather than merely being
     * quiet: `running` is persisted on the watch record, so `loomOverview`
     * reports `watch.running: true` and the deck draws "watching" — while no
     * probe ever fires again until a human toggles the switch off and on. An
     * overnight run that stops at the first daemon restart and still claims to
     * be running is worse than one that admits it stopped. Measured, not
     * assumed: a second daemon over the same engine root probed zero times.
     *
     * SEPARATE FROM CONSTRUCTION, because a first-run daemon has no project and
     * no Program and must not start running somebody's `gh` quota. The guard
     * inside `resume` is exactly that distinction — it arms only when a watch
     * record on disk already says `running`, which a fresh engine has none of.
     *
     * NOT `setWatch(id, true)`, which is the workaround that looks equivalent
     * and is not: it resets `quietChecks` and `nextProbeAt`, throwing away the
     * backoff a quiet night earned. Resuming must not make a restart look like
     * a human pressing the button.
     */
    resume: () => {
      try {
        supervisor.resume();
      } catch {
        // An unreadable store is not a reason to fail startup. Nothing resumes,
        // which is the same position a daemon without this call was already in.
      }
    },
    /**
     * IDEMPOTENT AND NEVER THROWS. It runs on the shutdown path, where the only
     * thing worse than a leaked timer is an exception that skips every teardown
     * queued behind it.
     */
    close: () => {
      try {
        supervisor.close();
      } catch {
        // Already closed, or a fake interval that objects to being cleared twice.
      }
    },
  };
}

/** A wake's reason belongs in the ledger, and a ledger write must never be the
 *  thing that stops a tick from happening. */
function appendLedgerQuietly(deps: LoomTickDeps, projectId: string, reason: string): void {
  try {
    appendLedger(deps.paths, projectId, { at: deps.now().getTime(), kind: "tick", summary: `woken: ${reason}` });
  } catch {
    // The store is unreadable or the id is malformed. The tick is more important
    // than its own audit line.
  }
}
