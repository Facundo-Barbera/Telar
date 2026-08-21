/**
 * THE LOOM RUNTIME, DRIVEN ENTIRELY BY FAKES.
 *
 * Not one test here starts a process, reaches a network, spends a rate limit or
 * loads a model. `daemon.ts:51-85` states the rule and this suite is where it is
 * cashed: `exec`, `git`, `session`, `agent`, `now` and the supervisor's interval
 * are all parameters, so the whole lifecycle — dispatch, worktree, gate, ladder,
 * publish — runs in milliseconds against scripted exit codes.
 *
 * THE CENTRAL TEST IS THE CHEAPEST-LOOKING ONE. "the sentinel does not call the
 * agent when the probe output is unchanged" asserts a call count is zero, which
 * reads like nothing. It is the property the entire design rests on: a loop that
 * wakes an agent to discover there is nothing to do is the same cost trap in a
 * new costume, and it is invisible in every other kind of testing — the system
 * looks perfectly correct while quietly costing money forever.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Loom, LoomProgram, TickDecision } from "@telar/engine-client";
import type { GitResult, GitRunner } from "../src/worktree";
import { advanceLooms, cancelLoom, dispatchLoom, parseListed, runLoomTick, type LoomAgent, type LoomSessionPort, type LoomTickDeps } from "../src/loom/dispatch";
import { validateDecision } from "../src/loom/decide";
import { substitute, slotEnv, truncate, type LoomExec, type LoomExecInput } from "../src/loom/exec";
import { globMatch } from "../src/loom/gate";
import { createLoomRuns } from "../src/loom/run";
import { fingerprintFrom } from "../src/loom/sentinel";
import { createLoomSupervisor, type LoomSupervisor } from "../src/loom/supervisor";
import { getLoom, listLooms, loomPaths, readLedger, writeSentinel, type LoomPaths } from "../src/loom/store";

const roots: string[] = [];
const supervisors: LoomSupervisor[] = [];

afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

// ── the world ───────────────────────────────────────────────────────────────

type Script = { code?: number; stdout?: string; stderr?: string; timedOut?: boolean };
type Scripted = Script | ((call: number, input: LoomExecInput) => Script);

const PROJECT = "demo";

function baseProgram(patch: Partial<LoomProgram> = {}): LoomProgram {
  return {
    version: 1,
    project: PROJECT,
    commands: { probe: "probe", list: "list", detail: "detail $ITEM", publish: "publish $BRANCH $TITLE $BODY $BASE" },
    gates: [{ command: "gate", exits: { 0: "pass", 1: "fail", 2: "unknown" }, onUnknown: "hold" }],
    work: { base: "main", branchPrefix: "t3code/", concurrency: 2 },
    neverTouch: [],
    ladder: [
      { n: 1, label: "re-read the item", enabled: true, absorbed: 0 },
      { n: 2, label: "run the gate again", enabled: true, absorbed: 0 },
      { n: 3, label: "start from scratch", enabled: false, absorbed: 0 },
    ],
    askWhen: [],
    watch: { intervalSec: 300, backoffMaxSec: 3600 },
    assumed: [],
    notes: "",
    ...patch,
  };
}

const emptyDecision: TickDecision = { triage: [], dispatch: [], park: [], ask: [], note: "" };

function ok(stdout = ""): GitResult {
  return { status: 0, stdout, stderr: "" };
}

function world(options: { program?: LoomProgram } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-loom-runtime-"));
  roots.push(directory);
  const projectDir = path.join(directory, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const paths: LoomPaths = loomPaths(directory);

  let program = options.program ?? baseProgram();
  const clock = { at: new Date("2026-08-20T02:00:00.000Z") };

  // ── the shell, scripted by the first word of the command ────────────────
  const scripts = new Map<string, Scripted>();
  const counts = new Map<string, number>();
  const execCalls: LoomExecInput[] = [];
  const exec: LoomExec = async (input) => {
    execCalls.push(input);
    const key = (input.command.split(/\s+/)[0] ?? "").trim();
    const seen = (counts.get(key) ?? 0) + 1;
    counts.set(key, seen);
    const scripted = scripts.get(key);
    const script = typeof scripted === "function" ? scripted(seen, input) : (scripted ?? {});
    return {
      code: script.code ?? 0,
      stdout: script.stdout ?? "",
      stderr: script.stderr ?? "",
      timedOut: script.timedOut ?? false,
    };
  };

  // ── git, with just enough state to have opinions ────────────────────────
  const gitCalls: string[][] = [];
  const repo = {
    commits: 1,
    diffFiles: [] as string[],
    hasOrigin: false,
    rebase: { status: 0, stdout: "", stderr: "" } as GitResult,
  };
  const git: GitRunner = (_cwd, args) => {
    gitCalls.push(args);
    const joined = args.join(" ");
    if (joined === "rev-parse --is-inside-work-tree") return ok("true");
    if (joined.startsWith("rev-parse --verify --quiet origin/")) {
      return repo.hasOrigin ? ok("a".repeat(40)) : { status: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse") return ok("b".repeat(40));
    if (joined === "rebase --abort") return ok();
    if (args[0] === "rebase") return repo.rebase;
    if (joined.startsWith("diff --name-only")) return ok(repo.diffFiles.join("\n"));
    if (joined.startsWith("rev-list --count")) return ok(String(repo.commits));
    return ok();
  };

  // ── sessions ────────────────────────────────────────────────────────────
  const sessions = new Map<string, "running" | "done" | "gone">();
  let sessionSeq = 0;
  const session: LoomSessionPort = {
    async start() {
      const sessionId = `session-${(sessionSeq += 1)}`;
      sessions.set(sessionId, "running");
      return { sessionId };
    },
    async create() {
      const sessionId = `orchestrator-${(sessionSeq += 1)}`;
      sessions.set(sessionId, "running");
      return { sessionId };
    },
    async status(sessionId) {
      return sessions.get(sessionId) ?? "gone";
    },
    async stop(sessionId) {
      sessions.set(sessionId, "gone");
    },
  };

  // ── the orchestrator, which is a constant ───────────────────────────────
  const agent = { calls: 0, prompts: [] as string[], decision: emptyDecision, fail: undefined as string | undefined };
  const loomAgent: LoomAgent = async (prompt) => {
    agent.calls += 1;
    agent.prompts.push(prompt);
    return agent.fail ? { ok: false, reason: agent.fail } : { ok: true, value: agent.decision };
  };

  const deps: LoomTickDeps = {
    paths,
    exec,
    git,
    now: () => clock.at,
    projectRoot: () => projectDir,
    readProgram: () => program,
    runs: createLoomRuns(() => clock.at),
    agent: loomAgent,
    session,
    engineRoot: directory,
  };

  return {
    deps,
    paths,
    directory,
    projectDir,
    clock,
    repo,
    agent,
    sessions,
    execCalls,
    gitCalls,
    script(key: string, value: Scripted) {
      scripts.set(key, value);
    },
    setProgram(next: LoomProgram) {
      program = next;
    },
    get program() {
      return program;
    },
    /** Every loom the store holds for the project, freshly read. */
    looms(): Loom[] {
      return listLooms(paths, PROJECT).looms;
    },
    only(): Loom {
      const looms = listLooms(paths, PROJECT).looms;
      expect(looms).toHaveLength(1);
      return looms[0] as Loom;
    },
    /** Retire whatever session is currently running, as an exiting worker would. */
    finishWorker() {
      for (const [id, state] of sessions) if (state === "running") sessions.set(id, "done");
    },
  };
}

