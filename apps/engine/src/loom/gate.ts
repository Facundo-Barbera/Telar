/**
 * THE HARNESS — everything that happens to a branch after the worker lets go.
 *
 * §3.4's split, made concrete: the agent decides what to work on, the machinery
 * decides whether it ships. The worker never held the gate, so it cannot have
 * skipped it, and this file is where that promise is actually kept.
 *
 * ── THE ORDER IS THE DESIGN, NOT AN IMPLEMENTATION DETAIL ───────────────────
 *
 *   1. REBASE ONTO A FRESHLY FETCHED BASE (§8, decided). Not at dispatch —
 *      here. Six worktrees cut on Monday and gated on Tuesday must each be
 *      measured against Tuesday's base, or the gate result describes a world the
 *      PR will not land in. A conflict is not a failure to retry: a conflicting
 *      branch genuinely needs a decision, so the loom goes `stuck` at rung 1
 *      with the conflict text as its reason.
 *
 *   2. BOUNDARIES, BEFORE THE GATE (§10). A diff touching a `neverTouch` glob
 *      PARKS the loom. Not "fails it", not "warns" — parks, terminally, because
 *      the alternative failure mode is silent and compounding: a `.env` quietly
 *      rewritten at 3am is discovered by an outage, not by a review. It is
 *      checked before the gate because a gate that passes on a forbidden diff
 *      would produce a green chip beside work that must never publish.
 *
 *   3. THE GATES, TRI-STATE (§3). Exit codes mean whatever the Program says
 *      they mean and nothing else. An undeclared code is `unknown`, never
 *      `fail` — assuming POSIX convention is precisely the imposition this
 *      design exists to avoid.
 *
 *   4. `shouldPublish(outcome, onUnknown)`. `unknown` is a policy question the
 *      Program answers; it is never inferred here.
 *
 * ── WHICH GIT RUNS WHERE, AND WHY THE LINE IS NOT ARBITRARY ─────────────────
 * `deps.git` is `execFileSync`: it blocks the daemon's event loop for as long as
 * git takes, and while it blocks, every cockpit request waits. The line drawn
 * here is COST, not tidiness — anything whose duration is set by the network or
 * by the size of the repository goes through the async `deps.exec` (`fetch`,
 * `rebase`, `rebase --abort`, `diff --name-only`); a constant-time local ref
 * read stays synchronous, because spawning a shell to avoid a sub-millisecond
 * `rev-parse` costs more wall clock than the block it saves.
 *
 * The one thing that arrives with the shell is a TIMEOUT, and a timeout is
 * `unknown` — never `fail`. A rebase that was killed at the deadline has not
 * conflicted, and saying it did would send a human to resolve a conflict that
 * does not exist. Every message below distinguishes the two.
 *
 * ── WHAT THIS FILE WILL NOT DO, EVER ────────────────────────────────────────
 * It never merges. It never pushes to base. It never force-pushes. The terminal
 * happy state is an open pull request that a human merges in the morning (§3.5),
 * and every git verb below is either read-only or scoped to the loom's own
 * branch inside the loom's own worktree.
 */
import type { GateOutcome, Loom, LoomGate, LoomGateResult, LoomProgram } from "@telar/engine-client";
import type { GitRunner } from "../worktree";
import { classifyExit, decideAfterGates, shouldPublish, suiteUnknownPolicy } from "./gates";
import { transitionLoom } from "./machine";
import { appendLedger, writeLoom, type LoomPaths } from "./store";
import { DEFAULT_TIMEOUT_MS, execGit, GATE_TIMEOUT_MS, withSlots, type LoomExec } from "./exec";

const GATE_TIMEOUT_LABEL = `${Math.round(GATE_TIMEOUT_MS / 60_000)} minutes`;
const FETCH_TIMEOUT_LABEL = `${Math.round(DEFAULT_TIMEOUT_MS / 1_000)}s`;

export type LoomGateDeps = {
  paths: LoomPaths;
  exec: LoomExec;
  git: GitRunner;
  now: () => Date;
  projectRoot: (projectId: string) => string | null;
  /** Cancels the gates when the run that owns them is cancelled. */
  signal?: AbortSignal;
};

class LoomGateError extends Error {}

