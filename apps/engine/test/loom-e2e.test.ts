/**
 * THE LOOP, CLOSED, AGAINST A REAL GIT REPOSITORY.
 *
 * Every other loom suite proves one layer. `loom-runtime.test.ts` drives the
 * lifecycle with every subprocess faked; `loom-gates.test.ts` owns the exit
 * table; `loom-routes.test.ts` owns the seam. None of them ever cuts a real
 * worktree, and so none of them can tell you whether the product works.
 *
 * This one does: a real `git init`, a real commit, a real `main`, a real bare
 * repository standing in for the remote, real worktrees cut by the engine's own
 * `createSessionWorktree`, real `defaultLoomExec` spawning real shells, real
 * gates, real rebases, real pushes. Git is local, deterministic and free — the
 * things that are forbidden are the network, a real Claude session and somebody's
 * rate limit, and none of those appear below.
 *
 * ── EXACTLY TWO THINGS ARE FAKED ────────────────────────────────────────────
 *   1. `LoomAgent` — a scripted `TickDecision`. A real one costs money and would
 *      make the suite non-deterministic; what it decides is not what is under
 *      test here, what happens to its decision is.
 *   2. `LoomSessionPort`'s worker — a function that writes a file and commits it
 *      inside the worktree, standing in for Claude doing the work. Its exit and
 *      its commits are the only thing the harness ever reads off it, which is
 *      precisely the contract §4 defines.
 *
 * ── AND THE SECOND ONE IS WHY §11 EXISTS ────────────────────────────────────
 * Faking the PORT and faking the WORKER are not the same concession, and the
 * difference cost this build its central bug: a fake port never called
 * `EngineStore.createSession`, which was cutting a second worktree the worker
 * ran in instead of the loom's. Section 11 at the bottom of this file runs the
 * same loop through the REAL port over a real store, with only the model
 * replaced. Everything above it keeps the cheap fake, because what those tests
 * assert is the ladder, the gate table and the sentinel — not the seam.
 *
 * ── THE PROGRAM USES NOTHING BUT LOCAL SHELL ────────────────────────────────
 * No `gh`. No network. No tracker. `cat`, `cksum`, `bash` and `git`. That is the
 * point of the four-slot design and this file is the proof that the engine
 * carries no GitHub concept anywhere: a project with an `inbox/` directory and a
 * shell script is a first-class citizen.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Loom, TickDecision } from "@telar/engine-client";
import {
  advanceLooms,
  createLoomRuntime,
  runLoomTick,
  type LoomAgent,
  type LoomSessionPort,
  type LoomTickDeps,
} from "../src/loom/dispatch";
import { defaultLoomExec, execGit, gitCommand } from "../src/loom/exec";
import { createLoomRuns } from "../src/loom/run";
import { createLoomSessionPort } from "../src/loom/session";
import { listLooms, loomPaths, readLedger, readProgramDoc, readWatch, programPath } from "../src/loom/store";
import { EngineStore } from "../src/state";
import { defaultGitRunner, type GitRunner } from "../src/worktree";

const PROJECT = "inbox";

const temps: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) {
    try {
      close();
    } catch {
      // A runtime closed twice, or a supervisor that never armed. Teardown must
      // not be the thing that fails a suite.
    }
  }
  // Everything this file makes — the repo, the remote, the engine root and every
  // worktree the engine cut inside it — lives under one temp dir per test, so
  // one removal leaves nothing behind and no `git worktree prune` is owed.
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── the world ───────────────────────────────────────────────────────────────

const EMPTY: TickDecision = { triage: [], dispatch: [], park: [], ask: [], note: "" };

function must(result: { status: number; stdout: string; stderr: string }, what: string): string {
  if (result.status !== 0) throw new Error(`${what} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

type ProgramOptions = {
  /** The gate's exit table, verbatim, so a test can say `0 fail` and mean it. */
  exits?: string;
  onUnknown?: "hold" | "publish";
  neverTouch?: string[];
};

/**
 * The Program, as a human would write it for a project with no tracker.
 *
 * `index.tsv` is `<item>\t<updatedAt>\t<title>`: `parseListed` reads the first
 * two tab-separated columns, and the title rides along for the agent, which
 * reads `list` verbatim anyway.
 */
function programMarkdown(detailLog: string, options: ProgramOptions = {}): string {
  const exits = options.exits ?? "0 pass\n1 fail\n2 unknown";
  const neverTouch = options.neverTouch ?? [".env*"];
  return `# Loom program — ${PROJECT}

## Work source

\`\`\`probe
cat inbox/index.tsv inbox/*.md | cksum
\`\`\`

\`\`\`list
cat inbox/index.tsv
\`\`\`

\`\`\`detail
cat inbox/$ITEM.md && echo $ITEM >> ${detailLog}
\`\`\`

\`\`\`publish
git push origin $BRANCH && echo "published http://localhost/branch/$BRANCH"
\`\`\`

## Gates

\`\`\`gate
bash ./gate.sh
${exits}
\`\`\`

On unknown: ${options.onUnknown ?? "hold"}

## Work

base: main
branch: loom/<slug>
concurrency: 2

## Never touch

${neverTouch.join("\n")}

## When stuck

1 re-read the item and everything said since it was dispatched  [on]
2 run the gate again — it may be flaky                          [on]
3 try a different approach from scratch                         [off]

## Ask me only when

- the gate has failed at every rung above

## When to look

every 300s, backing off to 3600s
`;
}

type WorkerInput = { worktree: string; title: string };