type World = ReturnType<typeof world>;

function supervisorFor(w: World, overrides: Partial<Parameters<typeof createLoomSupervisor>[0]> = {}) {
  const fired: Array<() => void> = [];
  const wakes: string[] = [];
  const advances: string[] = [];
  const supervisor = createLoomSupervisor({
    paths: w.deps.paths,
    exec: w.deps.exec,
    now: w.deps.now,
    projectRoot: w.deps.projectRoot,
    readProgram: w.deps.readProgram,
    onWake: (projectId, reason) => {
      wakes.push(reason);
      // A wake fires a tick, and a tick invokes the agent. Modelled literally so
      // that "the agent was never called" is a claim about the real path.
      void w.deps.agent("(woken)").catch(() => undefined);
      void projectId;
    },
    onAdvance: (projectId) => {
      advances.push(projectId);
    },
    interval: (fn) => {
      fired.push(fn);
      return { clear: () => undefined };
    },
    ...overrides,
  });
  supervisors.push(supervisor);
  return { supervisor, wakes, advances, armed: fired };
}

/** The one dispatch every lifecycle test starts from. */
function oneDispatch(): TickDecision {
  return {
    triage: [{ item: "47", classification: "dispatchable", reason: "self-contained", ask: "fix the prefix" }],
    dispatch: [{ item: "47", title: "Fix the prefix", branchSlug: "fix-the-prefix", brief: "strip the prefix" }],
    park: [],
    ask: [],
    note: "dispatched 47",
  };
}