function requireWorktree(loom: Loom): { worktree: string; branch: string } {
  if (!loom.worktreePath || !loom.branch) {
    throw new LoomGateError(
      `loom ${loom.id} has no worktree or branch recorded, so there is nothing to gate. It was probably reaped; cancel it and dispatch the item again.`,
    );
  }
  return { worktree: loom.worktreePath, branch: loom.branch };
}

function requireRoot(deps: LoomGateDeps, loom: Loom): string {
  const root = deps.projectRoot(loom.projectId);
  if (!root) {
    throw new LoomGateError(`project ${loom.projectId} has no root on this machine, so loom ${loom.id} cannot be gated.`);
  }
  return root;
}

/**
 * The ref the branch is measured against.
 *
 * `origin/<base>` WHEN IT EXISTS, `<base>` otherwise. A project with no remote
 * is a first-class case (§3.8) and must not be broken by a fetch that could
 * never have worked.
 *
 * SYNCHRONOUS ON PURPOSE, and the only git left in this file that is. It reads
 * one ref out of `packed-refs` or a loose file: bounded by neither the network
 * nor the repository, and quicker than the `fork` it would take to run it
 * through a shell instead. See the header.
 */
export function baseRefFor(deps: LoomGateDeps, cwd: string, base: string): string {
  const remote = deps.git(cwd, ["rev-parse", "--verify", "--quiet", `origin/${base}`]);
  return remote.status === 0 && remote.stdout.trim() !== "" ? `origin/${base}` : base;
}

export async function rebaseOnBase(
  deps: LoomGateDeps,
  loom: Loom,
  program: LoomProgram,
): Promise<{ ok: boolean; reason?: string; baseNote?: string }> {
  const { worktree } = requireWorktree(loom);
  const root = requireRoot(deps, loom);
  const base = program.work.base;

  // BEST EFFORT, AND DELIBERATELY UNCHECKED. No remote, no network, a private
  // repo whose credentials expired — none of those are a reason to refuse to
  // gate. They only mean the base is as fresh as the last fetch, which is what
  // the local ref already says.
  //
  // BOUNDED BY THE ORDINARY BUDGET RATHER THAN THE GATE'S. A gate may legitimately
  // take fifteen minutes because it is a test suite; a fetch that has not answered
  // in two is a network that is down, and waiting seven times longer for it buys
  // nothing a human would want. Timing out here is not a failure — it degrades
  // exactly the way an unreachable remote already does — but it IS carried out
  // as `baseNote`, because "the base is stale" is the thing that explains an
  // otherwise inexplicable result.
  const fetched = await execGit(deps.exec, root, ["fetch", "origin", base], { timeoutMs: DEFAULT_TIMEOUT_MS });

  const ref = baseRefFor(deps, worktree, base);
  const staleBase = fetched.timedOut
    ? `The \`fetch\` of \`origin/${base}\` was still running after ${FETCH_TIMEOUT_LABEL} and was killed, so ${ref} is only as fresh as the last fetch that finished — nothing here says the remote is broken, only that it did not answer in time.`
    : undefined;
  const carry = staleBase ? { baseNote: staleBase } : {};

  const rebased = await execGit(deps.exec, worktree, ["rebase", ref], { timeoutMs: GATE_TIMEOUT_MS });
  if (rebased.status === 0) return { ok: true, ...carry };

  const output = [rebased.stdout, rebased.stderr]
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .join("\n")
    .trim();

  // LEAVE THE WORKTREE CLEAN. A worktree abandoned mid-rebase is unusable by
  // every later attempt AND by the human who opens it to look, and the rebase
  // state is not information anyone needs — the conflict text below is.
  //
  // This one runs even when the rebase above was killed at the deadline, and
  // especially then: a SIGKILLed rebase is the case that leaves `.git/rebase-merge`
  // behind, so skipping the cleanup on a timeout would strand the worktree in
  // precisely the state this line exists to prevent.
  await execGit(deps.exec, worktree, ["rebase", "--abort"], { timeoutMs: GATE_TIMEOUT_MS });

  // A KILLED REBASE HAS NOT CONFLICTED. Its exit code is an artefact of the kill
  // and its output is however far it got, so reporting either as a conflict
  // would invent a merge conflict for a human to go and resolve. The rung this
  // parks at is the same; what it says there is not.
  if (rebased.timedOut) {
    return {
      ok: false,
      ...carry,
      reason: `rebasing onto ${ref} was still running after ${GATE_TIMEOUT_LABEL} and was killed, so whether this branch conflicts is unknown — this is not a conflict and not a gate failure. The worktree was left clean; a slow or very large rebase is the usual cause.`,
    };
  }

  return {
    ok: false,
    ...carry,
    reason:
      output === ""
        ? `rebasing ${loom.branch ?? "the branch"} onto ${ref} failed with no output`
        : `rebasing onto ${ref} conflicts:\n${output}`,
  };
}