function world(options: ProgramOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-loom-e2e-"));
  temps.push(dir);

  const engineRoot = path.join(dir, "engine");
  const projectRoot = path.join(dir, "project");
  const remote = path.join(dir, "remote.git");
  /** Steers `gate.sh` from OUTSIDE the repo, so moving it neither dirties the
   *  worktree nor needs a commit. */
  const gateExit = path.join(dir, "gate-exit");
  /** `detail`'s own record of having been run. Observable state, not a spy. */
  const detailLog = path.join(dir, "detail.log");

  fs.mkdirSync(engineRoot, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(gateExit, "0\n");
  fs.writeFileSync(detailLog, "");

  const git: GitRunner = defaultGitRunner;

  must(git(dir, ["init", "--bare", "remote.git"]), "git init --bare");

  // The project a person would actually have: an inbox of markdown, a tsv index,
  // and a shell script that decides whether the work is good.
  const write = (relative: string, content: string): void => {
    const target = path.join(projectRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };

  write("inbox/index.tsv", ["a1\t2026-08-20T01:00:00Z\tstrip the prefix", "a2\t2026-08-20T01:05:00Z\trename the widget", "a3\t2026-08-20T01:10:00Z\tfix the docs typo"].join("\n") + "\n");
  write("inbox/a1.md", "# strip the prefix\n\nThe id is sent with an `openai/` prefix and the server rejects it.\n");
  write("inbox/a2.md", "# rename the widget\n\nThe widget is called three different things.\n");
  write("inbox/a3.md", "# fix the docs typo\n\n`recieve` should be `receive`.\n");
  write("gate.sh", `#!/bin/sh\n# The exit code is steered by a file outside the repo so a test can move it.\nexit "$(cat ${gateExit} 2>/dev/null || echo 0)"\n`);
  write("README.md", "# demo\n\nline one\nline two\nline three\n");
  write(path.join(".telar", "loom.md"), programMarkdown(detailLog, options));

  must(git(projectRoot, ["init"]), "git init");
  must(git(projectRoot, ["config", "user.email", "loom@example.invalid"]), "git config email");
  must(git(projectRoot, ["config", "user.name", "Loom E2E"]), "git config name");
  must(git(projectRoot, ["config", "commit.gpgsign", "false"]), "git config gpgsign");
  must(git(projectRoot, ["add", "-A"]), "git add");
  must(git(projectRoot, ["commit", "-m", "chore: the project as it stands"]), "git commit");
  must(git(projectRoot, ["branch", "-M", "main"]), "git branch -M main");
  must(git(projectRoot, ["remote", "add", "origin", remote]), "git remote add");
  must(git(projectRoot, ["push", "-u", "origin", "main"]), "git push -u origin main");

  const paths = loomPaths(engineRoot);
  const clock = { at: new Date("2026-08-20T02:00:00.000Z") };

  // ── the first fake: the orchestrator ────────────────────────────────────
  const agent = { calls: 0, prompts: [] as string[], script: [] as TickDecision[], fallback: EMPTY };
  const loomAgent: LoomAgent = async (prompt) => {
    agent.calls += 1;
    agent.prompts.push(prompt);
    return { ok: true, value: agent.script.shift() ?? agent.fallback };
  };

  // ── the second fake: the worker inside the worktree ─────────────────────
  const commit = (worktree: string, files: Record<string, string>, message: string): void => {
    for (const [file, text] of Object.entries(files)) {
      const target = path.join(worktree, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    must(git(worktree, ["add", "-A"]), "worker git add");
    must(git(worktree, ["commit", "-m", message]), "worker git commit");
  };

  const worker = {
    /** What the stand-in for Claude does in the worktree. */
    run: (input: WorkerInput): void => {
      commit(input.worktree, { "fix.txt": `the worker's change for ${input.title}\n` }, "feat: the change the worker made");
    },
    /** What the session store reports once the worker has let go. */
    after: "done" as "done" | "gone" | "running",
    /**
     * WHETHER THE ENGINE WOULD SEE A WORKER REGISTERED. Every test in this file
     * has one — the stand-in below really does claim the brief and really does
     * commit — so this is `true` as a statement of fact about the world these
     * tests build, not as a stub that agrees with whatever is asked. Turn it
     * off and the dispatch is refused, which is the point of the flag.
     */
    registered: true,
  };

  const sessions = new Map<string, "running" | "done" | "gone">();
  let seq = 0;
  const session: LoomSessionPort = {
    async start(input) {
      const sessionId = `worker-${(seq += 1)}`;
      sessions.set(sessionId, "running");
      await worker.run({ worktree: input.worktree, title: input.title });
      sessions.set(sessionId, worker.after);
      return { sessionId };
    },
    async create() {
      const sessionId = `orchestrator-${(seq += 1)}`;
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

  const deps: LoomTickDeps = {
    paths,
    // REAL. Every command below is a real process against a real filesystem.
    exec: defaultLoomExec,
    git,
    now: () => clock.at,
    projectRoot: () => projectRoot,
    // REAL, off disk, through the real parser — so a test that rewrites
    // `.telar/loom.md` mid-run changes the Program the way a human would.
    readProgram: (projectId) => readProgramDoc(projectId, projectRoot).program,
    readProgramMarkdown: (projectId) => readProgramDoc(projectId, projectRoot).markdown,
    runs: createLoomRuns(() => clock.at),
    agent: loomAgent,
    session,
    engineRoot,
    workersAvailable: () => worker.registered,
  };

  const remoteGit = (args: string[]): { status: number; stdout: string; stderr: string } => git(remote, args);

  return {
    deps,
    paths,
    dir,
    engineRoot,
    projectRoot,
    remote,
    clock,
    agent,
    worker,
    sessions,
    git,
    commit,

    /** A real runtime, composed exactly as `daemon.ts` composes it, with only
     *  the supervisor's timer injected so passes fire by hand. */
    runtime() {
      let sweep: (() => void) | null = null;
      const composed = createLoomRuntime({
        ...deps,
        interval: (fn) => {
          sweep = fn;
          return { clear: () => undefined };
        },
        pollMs: 1,
      });
      closers.push(() => composed.close());
      return {
        ...composed,
        fireSweep: () => {
          if (!sweep) throw new Error("the supervisor never armed its timer");
          sweep();
        },
      };
    },

    looms: (): Loom[] => listLooms(paths, PROJECT).looms,
    only(): Loom {
      const found = listLooms(paths, PROJECT).looms;
      expect(found).toHaveLength(1);
      return found[0] as Loom;
    },
    ledger: () => readLedger(paths, PROJECT),
    watch: () => readWatch(paths, PROJECT),

    remoteSha(ref: string): string {
      return must(remoteGit(["rev-parse", ref]), `remote rev-parse ${ref}`).trim();
    },
    remoteHas(ref: string): boolean {
      return remoteGit(["rev-parse", "--verify", "--quiet", ref]).status === 0;
    },
    remoteShow(ref: string, file: string): string {
      return must(remoteGit(["show", `${ref}:${file}`]), `remote show ${ref}:${file}`);
    },
    remoteBranches(): string[] {
      return must(remoteGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"]), "remote for-each-ref")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    },

    setGateExit(code: number): void {
      fs.writeFileSync(gateExit, `${code}\n`);
    },
    rewriteProgram(options2: ProgramOptions): void {
      fs.writeFileSync(programPath(projectRoot), programMarkdown(detailLog, options2));
    },
    /** Every `detail` invocation this world has ever seen, in order. */
    detailReads(): string[] {
      return fs
        .readFileSync(detailLog, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    },
    changeInbox(item: string, text: string): void {
      fs.appendFileSync(path.join(projectRoot, "inbox", `${item}.md`), text);
    },
    bumpUpdatedAt(item: string, updatedAt: string): void {
      const file = path.join(projectRoot, "inbox", "index.tsv");
      const rewritten = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((line) => {
          const columns = line.split("\t");
          if (columns[0] !== item) return line;
          columns[1] = updatedAt;
          return columns.join("\t");
        })
        .join("\n");
      fs.writeFileSync(file, rewritten);
    },
    /** A human landing a commit on `main` after a worktree was already cut. */
    moveMain(content: string, message: string): void {
      fs.writeFileSync(path.join(projectRoot, "README.md"), content);
      must(git(projectRoot, ["add", "-A"]), "main git add");
      must(git(projectRoot, ["commit", "-m", message]), "main git commit");
      must(git(projectRoot, ["push", "origin", "main"]), "main git push");
    },
  };
}

type World = ReturnType<typeof world>;

// ── decisions the fake orchestrator returns ─────────────────────────────────

function triaged(): TickDecision {
  return {
    triage: [
      { item: "a1", classification: "dispatchable", reason: "self-contained, the root cause is named", ask: "strip the prefix before sending" },
      { item: "a2", classification: "needs-decision", reason: "three names and no ruling on which wins", ask: "pick a name" },
      { item: "a3", classification: "dispatchable", reason: "a one-word typo", ask: "fix the typo" },
    ],
    dispatch: [{ item: "a1", title: "Strip the prefix", branchSlug: "strip-the-prefix", brief: "strip the `openai/` prefix" }],
    park: [],
    ask: [],
    note: "dispatched a1; a2 needs a human",
  };
}

function dispatchOnly(item: string, title: string, slug: string): TickDecision {
  return {
    triage: [{ item, classification: "dispatchable", reason: "small", ask: title }],
    dispatch: [{ item, title, branchSlug: slug, brief: title }],
    park: [],
    ask: [],
    note: `dispatched ${item}`,
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(runtime: { loomWork(): { runs: Array<{ id: string; state: string; error?: string }> } }, runId: string) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const found = runtime.loomWork().runs.find((run) => run.id === runId);
    if (found && found.state !== "running") return found;
    await delay(10);
  }
  throw new Error(`run ${runId} never settled`);
}

/**
 * Wait for the world to say something, WITHOUT ASKING IT TO.
 *
 * `settle` above waits on a run this test started. This waits on a change
 * nothing in the test set in motion — which is the only way to observe an event
 * source that is supposed to work while nobody is looking. Real git, a real
 * gate and a real push run inside the window, so the budget is seconds rather
 * than a tick count.
 */
async function until<T>(what: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + UNTIL_BUDGET_MS;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error(`waited for ${what} and it never happened`);
}

/**
 * How long `until` waits, and it is deliberately well INSIDE the timeout of the
 * test that uses it. The happy path here takes under a second; the number only
 * matters when the property is broken, and a wait that outlives its own test
 * gets killed mid-loop and reports whatever the teardown left behind instead of
 * "the thing you were waiting for never happened".
 */
const UNTIL_BUDGET_MS = 6_000;
const UNTIL_TEST_TIMEOUT_MS = 20_000;

/** One dispatched loom, working, its worker already finished. */
async function dispatchOne(w: World, decision = triaged()): Promise<Loom> {
  w.agent.script = [decision];
  const result = await runLoomTick(w.deps, PROJECT);
  expect(result.dispatched).toHaveLength(1);
  return result.dispatched[0] as Loom;
}

// ── 1 · the happy loop ──────────────────────────────────────────────────────

test("the whole loop: discovered, triaged, dispatched into a real worktree, gated, published", async () => {
  const w = world();
  const runtime = w.runtime();
  const mainBefore = w.remoteSha("main");

  // Tick one: the sentinel's `list` is read, three items are triaged, one is
  // dispatched into a real worktree and the stand-in worker commits there.
  w.agent.script = [triaged(), EMPTY];
  const first = await settle(runtime, runtime.tickLoom(PROJECT).run.id);
  expect(first.state).toBe("done");

  const working = w.only();
  expect(working.state).toBe("working");
  expect(working.item).toBe("a1");
  expect(working.branch).toBe("loom/strip-the-prefix");
  expect(fs.existsSync(working.worktreePath as string)).toBe(true);
  // A real worktree, in the engine's own root, not in the project.
  expect((working.worktreePath as string).startsWith(w.engineRoot)).toBe(true);

  // Tick two reconciles, gates and publishes — no new decision needed, which is
  // §6's point: machinery walks a loom forward, an agent is not woken for it.
  const second = await settle(runtime, runtime.tickLoom(PROJECT).run.id);
  expect(second.state).toBe("done");

  const published = w.only();
  expect(published.state).toBe("published");
  expect(published.gate).toMatchObject({ command: "bash ./gate.sh", exitCode: 0, outcome: "pass" });
  expect(published.publishedUrl).toBe("http://localhost/branch/loom/strip-the-prefix");

  // Observable state, in the remote, not a call count.
  expect(w.remoteHas("loom/strip-the-prefix")).toBe(true);
  expect(w.remoteShow("loom/strip-the-prefix", "fix.txt")).toContain("the worker's change");
  expect(w.remoteSha("main")).toBe(mainBefore);

  // The triage the tick produced is durable and includes the item it did NOT
  // dispatch — §3.10's "a tick that classifies six items correctly was a good
  // tick".
  const triage = JSON.parse(fs.readFileSync(path.join(w.paths.root, PROJECT, "triage.json"), "utf8")) as Record<string, { classification: string }>;
  expect(triage.a2?.classification).toBe("needs-decision");

  const kinds = w.ledger().map((entry) => entry.kind);
  expect(kinds).toContain("dispatch");
  expect(kinds).toContain("gate");
  expect(kinds).toContain("publish");
});

// ── 2 · idle is free ────────────────────────────────────────────────────────

test("idle is free: five quiet sentinel passes cost zero agent calls, and one change costs exactly one wake", async () => {
  // The property whose absence is invisible. A system that woke an agent every
  // interval to discover there was nothing to do would look perfectly correct
  // and cost money forever.
  const w = world();
  const runtime = w.runtime();
  runtime.startLoomWatch(PROJECT);

  const pass = async (): Promise<void> => {
    const target = w.clock.at.getTime();
    runtime.fireSweep();
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const observed = w.watch().lastProbeAt === target && runtime.loomWork().runs.every((run) => run.state !== "running");
      if (observed) return;
      await delay(10);
    }
    throw new Error("the sentinel pass never landed");
  };

  const advance = (seconds: number): void => {
    w.clock.at = new Date(w.clock.at.getTime() + seconds * 1000);
  };

  // A project that has never been probed SHOULD wake — "no fingerprint" is not
  // "unchanged". That is one agent call, and it is the last one.
  await pass();
  expect(w.agent.calls).toBe(1);
  const readsAfterFirstTick = w.detailReads().length;

  for (let quiet = 0; quiet < 5; quiet += 1) {
    advance(7200);
    await pass();
  }
  expect(w.agent.calls).toBe(1);
  expect(w.detailReads()).toHaveLength(readsAfterFirstTick);
  expect(w.watch().quietChecks).toBe(5);
  // And the free passes bought a longer interval rather than spending anything.
  expect(w.watch().intervalSec).toBeGreaterThan(300);

  // Now something actually happens.
  w.changeInbox("a1", "\nA new line nobody had seen.\n");
  advance(7200);
  await pass();
  expect(w.agent.calls).toBe(2);
  expect(w.watch().quietChecks).toBe(0);
});

// ── 3 · exit 2 holds, and the same exit 2 publishes when the policy says so ──

test("exit 2 declared `unknown` holds under `on unknown: hold`, and publishes under `on unknown: publish`", async () => {
  const w = world();
  w.setGateExit(2);

  const held = await dispatchOne(w);
  await advanceLooms(w.deps, PROJECT);

  const stuck = w.looms().find((loom) => loom.id === held.id) as Loom;
  expect(stuck.state).toBe("stuck");
  expect(stuck.gate).toMatchObject({ exitCode: 2, outcome: "unknown" });
  expect(stuck.parkedReason).toContain("could not be verified");
  expect(w.remoteHas("loom/strip-the-prefix")).toBe(false);

  // Same exit code, same gate, different policy — declared by the human in the
  // Program, never inferred.
  w.rewriteProgram({ onUnknown: "publish" });
  const second = await dispatchOne(w, dispatchOnly("a3", "Fix the docs typo", "fix-the-docs-typo"));
  await advanceLooms(w.deps, PROJECT);

  const publishedLoom = w.looms().find((loom) => loom.id === second.id) as Loom;
  expect(publishedLoom.state).toBe("published");
  expect(publishedLoom.gate).toMatchObject({ exitCode: 2, outcome: "unknown" });
  expect(w.remoteHas("loom/fix-the-docs-typo")).toBe(true);
});

test("zero is not a green light either: a Program declaring `0 fail` does not publish on exit 0", async () => {
  const w = world({ exits: "0 fail\n1 pass" });
  w.setGateExit(0);

  const loom = await dispatchOne(w);
  await advanceLooms(w.deps, PROJECT);

  const settled = w.looms().find((candidate) => candidate.id === loom.id) as Loom;
  expect(settled.state).toBe("stuck");
  expect(settled.gate).toMatchObject({ exitCode: 0, outcome: "fail" });
  expect(w.remoteHas("loom/strip-the-prefix")).toBe(false);
});

// ── 4 · an undeclared exit code ─────────────────────────────────────────────

test("an exit code the Program never declares is `unknown`, never `fail`", async () => {
  const w = world();
  w.setGateExit(7);

  const loom = await dispatchOne(w);
  await advanceLooms(w.deps, PROJECT);

  const settled = w.looms().find((candidate) => candidate.id === loom.id) as Loom;
  expect(settled.state).toBe("stuck");
  expect(settled.gate).toMatchObject({ exitCode: 7, outcome: "unknown" });
  expect(settled.parkedReason).toContain("does not declare");
  // The distinction is load-bearing: `fail` would say the project said no. It
  // never said anything about 7.
  expect(settled.parkedReason).not.toContain("the gate failed");
  expect(w.remoteHas("loom/strip-the-prefix")).toBe(false);
});

// ── 5 · boundaries are the harness's job ────────────────────────────────────

test("a worker that commits a never-touch path parks the loom; the harness enforces it, not the worker", async () => {
  const w = world();
  w.worker.run = (input) => {
    // A plausible change AND a forbidden one, which is how this actually
    // happens: nobody commits only a `.env`.
    w.commit(input.worktree, { "fix.txt": "a real change\n", ".env.local": "SECRET=hunter2\n" }, "feat: change, plus a secret nobody asked for");
  };

  const loom = await dispatchOne(w);
  await advanceLooms(w.deps, PROJECT);

  const parked = w.looms().find((candidate) => candidate.id === loom.id) as Loom;
  expect(parked.state).toBe("parked");
  expect(parked.parkedReason).toContain(".env.local");
  expect(parked.parkedReason).toContain("never-touch");
  expect(w.remoteHas("loom/strip-the-prefix")).toBe(false);
  // Parked is terminal: this is not retried, because a retry would be a second
  // chance to commit the same secret.
  await advanceLooms(w.deps, PROJECT);
  expect((w.looms().find((candidate) => candidate.id === loom.id) as Loom).state).toBe("parked");
});

// ── 6 · a rebase conflict ───────────────────────────────────────────────────

test("a rebase conflict against a base that moved parks at rung 1 with the conflict as the reason", async () => {
  const w = world();
  let attempt = 0;
  w.worker.run = (input) => {
    attempt += 1;
    w.commit(input.worktree, { "README.md": `# demo\n\nline one\nthe worker's second line (attempt ${attempt})\nline three\n` }, "feat: the worker's take on line two");
  };

  const loom = await dispatchOne(w);
  // A human lands a conflicting commit on `main` AFTER the worktree was cut —
  // exactly the case §8 decided to rebase for.
  w.moveMain("# demo\n\nline one\na human's second line\nline three\n", "fix: a human's take on line two");

  await advanceLooms(w.deps, PROJECT);

  const stuck = w.looms().find((candidate) => candidate.id === loom.id) as Loom;
  expect(stuck.state).toBe("stuck");
  expect(stuck.parkedReason).toContain("conflict");
  expect(stuck.parkedReason).toContain("README.md");
  expect(w.remoteHas("loom/strip-the-prefix")).toBe(false);
  // A conflicting branch genuinely needs a decision, so it enters the ladder
  // rather than being retried blind.
  expect(stuck.ladderRung).toBe(0);

  await advanceLooms(w.deps, PROJECT);
  const onRungOne = w.looms().find((candidate) => candidate.id === loom.id) as Loom;
  expect(onRungOne.ladderRung).toBe(1);
  expect(onRungOne.attempts).toBe(1);

  // And the aborted rebase left the worktree usable rather than mid-rebase.
  expect(w.git(stuck.worktreePath as string, ["status", "--porcelain"]).stdout.trim()).toBe("");
});

// ── 7 · nothing is merged, base is never pushed to ──────────────────────────

test("across a whole successful run nothing is merged and `main` in the remote never moves", async () => {
  const w = world();
  const mainBefore = w.remoteSha("main");
  const countBefore = must(w.git(w.remote, ["rev-list", "--count", "main"]), "count main").trim();

  const loom = await dispatchOne(w);
  await advanceLooms(w.deps, PROJECT);
  expect((w.looms().find((candidate) => candidate.id === loom.id) as Loom).state).toBe("published");

  expect(w.remoteSha("main")).toBe(mainBefore);
  expect(must(w.git(w.remote, ["rev-list", "--count", "main"]), "count main").trim()).toBe(countBefore);
  // The branch exists and is NOT an ancestor of main — nobody merged it.
  expect(w.remoteHas("loom/strip-the-prefix")).toBe(true);
  expect(w.git(w.remote, ["merge-base", "--is-ancestor", "loom/strip-the-prefix", "main"]).status).not.toBe(0);
  expect(w.remoteBranches().sort()).toEqual(["loom/strip-the-prefix", "main"]);
});

// ── 8 · statelessness ───────────────────────────────────────────────────────

test("a fresh runtime over the same engine root reaches the same conclusions from disk alone", async () => {
  const w = world();
  const loom = await dispatchOne(w);
  expect(w.only().state).toBe("working");

  // Throw the runtime away. Build a new one over the same engine root with a
  // session port that has never heard of this worker — which is precisely what
  // a daemon restart looks like. Nothing is remembered; the worktree's commits
  // and the loom file on disk are the whole input.
  const reborn: LoomTickDeps = {
    ...w.deps,
    runs: createLoomRuns(w.deps.now),
    session: {
      async start() {
        throw new Error("a reconciling runtime must not need to start a session");
      },
      async create() {
        throw new Error("a reconciling runtime must not need to create a session");
      },
      async status() {
        return "gone" as const;
      },
      async stop() {
        return undefined;
      },
    } satisfies LoomSessionPort,
  };
  const runtime = createLoomRuntime(reborn);
  closers.push(() => runtime.close());

  await advanceLooms(reborn, PROJECT);

  const published = w.looms().find((candidate) => candidate.id === loom.id) as Loom;
  expect(published.state).toBe("published");
  expect(w.remoteHas("loom/strip-the-prefix")).toBe(true);
});

// ── 9 · a killed worker vs a running one ────────────────────────────────────

test("a worker that vanished without committing goes `stuck`; a worker still running stays `working`", async () => {
  const w = world();

  // Still running: nothing to conclude, and the pass must return rather than
  // block on it.
  w.worker.after = "running";
  const live = await dispatchOne(w);
  await advanceLooms(w.deps, PROJECT);
  const stillWorking = w.looms().find((candidate) => candidate.id === live.id) as Loom;
  expect(stillWorking.state).toBe("working");
  expect(w.remoteHas("loom/strip-the-prefix")).toBe(false);

  // Killed, with nothing in the worktree: there is nothing to gate, and calling
  // that `published` or leaving it `working` forever are the two failure modes.
  w.worker.after = "gone";
  w.worker.run = () => undefined;
  const killed = await dispatchOne(w, dispatchOnly("a3", "Fix the docs typo", "fix-the-docs-typo"));
  await advanceLooms(w.deps, PROJECT);
  const gone = w.looms().find((candidate) => candidate.id === killed.id) as Loom;
  expect(gone.state).toBe("stuck");
  expect(gone.parkedReason).toContain("without committing");
  expect(w.remoteHas("loom/fix-the-docs-typo")).toBe(false);
});

// ── 10 · the triage cache ───────────────────────────────────────────────────

test("triage is cached and refreshed on `updatedAt`: two unchanged ticks re-read nothing, one bump re-reads exactly one", async () => {
  // The claim that makes "read the whole thread" affordable. Without it the
  // expensive part of a tick is paid every five minutes forever.
  const w = world();
  const classifyAll = (): TickDecision => ({
    triage: [
      { item: "a1", classification: "never", reason: "not agent work", ask: "-" },
      { item: "a2", classification: "never", reason: "not agent work", ask: "-" },
      { item: "a3", classification: "never", reason: "not agent work", ask: "-" },
    ],
    dispatch: [],
    park: [],
    ask: [],
    note: "classified three",
  });

  w.agent.script = [classifyAll(), EMPTY];
  await runLoomTick(w.deps, PROJECT);
  expect(w.detailReads().sort()).toEqual(["a1", "a2", "a3"]);

  await runLoomTick(w.deps, PROJECT);
  expect(w.detailReads()).toHaveLength(3);

  w.bumpUpdatedAt("a2", "2026-08-20T09:99:99Z");
  w.agent.script = [
    { triage: [{ item: "a2", classification: "never", reason: "still not agent work", ask: "-" }], dispatch: [], park: [], ask: [], note: "re-read a2" },
  ];
  await runLoomTick(w.deps, PROJECT);

  const reads = w.detailReads();
  expect(reads).toHaveLength(4);
  expect(reads[3]).toBe("a2");
});

// ── 11 · the loop, through the REAL session port ────────────────────────────

/**
 * THE SEAM THAT WAS FAKED, RUN FOR REAL.
 *
 * Every test above this line drives a `LoomSessionPort` written in this file —
 * and that fake is why the loop's central bug survived to be shipped. The real
 * port called `EngineStore.createSession({ envMode: "worktree" })`, which cut a
 * SECOND checkout on `telar/<sessionId>` off project HEAD and gave the worker
 * that one. The Program's `setup` ran where nobody worked, the branch `publish`
 * pushes never received a commit, the gate counted commits in the loom's
 * worktree and found none — so a finished worker read as a worker that did
 * nothing and the loom sat `stuck` at rung 1 forever — and each loom cost two
 * checkouts against a ceiling derived from one. Nothing threw, and every test
 * passed, because the port was faked at exactly the broken joint.
 *
 * WHAT IS STILL NOT REAL, STATED PLAINLY: the model. `createLoomSessionPort`
 * queues a turn on a real `EngineStore` and a real provider worker would claim
 * it; here `pumpWorker` claims it through the SAME store API a worker process
 * uses over HTTP (`claimTurn` → `markRunning` → `completeTurn`) and writes a
 * commit instead of asking Claude. So the session store, the queue, the turn
 * lifecycle, the workspace the worker is handed, the worktree, the gate, the
 * rebase and the push are all real; only the text of the diff is scripted.
 * That is the whole of the distance left between this test and an overnight
 * run, and it is the distance a rate limit and a bill make mandatory.
 */
function realSessions(w: World): { store: EngineStore; pumpWorker: () => number } {
  const store = new EngineStore(w.engineRoot, () => w.clock.at.getTime(), { git: w.git });
  store.registerProject({ id: PROJECT, name: "Inbox", root: w.projectRoot });
  w.deps.session = createLoomSessionPort({ store });

  return {
    store,
    /**
     * THE WORKER PROCESS, STOOD IN FOR — through the store's own worker API, so
     * what it is handed is what a real one is handed: `workspace.path`, read off
     * the session document rather than passed in by this test. If the session
     * ever points somewhere other than the loom's worktree again, the commit
     * lands there and the gate finds nothing, exactly as it did.
     */
    pumpWorker: () => {
      let worked = 0;
      for (const session of store.listSessions(PROJECT)) {
        if (session.state === "archived") continue;
        const claimed = store.claimTurn(session.id, "worker_e2e");
        if (!claimed?.claim) continue;
        store.markRunning(session.id, claimed.runId, claimed.claim.token);
        w.commit(
          store.getSession(session.id).workspace.path,
          { "fix.txt": `the worker's change for ${session.title}\n` },
          "feat: the change the worker made",
        );
        store.completeTurn(session.id, claimed.runId, claimed.claim.token, { text: "done" });
        worked += 1;
      }
      return worked;
    },
  };
}

test("the real session port: the worker commits in the loom's own worktree, and the loom reaches published", async () => {
  const w = world();
  const { store, pumpWorker } = realSessions(w);
  const mainBefore = w.remoteSha("main");

  const loom = await dispatchOne(w);
  expect(loom.state).toBe("working");
  expect(loom.branch).toBe("loom/strip-the-prefix");

  /**
   * ONE CHECKOUT AND ONE BRANCH FOR THIS LOOM. The old behaviour left two
   * worktrees and a `telar/<sessionId>` branch behind per dispatch — the RAM
   * ceiling the Program's `concurrency` is chosen against, wrong by a factor of
   * two, silently.
   */
  expect(worktrees(w)).toEqual([real(w.projectRoot), real(loom.worktreePath as string)]);
  expect(branches(w)).toEqual(["loom/strip-the-prefix", "main"]);

  // THE SESSION IS POINTED AT THE LOOM'S WORKTREE, not at one of its own.
  const session = store.getSession(loom.sessionId as string);
  expect(session.envMode).toBe("worktree");
  if (session.workspace.mode !== "worktree") throw new Error("unreachable");
  expect(real(session.workspace.path)).toBe(real(loom.worktreePath as string));
  expect(session.workspace.branch).toBe("loom/strip-the-prefix");
  expect(session.workspace.adopted).toBe(true);

  // The brief was queued and nothing else was.
  expect(store.turns(session.id)).toHaveLength(1);
  expect(store.turns(session.id)[0]?.input).toContain("strip the `openai/` prefix");

  // A LIVE WORKER IS NOT GATED MID-EDIT: the turn is claimed but unsettled, so
  // the pass must leave the loom alone.
  const claimed = store.claimTurn(session.id, "worker_probe");
  if (!claimed?.claim) throw new Error("the store did not hand out a claim");
  store.markRunning(session.id, claimed.runId, claimed.claim.token);
  await advanceLooms(w.deps, PROJECT);
  expect(w.only().state).toBe("working");
  store.stopTurn(session.id);

  // Now the work itself, committed through the store's worker API.
  w.commit(store.getSession(session.id).workspace.path, { "fix.txt": "the worker's change\n" }, "feat: the change the worker made");

  /**
   * THE COMMIT LANDED ON THE PROGRAM'S BRANCH IN THE LOOM'S WORKTREE — the
   * assertion the whole file exists for. Not on `telar/<sessionId>`, and not in
   * a second checkout: there is no second checkout to land in.
   */
  const log = must(w.git(loom.worktreePath as string, ["log", "--format=%s", "main..HEAD"]), "worktree log");
  expect(log.trim()).toBe("feat: the change the worker made");
  expect(branches(w)).toEqual(["loom/strip-the-prefix", "main"]);

  /**
   * AND THE LOOM GOES `gating`, NOT `stuck`. This is the failure the bug
   * produced, inverted: `countCommits` runs `rev-list main..HEAD` in the loom's
   * worktree, and it used to find zero because the worker had been editing
   * somewhere else entirely.
   */
  await advanceLooms(w.deps, PROJECT);
  const published = w.only();
  expect(published.state).toBe("published");
  expect(published.parkedReason).toBeUndefined();
  expect(w.ledger().some((entry) => entry.summary.includes("the worker finished with 1 commit(s); gating"))).toBe(true);

  // Observable state in the remote — the branch the PROGRAM named, carrying the
  // work, with `main` untouched.
  expect(w.remoteHas("loom/strip-the-prefix")).toBe(true);
  expect(w.remoteShow("loom/strip-the-prefix", "fix.txt")).toContain("the worker's change");
  expect(w.remoteSha("main")).toBe(mainBefore);

  /**
   * ARCHIVING THE WORKER DOES NOT REAP THE LOOM'S CHECKOUT. Whoever cut it owns
   * it: a session taking it back would be the same silent failure one step
   * later, deleting the night's output between the worker ending and the gate
   * reading it.
   */
  store.archiveSession(session.id);
  expect(fs.existsSync(loom.worktreePath as string)).toBe(true);
  expect(worktrees(w)).toContain(real(loom.worktreePath as string));
  expect(branches(w)).toContain("loom/strip-the-prefix");
  expect(pumpWorker).toBeInstanceOf(Function);
});

test("the real session port, two looms at once: two workers, two worktrees, two branches, no crossing", async () => {
  /**
   * `concurrency: 2` IS A CLAIM ABOUT ISOLATION and this is the only test that
   * can check it against real sessions. Two workers in one checkout produce a
   * diff nobody can attribute — and two sessions that each cut their own
   * worktree while the looms cut two more produce four, which is how a ceiling
   * chosen for RAM is exceeded without anybody noticing.
   */
  const w = world();
  const { store, pumpWorker } = realSessions(w);

  w.agent.script = [
    {
      triage: [
        { item: "a1", classification: "dispatchable", reason: "small", ask: "strip the prefix" },
        { item: "a3", classification: "dispatchable", reason: "small", ask: "fix the typo" },
      ],
      dispatch: [
        { item: "a1", title: "Strip the prefix", branchSlug: "strip-the-prefix", brief: "strip the `openai/` prefix" },
        { item: "a3", title: "Fix the docs typo", branchSlug: "fix-the-docs-typo", brief: "fix the typo" },
      ],
      park: [],
      ask: [],
      note: "two at once",
    },
  ];
  const result = await runLoomTick(w.deps, PROJECT);
  expect(result.dispatched).toHaveLength(2);

  // TWO LOOMS, TWO CHECKOUTS, TWO BRANCHES. Not four, and not one shared one.
  const paths = result.dispatched.map((loom) => real(loom.worktreePath as string));
  expect(new Set(paths).size).toBe(2);
  expect(worktrees(w).sort()).toEqual([real(w.projectRoot), ...paths].sort());
  expect(branches(w)).toEqual(["loom/fix-the-docs-typo", "loom/strip-the-prefix", "main"]);

  expect(pumpWorker()).toBe(2);

  await advanceLooms(w.deps, PROJECT);
  const finished = w.looms();
  expect(finished.map((loom) => loom.state)).toEqual(["published", "published"]);

  // Each branch carries its own worker's commit and nothing of the other's.
  for (const loom of finished) {
    const session = store.getSession(loom.sessionId as string);
    expect(real(session.workspace.path)).toBe(real(loom.worktreePath as string));
    expect(w.remoteShow(loom.branch as string, "fix.txt")).toContain(loom.title);
  }
});

// ── 11b · nobody fires the second tick ──────────────────────────────────────

/**
 * THE TEST THAT WOULD HAVE CAUGHT THE STALL, AND THE ONLY KIND THAT COULD.
 *
 * Standing the engine up for real against a throwaway repo found this in one
 * run: a tick triaged, dispatched `a1` into a worktree, a real worker session
 * committed `fix: drop openai/ prefix from model id`, its turn went
 * `completed` in `queue.json` — and the loom stayed `working`. Indefinitely.
 * A second tick fired BY HAND went straight through: rebase, gate `pass`,
 * published, the branch really on the remote. Every stage of the machinery
 * worked. Nothing noticed the worker had finished.
 *
 * Every suite in this repo missed it because every suite fires the next tick
 * itself — `await advanceLooms(...)` on the line after the worker commits, which
 * is the human hand the bug was hiding behind. So the shape of this test is a
 * negative: after the worker settles, NOTHING in it touches the loom machinery
 * again. No `advanceLooms`, no `runLoomTick`, no `fireSweep`, no
 * `supervisor.pass`. The supervisor's interval is injected as one that captures
 * its callback and never calls it, so there is no timer to reach the result by
 * either.
 *
 * AND THE WATCH IS PAUSED, on purpose, because that is the version with no
 * fallback at all. With the watch running the old code was merely late — up to
 * a full `intervalSec`, longer once the backoff had stretched. With it paused
 * there was no second look coming, ever: a finished worker, a clean commit and
 * a worktree held open by a loom nothing would ever gate. Pausing means "stop
 * taking on new work"; it cannot mean "abandon the work already running".
 */
test("a worker settling publishes on its own: the watch is paused, and nothing in this test fires a second tick", async () => {
  const w = world();
  // The real port over a real store FIRST, so the runtime composed below
  // subscribes to the store the worker actually settles its turn in.
  const { store, pumpWorker } = realSessions(w);
  const runtime = w.runtime();
  const mainBefore = w.remoteSha("main");

  // A human turned the watch on and then paused it — started, then stopped, so
  // the record carries a watch that was deliberately switched off rather than
  // one that was never switched on.
  runtime.startLoomWatch(PROJECT);
  const loom = await dispatchOne(w);
  expect(loom.state).toBe("working");
  runtime.stopLoomWatch(PROJECT);
  expect(w.watch().running).toBe(false);

  const spentOnDispatch = w.agent.calls;
  expect(spentOnDispatch).toBe(1);

  /**
   * THE WORKER, THROUGH THE STORE'S OWN WORKER API — `claimTurn` →
   * `markRunning` → a real commit in the workspace the session hands it →
   * `completeTurn`. The same four calls a worker process makes over HTTP, and
   * `completeTurn` is where the journal records `turn.completed`. That record
   * is the entire input to what follows.
   */
  expect(pumpWorker()).toBe(1);
  expect(store.turns(loom.sessionId as string).every((turn) => turn.state === "completed")).toBe(true);

  // ── from here to the end of the test, nothing fires anything ─────────────
  const published = await until("the loom to publish on its own", () => {
    const found = w.only();
    return found.state === "published" ? found : undefined;
  });

  expect(published.parkedReason).toBeUndefined();
  expect(published.gate?.outcome).toBe("pass");
  // OBSERVABLE STATE IN THE REMOTE. The branch really arrived, carrying the
  // worker's commit, and `main` never moved.
  expect(w.remoteHas("loom/strip-the-prefix")).toBe(true);
  expect(w.remoteShow("loom/strip-the-prefix", "fix.txt")).toContain("the worker's change");
  expect(w.remoteSha("main")).toBe(mainBefore);

  // NO AGENT WAS SPENT GETTING HERE. Reconcile, rebase, gate and publish are
  // machinery; there is no decision in that sequence to buy.
  expect(w.agent.calls).toBe(spentOnDispatch);

  // AND THE WATCH IS STILL OFF. Advancing in-flight work did not quietly
  // restart the thing the human switched off.
  expect(w.watch().running).toBe(false);

  // The ledger tells the story without anybody having asked for it.
  const summaries = w.ledger().map((entry) => entry.summary);
  expect(summaries.some((line) => line.includes("the worker finished with 1 commit(s); gating"))).toBe(true);
  expect(summaries.some((line) => line.startsWith("published"))).toBe(true);
}, UNTIL_TEST_TIMEOUT_MS);

// ── 12 · the loom's own git, through a real shell ───────────────────────────

/**
 * THE INJECTION SURFACE, AGAINST A REAL SHELL AND A REAL GIT.
 *
 * `execGit` runs git through `LoomExec`, which is `sh -c`. Every argument it
 * passes is attacker-adjacent: a branch prefix comes out of a Program a human
 * wrote, a ref comes back out of git's own output. If any of it were pasted into
 * the command string, `"; touch pwned; echo "` in a branch name would be a
 * command the daemon runs at 3am with the user's credentials.
 *
 * WHAT IS PINNED IS THE RULE — the value arrives at git as ONE literal argument
 * and nothing else executes — not the environment trick that currently achieves
 * it. `git config --default <value> --get <missing key>` echoes the value back
 * verbatim, so git itself reports what it received, which is the only witness
 * worth having here.
 */
test("a git argument that is a shell payload reaches git as one literal value and runs nothing", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-loom-argv-"));
  temps.push(directory);

  const payloads = [
    // Quote-escape into a second command.
    '"; touch pwned; echo "',
    // Substitution, in all three spellings a shell honours.
    "$(touch pwned) `touch pwned` ${IFS}",
    // The mechanism's own env slot, which must not be dereferenced a second time.
    "$LOOM_ARG0 and $LOOM_TITLE",
    // A ref name with a newline in it, which is what breaks naive quoting: pasted
    // into the string, the second line is a command in its own right. (`touch`
    // rather than anything destructive on purpose — when this test is mutated to
    // check that it can fail, the payload actually runs.)
    "main\ntouch pwned",
  ];

  for (const payload of payloads) {
    const run = await execGit(defaultLoomExec, directory, ["config", "--default", payload, "--get", "telar.loom.absent"]);
    expect(run.status).toBe(0);
    expect(run.timedOut).toBe(false);
    // ONE argument, byte for byte. Split into two, and this is `"; touch` alone.
    expect(run.stdout.replace(/\n$/, "")).toBe(payload);
  }

  expect(fs.existsSync(path.join(directory, "pwned"))).toBe(false);
  // Nothing at all was created beside it either.
  expect(fs.readdirSync(directory)).toEqual([]);

  // And the command string carries no data to hide a payload in: `git`, then one
  // opaque token per argument.
  const built = gitCommand(["rebase", 'origin/main"; touch pwned; echo "']);
  expect(built.command).toBe('git "$LOOM_ARG0" "$LOOM_ARG1"');
  expect(built.command).not.toContain("pwned");
  expect(Object.values(built.env)).toContain('origin/main"; touch pwned; echo "');
});

/**
 * The same claim where it actually bites: a branch prefix a human could plausibly
 * fat-finger into the Program, carried through the real gate. `git` refuses the
 * name — which is the correct outcome — and the point is that it refuses it as a
 * REF, having never been asked to run it.
 */
test("a branch name full of shell metacharacters fails as a ref rather than executing", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-loom-argv-ref-"));
  temps.push(directory);
  must(defaultGitRunner(directory, ["init", "--initial-branch=main"]), "git init");

  const run = await execGit(defaultLoomExec, directory, ["rev-parse", "--verify", "--quiet", "$(touch pwned)x"]);
  expect(run.status).not.toBe(0);
  expect(fs.existsSync(path.join(directory, "pwned"))).toBe(false);
});

/** Symlink-resolved, because macOS spells one temp directory two ways and git
 *  and the store do not always pick the same one. */
function real(input: string): string {
  return fs.realpathSync.native(input);
}

function worktrees(w: World): string[] {
  return must(w.git(w.projectRoot, ["worktree", "list", "--porcelain"]), "git worktree list")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => real(line.slice("worktree ".length).trim()));
}

function branches(w: World): string[] {
  return must(w.git(w.projectRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]), "git for-each-ref")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}