async function dispatchOne(w: World): Promise<Loom> {
  w.script("list", { stdout: JSON.stringify([{ number: 47, updatedAt: "2026-08-20T01:00:00Z" }]) });
  w.script("detail", { stdout: "the issue body" });
  w.agent.decision = oneDispatch();
  const result = await runLoomTick(w.deps, PROJECT);
  expect(result.dispatched).toHaveLength(1);
  return result.dispatched[0] as Loom;
}

// ── the substitution surface ────────────────────────────────────────────────

test("a slot value containing quotes survives substitution, because the value never enters the command", () => {
  // The whole reason `substitute` writes an env reference rather than the value:
  // issue titles contain quotes, backticks and `$`, and pasting one into
  // `--title "$TITLE"` produces three arguments and possibly an execution.
  const command = substitute('gh pr create --title "$TITLE" --body "$BODY" --base $BASE', {
    TITLE: 'Fix the "auth" bug',
    BODY: "`whoami` && rm -rf $HOME",
    BASE: "main",
  });
  expect(command).toBe('gh pr create --title ""$LOOM_TITLE"" --body ""$LOOM_BODY"" --base "$LOOM_BASE"');
  expect(command).not.toContain("auth");
  expect(command).not.toContain("whoami");

  const env = slotEnv({ TITLE: 'Fix the "auth" bug' });
  expect(env.LOOM_TITLE).toBe('Fix the "auth" bug');
  expect(env.TITLE).toBe('Fix the "auth" bug');
});

test("substitution does not eat a longer name that merely starts with a slot", () => {
  expect(substitute("echo $ITEM $ITEMS", { ITEM: "47" })).toBe('echo "$LOOM_ITEM" $ITEMS');
});

test("captured output is truncated with a marker rather than silently", () => {
  const truncated = truncate("x".repeat(100), 10);
  expect(truncated.startsWith("x".repeat(10))).toBe(true);
  expect(truncated).toContain("truncated 90 more characters");
});

// ── the sentinel ────────────────────────────────────────────────────────────

test("the sentinel does NOT call the agent when the probe output is unchanged", async () => {
  const w = world();
  w.script("probe", { stdout: "same-fingerprint\n" });
  const { supervisor, wakes } = supervisorFor(w);

  supervisor.setWatch(PROJECT, true);
  // Seed the fingerprint so the very first pass has something to compare with —
  // a project that has never been probed SHOULD wake, and that is a different
  // property from this one.
  writeSentinel(w.paths, PROJECT, fingerprintFrom("same-fingerprint\n", 0));

  for (let pass = 0; pass < 5; pass += 1) await supervisor.pass(PROJECT);

  // THE ASSERTION THE DESIGN RESTS ON.
  expect(w.agent.calls).toBe(0);
  expect(wakes).toEqual([]);
});

test("a never-probed project wakes on its first pass", async () => {
  const w = world();
  w.script("probe", { stdout: "first\n" });
  const { supervisor, wakes } = supervisorFor(w);
  supervisor.setWatch(PROJECT, true);

  await supervisor.pass(PROJECT);

  expect(wakes).toHaveLength(1);
  expect(w.agent.calls).toBe(1);
});

test("the backoff doubles on quiet passes and resets the moment anything changes", async () => {
  const w = world();
  w.script("probe", { stdout: "quiet\n" });
  const { supervisor, wakes } = supervisorFor(w);
  supervisor.setWatch(PROJECT, true);
  writeSentinel(w.paths, PROJECT, fingerprintFrom("quiet\n", 0));

  expect(supervisor.watch(PROJECT).intervalSec).toBe(300);
  expect((await supervisor.pass(PROJECT)).intervalSec).toBe(600);
  expect((await supervisor.pass(PROJECT)).intervalSec).toBe(1200);
  expect(supervisor.watch(PROJECT).quietChecks).toBe(2);

  w.script("probe", { stdout: "something moved\n" });
  const woken = await supervisor.pass(PROJECT);

  expect(woken.intervalSec).toBe(300);
  expect(woken.quietChecks).toBe(0);
  expect(wakes).toHaveLength(1);
});