/**
 * Glob matching, small on purpose.
 *
 * The Program's `Never touch` block is authored by a human writing `.env*` and
 * `supabase/.env.keys`, not by someone reaching for `globstar`. Pulling a
 * matcher dependency into the engine to serve that would be the abstraction §1
 * refuses, and this is fifteen lines.
 *
 * A PATTERN WITH NO SLASH ALSO MATCHES THE BASENAME, which is the one rule that
 * is not obvious and is the one people mean: `.env*` written by a human means
 * "any .env anywhere", not "an .env in the repository root". Getting that wrong
 * fails open, which for this check is the unacceptable direction.
 */
export function globMatch(pattern: string, filePath: string): boolean {
  const toRegExp = (glob: string): RegExp => {
    let out = "";
    for (let i = 0; i < glob.length; i += 1) {
      const char = glob[i] as string;
      if (char === "*") {
        if (glob[i + 1] === "*") {
          out += ".*";
          i += 1;
          if (glob[i + 1] === "/") i += 1;
        } else {
          out += "[^/]*";
        }
      } else if (char === "?") out += "[^/]";
      else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${out}$`);
  };
  const trimmed = pattern.trim();
  if (trimmed === "") return false;
  if (toRegExp(trimmed).test(filePath)) return true;
  if (!trimmed.includes("/")) {
    const base = filePath.split("/").pop() ?? filePath;
    return toRegExp(trimmed).test(base);
  }
  return false;
}

export async function checkBoundaries(
  deps: LoomGateDeps,
  loom: Loom,
  program: LoomProgram,
): Promise<{ ok: boolean; offending: string[] }> {
  const { worktree } = requireWorktree(loom);
  if (program.neverTouch.length === 0) return { ok: true, offending: [] };

  const ref = baseRefFor(deps, worktree, program.work.base);
  const diff = await execGit(deps.exec, worktree, ["diff", "--name-only", `${ref}..HEAD`], {
    timeoutMs: GATE_TIMEOUT_MS,
  });
  if (diff.status !== 0) {
    // A DIFF THAT CANNOT BE READ IS NOT A CLEAN DIFF. Returning `ok` here would
    // make an unreadable repository the easiest way past the one check that is
    // terminal, which is the wrong direction for a rule whose whole purpose is
    // to fail closed. A diff that was KILLED at the deadline is the same
    // direction and a different sentence: nobody should go looking for a git
    // error that was never reported.
    return {
      ok: false,
      offending: [
        diff.timedOut
          ? `the diff against ${ref} was still running after ${GATE_TIMEOUT_LABEL} and was killed, so the never-touch paths could not be checked`
          : `the diff against ${ref} could not be read (git exited ${diff.status}), so the never-touch paths could not be checked`,
      ],
    };
  }

  const files = diff.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const offending = files.filter((file) => program.neverTouch.some((glob) => globMatch(glob, file)));
  return { ok: offending.length === 0, offending };
}

/** Which gate's `onUnknown` decides, when the outcome is `unknown`. */
function unknownPolicyFor(program: LoomProgram, blocking: LoomGateResult | undefined): "hold" | "publish" {
  // THE GATE THAT ACTUALLY CAME BACK UNKNOWN DECIDES, because `onUnknown` is
  // declared per gate and a human who wrote `publish` on one gate meant it about
  // that gate. Only when the blocking result cannot be matched to a declaration
  // does the suite-wide rule apply — and that one is strictest-wins, so a single
  // gate saying `hold` holds. `hold` is the decided default either way (§3): the
  // failure mode of holding is a PR you did not get; the failure mode of
  // publishing is red CI and burnt Actions minutes, which is worse and noisier.
  const gate = program.gates.find((candidate) => candidate.command === blocking?.command);
  return gate?.onUnknown ?? suiteUnknownPolicy(program.gates);
}

export async function runGates(
  deps: LoomGateDeps,
  loom: Loom,
  program: LoomProgram,
): Promise<{ outcome: GateOutcome; results: LoomGateResult[] }> {
  const { worktree } = requireWorktree(loom);

  // NO GATE DECLARED IS NOT `unknown`. `unknown` means a gate existed and could
  // not be trusted to have run; this means the human said there is nothing to
  // run. Reporting `unknown` here would hold every loom on a project that
  // deliberately has no test suite, forever, which is not a safety property —
  // it is a system that cannot be used. The ledger records that nothing was
  // verified, which is the honest half.
  if (program.gates.length === 0) return { outcome: "pass", results: [] };

  const results: LoomGateResult[] = [];
  for (const gate of program.gates) {
    const run = await deps.exec(
      withSlots({
        command: gate.command,
        cwd: worktree,
        timeoutMs: GATE_TIMEOUT_MS,
        ...(deps.signal ? { signal: deps.signal } : {}),
        vars: { ITEM: loom.item, BRANCH: loom.branch ?? "", TITLE: loom.title, BASE: program.work.base },
      }),
    );
    // A TIMED-OUT GATE IS `unknown`, NOT `fail`, and not its kill code either.
    // The exit code of a SIGKILLed process is an artefact of the kill, not a
    // statement the project made about its own suite; mapping it through the
    // Program's table would make 137 mean whatever 137 happens to mean there.
    const outcome: GateOutcome = run.timedOut ? "unknown" : classifyExit(run.code, gate as LoomGate);
    results.push({
      command: gate.command,
      exitCode: run.timedOut ? null : run.code,
      outcome,
      at: deps.now().getTime(),
    });
    // STOP AT THE FIRST `fail`. The answer cannot change and the next gate may
    // be a fifteen-minute suite; a run whose verdict is already decided is the
    // clearest possible waste of a night.
    if (outcome === "fail") break;
  }

  const decided = decideAfterGates(results, program.gates);
  return { outcome: decided.outcome, results };
}

/** The whole gate phase, in the order the header argues for. */
export async function gateLoom(
  deps: LoomGateDeps,
  loom: Loom,
  program: LoomProgram,
): Promise<
  | { verdict: "publish"; results: LoomGateResult[]; outcome: GateOutcome }
  | { verdict: "stuck"; reason: string; results: LoomGateResult[]; outcome?: GateOutcome }
  | { verdict: "park"; reason: string; results: LoomGateResult[] }
> {
  const rebase = await rebaseOnBase(deps, loom, program);
  if (!rebase.ok) {
    // The stale-base note rides along with the conflict rather than replacing
    // it: the conflict text is what the human acts on, and "the base you are
    // measured against is older than you think" is what stops them acting on it
    // twice.
    const reason = [rebase.reason ?? "the rebase failed", rebase.baseNote].filter((line) => line).join("\n\n");
    return { verdict: "stuck", reason, results: [] };
  }

  const boundaries = await checkBoundaries(deps, loom, program);
  if (!boundaries.ok) {
    return {
      verdict: "park",
      reason: `the diff touches ${boundaries.offending.length} path(s) the Program marks never-touch: ${boundaries.offending.join(", ")}. Parked rather than published — this is not retried.`,
      results: [],
    };
  }

  const { outcome, results } = await runGates(deps, loom, program);
  const blocking = results.find((result) => result.outcome === outcome);
  const policy = unknownPolicyFor(program, blocking);
  if (shouldPublish(outcome, policy)) return { verdict: "publish", outcome, results };

  return {
    verdict: "stuck",
    outcome,
    results,
    reason:
      outcome === "unknown"
        ? `the gate could not be verified (${blocking?.command ?? "gate"} exited ${blocking?.exitCode ?? "was killed"}, which the Program does not declare) and the Program says hold on unknown.`
        : `the gate failed: ${blocking?.command ?? "gate"} exited ${blocking?.exitCode ?? "unknown"}.`,
  };
}

/**
 * The first http(s) URL in the publish command's stdout, per §1's contract.
 *
 * ── AND IT STAYS http(s), WHICH IS A DECISION RATHER THAN AN OVERSIGHT ──────
 * A live run against a project whose `publish` echoed
 * `published local://loom/strip-openai-prefix` recorded no URL at all, and the
 * obvious repair is to widen this to any `scheme://`. It is the wrong one.
 * `publishedUrl` is not a note, it is what the deck's "Ready to review" row
 * puts in an `href` — so the field's meaning is "somewhere a human can click
 * to", and the value comes out of a shell command the user authored. Widening
 * it buys a row whose link opens nothing (`local://`), hands the browser an
 * arbitrary scheme, and trades "nothing to click" for something worse: a
 * control that claims to be a hand-off and is not.
 *
 * Falling back to the BRANCH NAME here is the same mistake wearing a different
 * hat — `href="loom/strip-openai-prefix"` is a relative URL, so the one click
 * the row offers navigates off the deck to a 404.
 *
 * The gap is real and it is answered where the hand-off actually happens: a
 * publish that printed no URL says so and NAMES THE BRANCH, in the ledger line
 * below and in the deck row (`apps/web/components/loom/deck.tsx`). A row that
 * says published with nothing to go on is the thing to fix; a row with a link
 * that lies is not the fix.
 */
export function firstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S+/)?.[0]?.replace(/[.,)\]]+$/, "");
}

