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
import { advanceLooms, answerLoom, cancelLoom, createLoomRuntime, dispatchLoom, parseListed, runLoomTick, type LoomAgent, type LoomSessionPort, type LoomTickDeps } from "../src/loom/dispatch";
import { validateDecision } from "../src/loom/decide";
import { substitute, slotEnv, truncate, type LoomExec, type LoomExecInput } from "../src/loom/exec";
import { globMatch } from "../src/loom/gate";
import { createLoomRuns } from "../src/loom/run";
import { fingerprintFrom } from "../src/loom/sentinel";
import { createLoomSupervisor, type LoomSupervisor } from "../src/loom/supervisor";
import { getLoom, listLooms, loomPaths, readLedger, readWatch, writeLoom, writeSentinel, type LoomPaths } from "../src/loom/store";

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
    /** `git rev-list --count` itself failing — a deleted checkout, a base that
     *  stopped resolving. Distinct from `commits: 0`, which is the whole point. */
    countFails: false,
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
    if (joined.startsWith("rev-list --count")) {
      return repo.countFails ? { status: 128, stdout: "", stderr: "fatal: bad revision" } : ok(String(repo.commits));
    }
    return ok();
  };

  // ── sessions ────────────────────────────────────────────────────────────
  const sessions = new Map<string, "running" | "unclaimed" | "done" | "gone">();
  const stopped: string[] = [];
  let sessionSeq = 0;
  const briefs: string[] = [];
  const session: LoomSessionPort = {
    async start(input) {
      briefs.push(input.prompt);
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
      stopped.push(sessionId);
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

  /**
   * WHETHER ANYTHING COULD CLAIM A BRIEF — a flag rather than a constant, so
   * the absence of a worker is a world a test can state instead of one it can
   * only reach by accident. The daemon's real answer is its `workers` Map; here
   * that Map is a boolean, and every test that does not care about workers gets
   * the ordinary case — one is registered.
   */
  const machine = { workersAvailable: true };

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
    workersAvailable: () => machine.workersAvailable,
  };

  return {
    deps,
    machine,
    paths,
    directory,
    projectDir,
    clock,
    repo,
    agent,
    sessions,
    stopped,
    briefs,
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

// ── an unreadable world is not an empty one ─────────────────────────────────

test("a failed `list` refuses the tick, and the refusal costs zero model calls", async () => {
  /**
   * THE RULE, NOT THE MECHANISM — build-routes' framing, and it is the reason
   * this assertion survived the behaviour swapping underneath it twice. What is
   * pinned is that an unreadable backlog is never reported as an empty one; a
   * test written against `throws` or against `the prompt contains the exit code`
   * would go green through either implementation while the rule went unchecked.
   */
  const w = world();
  w.script("list", { code: 1, stderr: "gh: To get started with GitHub CLI, please run: gh auth login" });
  w.agent.decision = oneDispatch();

  await expect(runLoomTick(w.deps, PROJECT)).rejects.toThrow(/Refusing rather than reporting an empty backlog/);

  // A cost assertion, not a style one: an eight-hour outage costs zero model
  // calls rather than one per tick. It is also the only available evidence that
  // the refusal happened BEFORE the expensive half.
  expect(w.agent.calls).toBe(0);
  expect(w.execCalls.some((call) => call.command.startsWith("detail"))).toBe(false);
  // Nothing was dispatched off a backlog nobody read.
  expect(w.looms()).toHaveLength(0);

  // The run record is transient; the ledger is what answers "what happened at
  // 3am" the next morning.
  const errors = readLedger(w.paths, PROJECT).filter((entry) => entry.kind === "error");
  expect(errors).toHaveLength(1);
  expect(errors[0]?.summary).toContain("the backlog could not be read");
  // The command AND the code AND what it said — a sentence someone can act on
  // at 8am, not a number they have to go and look up.
  expect(errors[0]?.detail).toContain("`list` exited 1");
  expect(errors[0]?.detail).toContain("gh auth login");
});

test("looms in flight are still reconciled by machinery when the backlog cannot be read", async () => {
  // Only the DECIDING half is refused. Reconciliation never needed a work list,
  // and a worker that finished during an outage must not wait for it to end.
  const w = world();
  w.script("gate", { code: 0 });
  w.script("publish", { stdout: "https://example.test/pr/9" });
  await dispatchOne(w);

  w.finishWorker();
  w.script("list", { code: 1, stderr: "gh: not authenticated" });
  await expect(runLoomTick(w.deps, PROJECT)).rejects.toThrow(/exited 1/);

  expect(w.only().state).toBe("published");
});

test("a `list` that legitimately prints nothing is still an empty backlog, not a failure", async () => {
  const w = world();
  w.script("list", { code: 0, stdout: "[]" });
  w.agent.decision = emptyDecision;

  const result = await runLoomTick(w.deps, PROJECT);

  // Exit 0 and no items is the ordinary quiet night. It must still tick.
  expect(result.decision.dispatch).toHaveLength(0);
  expect(w.agent.calls).toBe(1);
  expect(readLedger(w.paths, PROJECT).filter((entry) => entry.kind === "error")).toHaveLength(0);
});

// ── an unreadable world is not an empty one ─────────────────────────────────

/**
 * A runtime wired to a REAL supervisor, so `observe` lands on the same watch
 * record the deck reads. A stubbed supervisor would answer every question the
 * way the test hoped, which is the one thing these tests must not let it do.
 */
function runtimeWithSupervisor(w: World) {
  const { supervisor } = supervisorFor(w);
  const runtime = createLoomRuntime({ ...w.deps, supervisor, interval: () => ({ clear: () => undefined }) });
  return { runtime, supervisor };
}

async function settled(runtime: ReturnType<typeof runtimeWithSupervisor>["runtime"], id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = runtime.loomWork().runs.find((candidate) => candidate.id === id);
    if (run && run.state !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("the run never settled");
}

test("a cancelled tick is not reported as a broken project", async () => {
  // `defaultLoomExec` reports an aborted command as a non-zero exit like any
  // other, so without a guard a human's own click would pin "your `list` is
  // broken" to the deck. The two are opposite diagnoses of the same exit code.
  const w = world();
  const runs = createLoomRuns(() => w.clock.at);
  const handle = runs.begin({ projectId: PROJECT, kind: "tick" });
  const aborted = { ...w.deps, signal: handle.signal };
  w.script("list", (_call, input) => {
    void input;
    runs.cancel(handle.id);
    return { code: 143, stderr: "Terminated" };
  });

  await expect(runLoomTick(aborted, PROJECT)).rejects.toThrow(/cancelled/);
  expect(readLedger(w.paths, PROJECT).filter((entry) => entry.kind === "error")).toHaveLength(0);
});

test("a failed `list` settles the run `failed` and puts the reason on the watch record", async () => {
  const w = world();
  w.script("list", { code: 1, stderr: "gh: API rate limit exceeded" });
  const { runtime, supervisor } = runtimeWithSupervisor(w);
  supervisor.setWatch(PROJECT, true);

  const started = runtime.tickLoom(PROJECT);
  const run = await settled(runtime, started.run.id);

  // The measured symptom was `RUN STATE: done · RUN ERROR: ""` — a broken
  // orchestrator that every surface rendered as healthy.
  expect(run.state).toBe("failed");
  expect(run.error ?? "").toContain("rate limit");
  expect(run.error ?? "").toContain("could not be read");

  // AND ON THE WATCH RECORD, which is the part that matters overnight. A run is
  // in memory and trimmed to the last twenty; the watch is what the deck draws
  // this project as at 8am.
  expect(readWatch(w.paths, PROJECT).lastError ?? "").toContain("rate limit");
  runtime.close();
});

test("a project that cannot read its backlog is distinguishable from one with nothing to do", async () => {
  /**
   * THE BUG, NAMED. Both projects tick, neither dispatches anything, and both
   * settle without drama — and until this test they were the same record. One
   * of them has an expired credential and one of them had a quiet night, and an
   * unattended system that cannot tell a human which is which has lost the
   * property every other decision here is in service of.
   *
   * ASSERTED ON THE WATCH RECORD RATHER THAN ON AN ERROR STRING, because the
   * watch record is what the deck reads. `deck.tsx` prints `lastError` in place
   * of "every 300s · N quiet checks" — so these two assertions are literally
   * two different rows on the screen.
   */
  const broken = world();
  broken.script("list", { code: 1, stderr: "gh: not authenticated" });
  const b = runtimeWithSupervisor(broken);
  b.supervisor.setWatch(PROJECT, true);

  const quiet = world();
  quiet.script("list", { code: 0, stdout: "[]" });
  quiet.agent.decision = emptyDecision;
  const q = runtimeWithSupervisor(quiet);
  q.supervisor.setWatch(PROJECT, true);

  await settled(b.runtime, b.runtime.tickLoom(PROJECT).run.id);
  await settled(q.runtime, q.runtime.tickLoom(PROJECT).run.id);

  // ONE PROBE EACH, both succeeding and both unchanged from here on, so every
  // difference below comes from the world-read and nothing else.
  broken.script("probe", { code: 0, stdout: "same" });
  quiet.script("probe", { code: 0, stdout: "same" });
  await b.supervisor.pass(PROJECT);
  await b.supervisor.pass(PROJECT);
  await q.supervisor.pass(PROJECT);
  await q.supervisor.pass(PROJECT);

  const brokenWatch = readWatch(broken.paths, PROJECT);
  const quietWatch = readWatch(quiet.paths, PROJECT);

  // The deck draws one of these as a sentence and the other as a cadence.
  expect(brokenWatch.lastError).toContain("not authenticated");
  expect(quietWatch.lastError).toBeUndefined();

  /**
   * AND THE BACKOFF DID NOT ADVANCE ON THE BROKEN ONE. This is the half that
   * makes the failure self-deepening if you get it wrong: an expired credential
   * whose failures score as quiet decays to an hourly cadence, so the moment
   * someone fixes the credential the project is asleep for an hour. The quiet
   * project earning its backoff in the same breath is what proves the mechanism
   * is still doing its job rather than having been switched off.
   */
  expect(brokenWatch.intervalSec).toBe(300);
  expect(brokenWatch.quietChecks).toBe(0);
  expect(quietWatch.intervalSec).toBeGreaterThan(300);
  expect(quietWatch.quietChecks).toBeGreaterThan(0);

  b.runtime.close();
  q.runtime.close();
});

test("a world-read that recovers clears the record it earned", async () => {
  // The other direction, and the reason `observe` takes a `pass` as well as an
  // `unknown`: a project stuck showing an error it has already recovered from
  // is the same lie in the opposite direction, and it would train a human to
  // ignore the field.
  const broken = world();
  let failing = true;
  broken.script("list", () => (failing ? { code: 1, stderr: "gh: not authenticated" } : { code: 0, stdout: "[]" }));
  broken.agent.decision = emptyDecision;
  const { runtime, supervisor } = runtimeWithSupervisor(broken);
  supervisor.setWatch(PROJECT, true);

  await settled(runtime, runtime.tickLoom(PROJECT).run.id);
  expect(readWatch(broken.paths, PROJECT).lastError).toContain("not authenticated");

  failing = false;
  await settled(runtime, runtime.tickLoom(PROJECT).run.id);
  expect(readWatch(broken.paths, PROJECT).lastError).toBeUndefined();

  // And the backoff is available again now that a pass is real evidence.
  broken.script("probe", { code: 0, stdout: "same" });
  await supervisor.pass(PROJECT);
  await supervisor.pass(PROJECT);
  expect(readWatch(broken.paths, PROJECT).quietChecks).toBeGreaterThan(0);
  runtime.close();
});

test("a daemon that restarts mid-outage does not hand the outage a free back-off", async () => {
  /**
   * THE SUPPRESSION IS ON DISK, AND THIS IS THE ONLY TEST THAT CAN TELL.
   *
   * Every other assertion about the unreadable mark holds a single supervisor,
   * where a field and a `Map` in a closure behave identically. The difference
   * only appears across a process boundary: held in memory, the mark died with
   * the daemon, so the FIRST quiet pass after a restart scored as evidence of
   * quiet and doubled the interval — one free back-off per restart, and a crash
   * loop walked a project that has been broken since midnight all the way to
   * the hourly ceiling. Nothing on any surface would have said so; the deck
   * would have shown a slower cadence, which is what a quiet night looks like.
   */
  const w = world();
  w.script("list", { code: 1, stderr: "gh: not authenticated" });
  w.script("probe", { code: 0, stdout: "same" });

  const first = runtimeWithSupervisor(w);
  first.supervisor.setWatch(PROJECT, true);
  await settled(first.runtime, first.runtime.tickLoom(PROJECT).run.id);
  expect(readWatch(w.paths, PROJECT).worldUnreadable ?? "").toContain("not authenticated");
  // The daemon dies mid-outage. Nothing about the world has changed.
  first.runtime.close();

  // A SECOND SUPERVISOR OVER THE SAME STORE — a restart, modelled as one. It
  // inherits the files and nothing else, which is the whole point.
  const second = supervisorFor(w);
  second.supervisor.resume();
  // The first pass is a change (this supervisor has no fingerprint to compare
  // against yet); the second is the quiet one that used to be spent.
  await second.supervisor.pass(PROJECT);
  await second.supervisor.pass(PROJECT);

  const watch = readWatch(w.paths, PROJECT);
  expect(watch.intervalSec).toBe(300);
  expect(watch.quietChecks).toBe(0);
  // And the deck still says why, in the same sentence it said before the crash.
  expect(watch.lastError ?? "").toContain("not authenticated");
  expect(watch.worldUnreadable ?? "").toContain("not authenticated");
});

test("a tick that worked does not erase a probe that did not", async () => {
  // One working read is no evidence about a different broken one. `observe`
  // clears only what it marked, because the alternative lets a successful tick
  // hide a failing probe — the same collapse, one field down.
  const w = world();
  w.script("list", { code: 0, stdout: "[]" });
  w.script("probe", { code: 1, stderr: "gh: not authenticated" });
  w.agent.decision = emptyDecision;
  const { runtime, supervisor } = runtimeWithSupervisor(w);
  supervisor.setWatch(PROJECT, true);

  await supervisor.pass(PROJECT);
  expect(readWatch(w.paths, PROJECT).lastError).toContain("probe exited 1");

  await settled(runtime, runtime.tickLoom(PROJECT).run.id);
  expect(readWatch(w.paths, PROJECT).lastError).toContain("probe exited 1");
  runtime.close();
});

// ── nothing to do, or nothing that can be done ──────────────────────────────

test("a brief nobody claims sticks the loom instead of sitting `working` forever", async () => {
  /**
   * THE SAME BUG IN DIFFERENT CLOTHES. The session port queues past
   * `worker_unavailable` on purpose, so with no worker process alive the turn
   * sits `queued` — `status` said `running`, the ledger said nothing, and the
   * loom sat `working` until somebody noticed by hand. Unbounded, silent, and
   * indistinguishable from a worker doing its job.
   */
  const w = world();
  w.agent.decision = oneDispatch();
  await runLoomTick(w.deps, PROJECT);
  const dispatched = w.only();
  expect(dispatched.state).toBe("working");

  // Nothing claimed it. Not "the worker failed" — the worker does not exist.
  w.sessions.set(dispatched.sessionId as string, "unclaimed");

  // WITHIN THE GRACE PERIOD IT WAITS. A worker restarting, or a daemon that
  // started a beat before its embedded worker registered, must not stick a loom.
  w.clock.at = new Date(w.clock.at.getTime() + 60_000);
  await advanceLooms(w.deps, PROJECT);
  expect(w.only().state).toBe("working");

  // PAST IT, IT SAYS SO — and names the thing a human has to go and start.
  w.clock.at = new Date(w.clock.at.getTime() + 30 * 60_000);
  await advanceLooms(w.deps, PROJECT);
  const stuck = w.only();
  expect(stuck.state).toBe("stuck");
  expect(stuck.parkedReason ?? "").toContain("unclaimed");
  expect(stuck.parkedReason ?? "").toContain("no worker has picked it up");
  expect(readLedger(w.paths, PROJECT).some((entry) => entry.kind === "error" && entry.summary.includes("unclaimed"))).toBe(true);
});

test("a worker that claimed its turn is never mistaken for a missing one, however long it takes", async () => {
  // The bound above is on being PICKED UP, not on getting done. If a slow
  // worker could trip it, it would be the work timeout the ladder deliberately
  // does not have — and it would kill exactly the long jobs worth running
  // overnight.
  const w = world();
  w.agent.decision = oneDispatch();
  await runLoomTick(w.deps, PROJECT);

  w.clock.at = new Date(w.clock.at.getTime() + 8 * 60 * 60_000);
  await advanceLooms(w.deps, PROJECT);
  expect(w.only().state).toBe("working");
});

test("a dispatch nobody could claim is refused with a sentence, and nothing is written first", async () => {
  /**
   * THE PRIMARY MECHANISM, WHERE THE GRACE PERIOD IS ONLY THE BACKSTOP.
   *
   * The test above bounds a brief that WAS handed over and never picked up.
   * That bound is real but it is expensive: by the time it fires, a worktree
   * has been cut, the Program's `setup` has run, `detail` has been read and a
   * session exists — all spent to discover, ten minutes later, something that
   * was knowable before any of it. So the ordinary case is refused up front.
   *
   * AND REFUSING MEANS NOTHING IS WRITTEN. A `queued` loom recorded and then
   * abandoned would pass "the dispatch did not go through" while leaving on the
   * deck exactly the phantom this exists to prevent.
   */
  const w = world();
  w.machine.workersAvailable = false;

  const failed = await dispatchLoom(w.deps, PROJECT, { item: "47", title: "Fix the prefix" }).catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(Error);
  expect((failed as Error).message).toContain("47 cannot be dispatched");
  expect((failed as Error).message).toContain("no worker process is registered");
  expect(listLooms(w.paths, PROJECT).looms).toEqual([]);
  expect(readLedger(w.paths, PROJECT)).toEqual([]);
  expect(w.gitCalls).toEqual([]);

  // AND THE SAME REQUEST GOES THROUGH once something can claim it. Without this
  // half, a check that refused unconditionally would pass everything above.
  w.machine.workersAvailable = true;
  const loom = await dispatchLoom(w.deps, PROJECT, { item: "47", title: "Fix the prefix" });
  expect(loom.state).toBe("working");
  expect(loom.worktreePath).toBeTruthy();
});

test("a queued loom with nobody to claim it is held rather than provisioned or stuck", async () => {
  /**
   * `queued` IS THE ONE STATE WHERE WAITING COSTS NOTHING. The worktree was
   * never cut, so there is nothing to walk forward and nothing spent by
   * leaving it — and both alternatives are worse than waiting. Sticking it
   * would spend a ladder rung on the absence of a process; provisioning it
   * would queue a brief into the void the refusal exists to keep it out of.
   */
  const w = world();
  w.machine.workersAvailable = false;
  const at = w.clock.at.getTime();
  writeLoom(w.paths, {
    id: "loom-queued",
    projectId: PROJECT,
    item: "47",
    title: "Fix the prefix",
    state: "queued",
    attempts: 0,
    ladderRung: 0,
    createdAt: at,
    updatedAt: at,
  });

  await advanceLooms(w.deps, PROJECT);
  const held = w.only();
  expect(held.state).toBe("queued");
  expect(held.worktreePath).toBeUndefined();
  expect(held.sessionId).toBeUndefined();
  expect(w.gitCalls).toEqual([]);

  // THE MOMENT A WORKER APPEARS it goes through on its own — no human touch, no
  // re-dispatch. A hold that needed rescuing would be a stall with better words.
  w.machine.workersAvailable = true;
  await advanceLooms(w.deps, PROJECT);
  const moved = w.only();
  expect(moved.state).toBe("working");
  expect(moved.sessionId).toBeTruthy();
});

test("with nothing to enact it, the ladder is not spent: a stuck loom keeps its rungs", async () => {
  /**
   * EVERY RUNG IS A SESSION, so a rung walked with no worker is a rung thrown
   * away — and `nextRung` is the sole writer of `attempts`, so the loss is
   * permanent. A three-rung ladder walked through an outage arrives at `asking`
   * having tried nothing at all, and §5's "each rung once" becomes false for
   * exactly the projects that most need it: the ones nobody is watching.
   */
  const w = world();
  w.script("gate", { code: 1 });
  await dispatchOne(w);
  w.finishWorker();
  await advanceLooms(w.deps, PROJECT);
  const stuck = w.only();
  expect(stuck.state).toBe("stuck");
  expect(stuck.ladderRung).toBe(0);

  // The worker process goes away while the loom sits stuck.
  w.machine.workersAvailable = false;
  for (let pass = 0; pass < 4; pass += 1) await advanceLooms(w.deps, PROJECT);
  const waiting = w.only();
  expect(waiting.state).toBe("stuck");
  // FOUR PASSES, NO RUNGS SPENT. Unguarded, this walks rungs 1 and 2 and lands
  // on `asking` — a question for a human about a ladder that was never tried.
  expect(waiting.ladderRung).toBe(0);
  expect(waiting.attempts).toBe(0);
  expect(readLedger(w.paths, PROJECT).some((entry) => entry.summary.startsWith("rung "))).toBe(false);

  // And the ladder is intact when there is something to enact it with.
  w.machine.workersAvailable = true;
  await advanceLooms(w.deps, PROJECT);
  expect(w.only().ladderRung).toBe(1);
});

test("an answer nobody could act on is refused, and the question stays open", async () => {
  /**
   * AN ANSWER IS A HUMAN'S ONE TURN AT THIS LOOM. Taking it while nothing can
   * enact it writes the misleading half of the record — a ledger line saying
   * the human replied, beside a loom that never moved — and the human, having
   * answered, has no reason to look again.
   */
  const w = world();
  w.script("gate", { code: 1 });
  await dispatchOne(w);
  for (let pass = 0; pass < 8 && w.only().state !== "asking"; pass += 1) {
    w.finishWorker();
    await advanceLooms(w.deps, PROJECT);
  }
  const asking = w.only();
  expect(asking.state).toBe("asking");

  w.machine.workersAvailable = false;
  const ledgerBefore = readLedger(w.paths, PROJECT).length;
  const failed = await answerLoom(w.deps, asking.id, "narrow it to the parser and try again").catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(Error);
  expect((failed as Error).message).toContain("cannot be restarted with your answer");
  expect((failed as Error).message).toContain("no worker process is registered");

  const untouched = w.only();
  expect(untouched.state).toBe("asking");
  expect(untouched.question).toBe(asking.question);
  expect(readLedger(w.paths, PROJECT)).toHaveLength(ledgerBefore);

  // The same words land once there is something to hand them to.
  w.machine.workersAvailable = true;
  const restarted = await answerLoom(w.deps, asking.id, "narrow it to the parser and try again");
  expect(restarted.state).toBe("working");
});

test("a re-provisioned loom stops the worker it already had", async () => {
  /**
   * Each ladder rung opens a NEW session against the SAME checkout. Nothing
   * used to stop the old one, so rung 2 put a second live agent into a worktree
   * rung 1's agent was still editing — a diff attributable to neither, measured
   * by a gate that arrived at some arbitrary moment in the middle of it.
   */
  const w = world();
  w.agent.decision = oneDispatch();
  await runLoomTick(w.deps, PROJECT);
  const first = w.only();
  const firstSession = first.sessionId as string;

  // The worker ends having committed nothing, which sticks the loom; the next
  // pass walks rung 1 and re-provisions.
  w.repo.commits = 0;
  w.finishWorker();
  await advanceLooms(w.deps, PROJECT);
  expect(w.only().state).toBe("stuck");
  await advanceLooms(w.deps, PROJECT);

  const second = w.only();
  expect(second.state).toBe("working");
  expect(second.sessionId).not.toBe(firstSession);
  // THE ONE ASSERTION: the previous session was stopped, and before the new one
  // was started rather than at some point afterwards.
  expect(w.stopped).toContain(firstSession);
  expect(w.sessions.get(firstSession)).toBe("gone");
});

// ── the audit: the same shape, found elsewhere ──────────────────────────────

test("a worker is told its item detail could not be read, never handed the error as the item", async () => {
  /**
   * FOUND BY AUDITING FOR THE `list` BUG'S SHAPE. `provisionLoom` composed the
   * worker's brief with `detail?.code === 0 ? detail.stdout : (detail?.stderr ?? "")`
   * — the failure's stderr, printed under "the item, in full", with nothing
   * saying the command had failed. One rate-limited line of stderr reads
   * exactly like a terse issue, and an empty one reads like an issue with no
   * body. The worker is the expensive half of this system and it gets one turn.
   */
  const w = world();
  w.agent.decision = oneDispatch();
  w.script("detail", { code: 7, stderr: "gh: API rate limit exceeded" });

  await runLoomTick(w.deps, PROJECT);

  const brief = w.briefs.at(-1) ?? "";
  expect(brief).toContain("the detail command exited 7");
  expect(brief).toContain("may be missing or wrong");
  // The output is still shown — it is the only evidence there is — but never
  // unlabelled.
  expect(brief).toContain("rate limit");
});

test("a commit count that could not be taken is not reported as a worker that did nothing", async () => {
  /**
   * The same shape again, one line long: `if (counted.status !== 0) return 0`.
   * Zero means the worker did nothing and sends a human to read a transcript
   * showing a worker doing exactly what it was asked; unknown means a deleted
   * checkout or a base that stopped resolving, and nothing said so.
   */
  const w = world();
  w.agent.decision = oneDispatch();
  await runLoomTick(w.deps, PROJECT);

  w.repo.commits = 0;
  w.finishWorker();
  await advanceLooms(w.deps, PROJECT);
  // The honest zero still says the honest thing.
  expect(w.only().parkedReason ?? "").toContain("without committing anything");

  const other = world();
  other.agent.decision = oneDispatch();
  await runLoomTick(other.deps, PROJECT);
  other.repo.countFails = true;
  other.finishWorker();
  await advanceLooms(other.deps, PROJECT);

  const stuck = other.only();
  expect(stuck.state).toBe("stuck");
  expect(stuck.parkedReason ?? "").toContain("could not be counted");
  expect(stuck.parkedReason ?? "").not.toContain("without committing anything");
});