test("a failing probe records the error, wakes nothing, and does not touch the backoff", async () => {
  const w = world();
  w.script("probe", { stdout: "quiet\n" });
  const { supervisor, wakes } = supervisorFor(w);
  supervisor.setWatch(PROJECT, true);
  writeSentinel(w.paths, PROJECT, fingerprintFrom("quiet\n", 0));

  const backedOff = await supervisor.pass(PROJECT);
  expect(backedOff.intervalSec).toBe(600);

  // `gh` rate-limited, network down, credentials expired. UNKNOWN — not
  // "changed" (which would wake an agent every interval of someone else's
  // outage) and not "unchanged" (which would let the backoff climb to an hour
  // on evidence that was never gathered).
  w.script("probe", { code: 1, stderr: "gh: API rate limit exceeded" });
  const failed = await supervisor.pass(PROJECT);

  expect(failed.lastError).toContain("probe exited 1");
  expect(failed.lastError).toContain("rate limit");
  expect(failed.intervalSec).toBe(600);
  expect(failed.quietChecks).toBe(1);
  expect(wakes).toEqual([]);
  expect(w.agent.calls).toBe(0);
});

test("a quiet probe with a loom in flight advances rather than backing off", async () => {
  const w = world();
  w.script("probe", { stdout: "quiet\n" });
  await dispatchOne(w);

  const { supervisor, wakes, advances } = supervisorFor(w);
  supervisor.setWatch(PROJECT, true);
  writeSentinel(w.paths, PROJECT, fingerprintFrom("quiet\n", 0));

  const after = await supervisor.pass(PROJECT);

  expect(advances).toEqual([PROJECT]);
  expect(wakes).toEqual([]);
  // Not counted as quiet: a finished worker must not wait an hour to be noticed.
  expect(after.intervalSec).toBe(300);
  expect(after.quietChecks).toBe(0);
});

test("no interval is armed until a watch is started, and close is idempotent", () => {
  const w = world();
  const { supervisor, armed } = supervisorFor(w);

  expect(armed).toHaveLength(0);
  supervisor.setWatch(PROJECT, true);
  expect(armed).toHaveLength(1);
  supervisor.setWatch(PROJECT, false);
  supervisor.close();
  supervisor.close();
});

// ── the lifecycle ───────────────────────────────────────────────────────────

test("a tick dispatches, the worker finishes, the gate passes, and the loom publishes", async () => {
  const w = world();
  w.script("gate", { code: 0 });
  w.script("publish", { stdout: "https://github.com/acme/repo/pull/12\n" });

  const dispatched = await dispatchOne(w);
  expect(dispatched.state).toBe("working");
  expect(dispatched.branch).toBe("t3code/fix-the-prefix");
  expect(dispatched.sessionId).toBeTruthy();

  // The worker's session ends. Nothing told the orchestrator; it is re-derived.
  w.finishWorker();
  await advanceLooms(w.deps, PROJECT);

  const published = w.only();
  expect(published.state).toBe("published");
  expect(published.publishedUrl).toBe("https://github.com/acme/repo/pull/12");
  expect(published.gate?.outcome).toBe("pass");

  // Never merges, never pushes to base, never force-pushes.
  const verbs = w.gitCalls.map((args) => args.join(" "));
  expect(verbs.some((verb) => verb.startsWith("merge"))).toBe(false);
  expect(verbs.some((verb) => verb.startsWith("push"))).toBe(false);
  expect(verbs.some((verb) => verb.includes("--force"))).toBe(false);
});

test("gate exit 2 holds under `hold` and publishes under `publish` — the policy is the Program's, not the code's", async () => {
  const held = world();
  held.script("gate", { code: 2 });
  held.script("publish", { stdout: "https://example.test/pr/1" });
  await dispatchOne(held);
  held.finishWorker();
  await advanceLooms(held.deps, PROJECT);

  const holding = held.only();
  expect(holding.state).toBe("stuck");
  expect(holding.gate?.outcome).toBe("unknown");
  expect(held.execCalls.some((call) => call.command.startsWith("publish"))).toBe(false);

  const shipped = world({
    program: baseProgram({ gates: [{ command: "gate", exits: { 0: "pass", 1: "fail", 2: "unknown" }, onUnknown: "publish" }] }),
  });
  shipped.script("gate", { code: 2 });
  shipped.script("publish", { stdout: "https://example.test/pr/2" });
  await dispatchOne(shipped);
  shipped.finishWorker();
  await advanceLooms(shipped.deps, PROJECT);

  const published = shipped.only();
  expect(published.state).toBe("published");
  expect(published.gate?.outcome).toBe("unknown");
  expect(published.publishedUrl).toBe("https://example.test/pr/2");
});