export async function publishLoom(deps: LoomGateDeps, loom: Loom, program: LoomProgram): Promise<Loom> {
  const { branch } = requireWorktree(loom);
  const worktree = loom.worktreePath as string;
  const at = deps.now().getTime();

  const command = program.commands.publish;
  if (!command) {
    const parked = transitionLoom(loom, "parked", {
      parkedReason:
        "the Program declares no `publish` command, so there is nowhere for finished work to go. The branch is intact in the worktree; add a `publish` block to .telar/loom.md and dispatch again.",
      updatedAt: at,
    });
    appendLedger(deps.paths, loom.projectId, {
      at,
      kind: "park",
      loomId: loom.id,
      item: loom.item,
      summary: "no publish command declared",
    });
    return writeLoom(deps.paths, parked);
  }

  const body = [
    `Opened by the Telar Loom for item ${loom.item}.`,
    "",
    loom.gate
      ? `Gate: \`${loom.gate.command}\` exited ${loom.gate.exitCode ?? "was killed"} → **${loom.gate.outcome}**.`
      : "Gate: none declared for this project, so nothing was verified.",
    "",
    "Nobody merged anything. This branch was rebased onto a freshly fetched " +
      `\`${program.work.base}\` before the gate ran, so the result above describes the world this would land in.`,
  ].join("\n");

  const run = await deps.exec(
    withSlots({
      command,
      cwd: worktree,
      ...(deps.signal ? { signal: deps.signal } : {}),
      vars: { BRANCH: branch, TITLE: loom.title, BODY: body, BASE: program.work.base, ITEM: loom.item },
    }),
  );

  if (run.code !== 0) {
    const reason = `the publish command exited ${run.code}: ${(run.stderr.trim() || run.stdout.trim() || "no output").split("\n").slice(0, 6).join(" ")}`;
    const stuck = transitionLoom(loom, "stuck", { parkedReason: reason, updatedAt: at });
    appendLedger(deps.paths, loom.projectId, {
      at,
      kind: "error",
      loomId: loom.id,
      item: loom.item,
      summary: "publish failed",
      detail: reason,
    });
    return writeLoom(deps.paths, stuck);
  }

  const url = firstUrl(run.stdout);
  const published = transitionLoom(loom, "published", {
    updatedAt: at,
    ...(url ? { publishedUrl: url } : {}),
  });
  appendLedger(deps.paths, loom.projectId, {
    at,
    kind: "publish",
    loomId: loom.id,
    item: loom.item,
    // NAMES THE BRANCH WHEN THERE IS NO URL. `git push -u origin $BRANCH` — the
    // no-tracker example §1 promises is first-class — prints no URL at all, and
    // "published (no URL)" tells a human at 2am that something happened and
    // nothing about where to go and look.
    summary: url ? `published ${url}` : `published \`${branch}\` (the publish command printed no URL)`,
  });
  return writeLoom(deps.paths, published);
}