test("an exit code the Program does not declare is `unknown`, never `fail`", async () => {
  const w = world();
  // The table declares 0, 1 and 2. 137 is a SIGKILL from an OOM killer, and
  // reading it as `fail` would be this design's exact original sin.
  w.script("gate", { code: 137 });
  await dispatchOne(w);
  w.finishWorker();
  await advanceLooms(w.deps, PROJECT);

  const loom = w.only();
  expect(loom.gate?.outcome).toBe("unknown");
  expect(loom.gate?.exitCode).toBe(137);
  expect(loom.state).toBe("stuck");
  expect(loom.parkedReason).toContain("could not be verified");
});

test("a diff touching a never-touch path parks the loom instead of publishing it, and the gate never runs", async () => {
  const w = world({ program: baseProgram({ neverTouch: [".env*", "supabase/.env.keys"] }) });
  w.repo.diffFiles = ["apps/web/src/page.tsx", "apps/web/.env.local"];
  w.script("gate", { code: 0 });
  w.script("publish", { stdout: "https://example.test/pr/3" });

  await dispatchOne(w);
  w.finishWorker();
  await advanceLooms(w.deps, PROJECT);

  const parked = w.only();
  expect(parked.state).toBe("parked");
  expect(parked.parkedReason).toContain("apps/web/.env.local");
  expect(parked.parkedReason).toContain("never-touch");
  // Checked BEFORE the gate, so a green chip never appears beside a forbidden diff.
  expect(w.execCalls.some((call) => call.command.startsWith("gate"))).toBe(false);
  expect(w.execCalls.some((call) => call.command.startsWith("publish"))).toBe(false);
});

test("a rebase conflict sends the loom to the ladder's first rung with the conflict text as its reason", async () => {
  const w = world();
  w.repo.rebase = {
    status: 1,
    stdout: "CONFLICT (content): Merge conflict in apps/engine/src/state.ts",
    stderr: "error: could not apply 9fd5292",
  };
  w.script("gate", { code: 0 });

  await dispatchOne(w);
  w.finishWorker();
  await advanceLooms(w.deps, PROJECT);

  const stuck = w.only();
  expect(stuck.state).toBe("stuck");
  expect(stuck.parkedReason).toContain("CONFLICT (content)");
  expect(stuck.parkedReason).toContain("apps/engine/src/state.ts");
  // A conflicting branch genuinely needs a decision, so the gate is not reached.
  expect(w.execCalls.some((call) => call.command.startsWith("gate"))).toBe(false);
  expect(w.gitCalls.some((args) => args.join(" ") === "rebase --abort")).toBe(true);

  // The next pass enters the ladder at rung 1.
  await advanceLooms(w.deps, PROJECT);
  expect(w.only().ladderRung).toBe(1);
});

test("the ladder is walked in order, each rung once, and past the last enabled rung the loom is asking", async () => {
  const w = world();
  w.script("gate", { code: 1 });

  await dispatchOne(w);
  const rungs: number[] = [];

  for (let round = 0; round < 3; round += 1) {
    w.finishWorker();
    await advanceLooms(w.deps, PROJECT); // → stuck
    expect(w.only().state).toBe("stuck");
    await advanceLooms(w.deps, PROJECT); // → the next rung, or asking
    const loom = w.only();
    if (loom.state === "asking") break;
    rungs.push(loom.ladderRung);
  }

  // Rungs 1 and 2 are enabled; rung 3 is `[off]` and is skipped entirely.
  expect(rungs).toEqual([1, 2]);
  const asking = w.only();
  expect(asking.state).toBe("asking");
  expect(asking.question).toContain("Every enabled rung of the ladder has been tried");
  expect(asking.ladderRung).toBe(2);

  // The rung labels were handed to the worker verbatim — the engine never
  // interprets them.
  const ledger = readLedger(w.paths, PROJECT).map((entry) => entry.summary);
  expect(ledger).toContain("rung 1: re-read the item");
  expect(ledger).toContain("rung 2: run the gate again");
  expect(ledger.filter((line) => line.startsWith("rung 1:"))).toHaveLength(1);
});

test("a worker whose session is gone with nothing committed goes stuck, not published", async () => {
  const w = world();
  w.script("gate", { code: 0 });
  w.script("publish", { stdout: "https://example.test/pr/4" });

  const dispatched = await dispatchOne(w);
  // The lid closed. The session is gone and the worktree is empty.
  w.sessions.set(dispatched.sessionId as string, "gone");
  w.repo.commits = 0;

  await advanceLooms(w.deps, PROJECT);

  const loom = w.only();
  expect(loom.state).toBe("stuck");
  expect(loom.parkedReason).toContain("without committing");
  expect(w.execCalls.some((call) => call.command.startsWith("publish"))).toBe(false);
});

// ── the wall between deciding and doing ─────────────────────────────────────

test("validateDecision drops a dispatch past concurrency and the drop is reported, never silent", async () => {
  const w = world({ program: baseProgram({ work: { base: "main", branchPrefix: "t3code/", concurrency: 1 } }) });
  w.script("list", {
    stdout: JSON.stringify([
      { number: 47, updatedAt: "t1" },
      { number: 48, updatedAt: "t1" },
    ]),
  });
  w.script("detail", { stdout: "body" });
  w.agent.decision = {
    triage: [],
    dispatch: [
      { item: "47", title: "First", branchSlug: "first", brief: "" },
      { item: "48", title: "Second", branchSlug: "second", brief: "" },
    ],
    park: [],
    ask: [],
    note: "two at once",
  };

  const result = await runLoomTick(w.deps, PROJECT);

  expect(result.decision.dispatch).toHaveLength(1);
  expect(result.dispatched).toHaveLength(1);
  const drops = readLedger(w.paths, PROJECT).filter((entry) => entry.summary.includes("dropped part of the decision"));
  expect(drops).toHaveLength(1);
  expect(drops[0]?.detail ?? "").toContain("48");
});

test("the machinery refuses a second loom on an item that already has one", async () => {
  const w = world();
  await dispatchOne(w);
  await expect(dispatchLoom(w.deps, PROJECT, { item: "47", title: "again" })).rejects.toThrow(/already has loom/);
  expect(w.looms()).toHaveLength(1);
});

test("validateDecision reports over-concurrency directly, with a sentence rather than a count", () => {
  const { decision, rejected } = validateDecision(
    {
      triage: [],
      dispatch: [
        { item: "1", title: "a", branchSlug: "a", brief: "" },
        { item: "2", title: "b", branchSlug: "b", brief: "" },
        { item: "3", title: "c", branchSlug: "c", brief: "" },
      ],
      park: [],
      ask: [],
      note: "",
    },
    { looms: [], concurrency: 1 },
  );
  expect(decision.dispatch).toHaveLength(1);
  expect(rejected).toHaveLength(2);
  expect(rejected.join(" ")).toContain("concurrency");
});

// ── ticks, dry runs and the surfaces they feed ──────────────────────────────

test("a tick without a Program refuses with a sentence a human can act on", async () => {
  const w = world();
  w.deps.readProgram = () => null;
  await expect(runLoomTick(w.deps, PROJECT)).rejects.toThrow(/\.telar\/loom\.md/);
});

test("a tick caps the details it reads and says how many it skipped", async () => {
  const w = world();
  const items = Array.from({ length: 12 }, (_, index) => ({ number: 100 + index, updatedAt: "t1" }));
  w.script("list", { stdout: JSON.stringify(items) });
  w.script("detail", { stdout: "body" });
  w.agent.decision = emptyDecision;

  await runLoomTick(w.deps, PROJECT);

  const detailCalls = w.execCalls.filter((call) => call.command.startsWith("detail"));
  expect(detailCalls).toHaveLength(8);
  // Silent truncation reads as "covered everything". It is stated to the agent…
  expect(w.agent.prompts[0]).toContain("**4 were NOT read this tick**");
  // …and recorded where a human reads it afterwards.
  const tick = readLedger(w.paths, PROJECT).find((entry) => entry.kind === "tick");
  expect(tick?.detail ?? "").toContain("4 stale item(s) not read");
});

test("a dry run reports what it would do, surfaces what the Program never mentions, and writes nothing", async () => {
  const w = world({ program: baseProgram({ commands: { list: "list", detail: "detail $ITEM" }, assumed: ["`hito N` means a milestone"] }) });
  w.script("list", { stdout: JSON.stringify([{ number: 47, updatedAt: "t1" }]) });
  w.script("detail", { stdout: "body" });
  w.agent.decision = oneDispatch();

  const result = await runLoomTick(w.deps, PROJECT, { dryRun: true });

  expect(result.dispatched).toHaveLength(0);
  expect(w.looms()).toHaveLength(0);
  expect(readLedger(w.paths, PROJECT)).toHaveLength(0);

  const report = result.report ?? "";
  expect(report).toContain("dispatch  47  Fix the prefix");
  expect(report).toContain("nothing below was executed");
  // The line that earns the report: the Program has no probe and no publish and
  // never said so.
  expect(report).toContain("declares no `probe`");
  expect(report).toContain("declares no `publish`");
  expect(report).toContain("still assumed, never confirmed: `hito N` means a milestone");
});

test("the worker's brief states the prohibitions it cannot violate anyway", async () => {
  const w = world({ program: baseProgram({ neverTouch: [".env*"] }) });
  const sessionStarts: string[] = [];
  const start = w.deps.session.start.bind(w.deps.session);
  w.deps.session.start = async (input) => {
    sessionStarts.push(input.prompt);
    return start(input);
  };

  await dispatchOne(w);

  const brief = sessionStarts[0] ?? "";
  expect(brief).toContain("Do NOT run the gate.");
  expect(brief).toContain("Do NOT commit to `main`");
  expect(brief).toContain("Do NOT open a pull request");
  expect(brief).toContain("Do NOT touch these paths");
  expect(brief).toContain("`.env*`");
  expect(brief).toContain("YOUR JOB ENDS AT");
});

test("cancelling stops the session and keeps the branch, because the branch is the output", async () => {
  const w = world();
  const dispatched = await dispatchOne(w);

  const cancelled = await cancelLoom(w.deps, dispatched.id);

  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.branch).toBe("t3code/fix-the-prefix");
  expect(w.sessions.get(dispatched.sessionId as string)).toBe("gone");
  expect(w.gitCalls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
  // Idempotent: a second click is not an error.
  expect((await cancelLoom(w.deps, dispatched.id)).state).toBe("cancelled");
});

// ── small pure surfaces ─────────────────────────────────────────────────────

test("a bare never-touch glob matches the basename anywhere, because that is what a human means by `.env*`", () => {
  expect(globMatch(".env*", "apps/web/.env.local")).toBe(true);
  expect(globMatch(".env*", ".env")).toBe(true);
  expect(globMatch("supabase/.env.keys", "supabase/.env.keys")).toBe(true);
  expect(globMatch("supabase/.env.keys", "other/.env.keys")).toBe(false);
  expect(globMatch("packages/legacy/**", "packages/legacy/deep/file.ts")).toBe(true);
  expect(globMatch(".env*", "apps/web/environment.ts")).toBe(false);
});

test("`list` output is read as JSON, as tab-separated lines, or not at all", () => {
  expect(parseListed(JSON.stringify([{ number: 47, updatedAt: "t1" }]))).toEqual([{ item: "47", updatedAt: "t1" }]);
  expect(parseListed("47\tt1\n48\tt2")).toEqual([
    { item: "47", updatedAt: "t1" },
    { item: "48", updatedAt: "t2" },
  ]);
  // Free prose yields nothing rather than a guess: a triage cache keyed on
  // invented ids is worse than an empty one.
  expect(parseListed("here is what I want done this week")).toEqual([]);
});

test("the run registry keeps in-flight ticks visible and refuses to lose a running one", () => {
  const runs = createLoomRuns(() => new Date("2026-08-20T02:00:00.000Z"));
  const handle = runs.begin({ projectId: PROJECT, kind: "tick" });
  handle.step("asking the orchestrator");

  expect(runs.runningFor(PROJECT)?.step).toBe("asking the orchestrator");
  expect(runs.cancel(handle.id)).toBe(true);
  expect(handle.signal.aborted).toBe(true);

  handle.settle({ state: "done", note: "did a thing" });
  const settled = runs.find(handle.id);
  expect(settled?.state).toBe("done");
  expect(settled?.step).toBeUndefined();
  // Idempotent: a `finally` after a real outcome must not overwrite it.
  handle.settle({ state: "failed", error: "late" });
  expect(runs.find(handle.id)?.state).toBe("done");
  expect(runs.runningFor(PROJECT)).toBeUndefined();
});

test("resume picks a persisted watch back up without spending the backoff it earned", async () => {
  const w = world();
  w.script("probe", { stdout: "quiet\n" });

  // A human turned the watch on, and a quiet night backed it off.
  const first = supervisorFor(w);
  first.supervisor.setWatch(PROJECT, true);
  writeSentinel(w.paths, PROJECT, fingerprintFrom("quiet\n", 0));
  await first.supervisor.pass(PROJECT);
  await first.supervisor.pass(PROJECT);
  expect(first.supervisor.watch(PROJECT).intervalSec).toBe(1200);
  first.supervisor.close();

  // The daemon restarts. A second supervisor over the same store arms nothing
  // on construction — and without `resume` it would arm nothing ever, while
  // `running` stayed true on disk and the deck drew "watching".
  const second = supervisorFor(w);
  expect(second.supervisor.watch(PROJECT).running).toBe(true);
  expect(second.armed).toHaveLength(0);

  second.supervisor.resume();
  expect(second.armed).toHaveLength(1);
  // NOT `setWatch(id, true)`: that resets both of these, so a restart would read
  // as a human pressing the button and re-probe an idle project every 300s.
  expect(second.supervisor.watch(PROJECT).intervalSec).toBe(1200);
  expect(second.supervisor.watch(PROJECT).quietChecks).toBe(2);
});

test("resume is a no-op on a first-run engine, which has no watch to pick up", () => {
  const fresh = world();
  const { supervisor, armed } = supervisorFor(fresh);

  supervisor.resume();

  // No project configured, no Program, no watch record — and so no probe.
  expect(armed).toHaveLength(0);
  expect(supervisor.list()).toEqual([]);
});

test("the session adopts the checkout by branch and base, not by path alone", async () => {
  const w = world();
  const starts: Array<{ worktree: string; branch: string; baseRef?: string }> = [];
  const start = w.deps.session.start.bind(w.deps.session);
  w.deps.session.start = async (input) => {
    starts.push({ worktree: input.worktree, branch: input.branch, ...(input.baseRef ? { baseRef: input.baseRef } : {}) });
    return start(input);
  };

  const dispatched = await dispatchOne(w);

  // THE BRANCH TRAVELS WITH THE PATH. A port taking only a path leaves the
  // session free to record a different branch than the work lands on — and then
  // the gate counts commits on one branch while `publish` pushes another, which
  // fails by looking idle rather than by failing.
  expect(starts).toHaveLength(1);
  expect(starts[0]?.branch).toBe("t3code/fix-the-prefix");
  expect(starts[0]?.branch).toBe(dispatched.branch);
  expect(starts[0]?.worktree).toBe(dispatched.worktreePath);
  expect(starts[0]?.baseRef).toBe("b".repeat(40));
});

test("a re-provisioned loom adopts its existing checkout rather than cutting a second one", async () => {
  const w = world();
  w.script("gate", { code: 1 });
  const starts: string[] = [];
  const start = w.deps.session.start.bind(w.deps.session);
  w.deps.session.start = async (input) => {
    starts.push(input.branch);
    return start(input);
  };

  const dispatched = await dispatchOne(w);
  w.finishWorker();
  await advanceLooms(w.deps, PROJECT); // → stuck
  await advanceLooms(w.deps, PROJECT); // → rung 1, same worktree

  const retried = w.only();
  expect(retried.state).toBe("working");
  expect(retried.worktreePath).toBe(dispatched.worktreePath);
  expect(retried.branch).toBe(dispatched.branch);
  // Every session ran on the one branch the gate measures and `publish` pushes.
  expect(starts).toEqual(["t3code/fix-the-prefix", "t3code/fix-the-prefix"]);
  // One checkout, cut once. A second `worktree add` would strand the first.
  expect(w.gitCalls.filter((args) => args[0] === "worktree" && args[1] === "add")).toHaveLength(1);
});
