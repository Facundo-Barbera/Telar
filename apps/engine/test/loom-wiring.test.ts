/**
 * THE TWO EXPENSIVE PORTS, WIRED — `createLoomAgent` and `createLoomSessionPort`,
 * the real things that replaced `daemon.ts`'s two refusing placeholders.
 *
 * NOTHING HERE REACHES A PROVIDER, SHELLS OUT, OR SPENDS RATE LIMIT. That is
 * stated policy (`daemon.ts:51-85`) and it is met the way the code was built to
 * be met rather than by avoiding the code: `structuredAgent` takes `loadSdk` and
 * `resolveExecutable` in its third parameter, so the agent runs its ENTIRE
 * control flow — the wall, the emit, the parse, every failure branch — against a
 * fake SDK in this process. The sentinel's timer is injected, so the restart
 * tests fire a sweep by hand instead of waiting on a clock.
 *
 * GIT IS REAL HERE, AND IT USED NOT TO BE. `EngineStore` takes a `GitRunner`,
 * and these tests handed it one that answered every command with success and
 * touched no disk — which is exactly what let the session port ship cutting a
 * SECOND worktree that no worker ever ran in. A fake that cannot tell one
 * checkout from another cannot be asked which one the worker got. Git is local,
 * deterministic and free; the network, a real Claude session and somebody's
 * rate limit remain forbidden and remain absent.
 *
 * ── WHAT IS ACTUALLY UNDER TEST ─────────────────────────────────────────────
 * Four claims, and each one fails quietly if it is wrong:
 *
 *   1. THE ORCHESTRATOR CANNOT RUN COMMANDS. It reads and decides; machinery
 *      runs `probe`/`list`/`detail`. A `Bash` that leaked into the tool list
 *      would not fail anything — it would just mean the agent could run the
 *      gate, push, or merge, and nothing would say so until it did.
 *   2. `status()` TELLS A KILLED WORKER FROM A LIVE ONE. The orchestrator dies
 *      every tick, so this is the whole of done-detection. Wrong one way and a
 *      finished worker is waited on forever; wrong the other and a live one is
 *      gated mid-edit and its item dispatched twice.
 *   3. A WORKER RUNS IN THE LOOM'S OWN CHECKOUT — the one whose branch the
 *      Program named and in which `setup` ran — and that checkout survives the
 *      session being archived. Both were false, and both were silent: `setup`
 *      ran where nobody worked, the branch `publish` pushes never received a
 *      commit, and the gate counted commits in an empty worktree.
 *   4. A WATCH SURVIVES A RESTART — including the backoff it earned. `running`
 *      is persisted, so a daemon that comes back up without re-arming the
 *      sentinel reports "watching" while probing zero times.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { assertWall, NEVER_TOOLS, READ_ONLY_TOOLS, type ClaudeAgentSdk } from "../src/agent";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { createLoomAgent } from "../src/loom/agent";
import { createLoomSessionPort } from "../src/loom/session";
import type { LoomAgent } from "../src/loom/dispatch";
import type { LoomExec } from "../src/loom/exec";
import { fingerprintFrom } from "../src/loom/sentinel";
import { loomPaths, readSentinel, readWatch, writeSentinel, writeWatch } from "../src/loom/store";
import { EngineStore } from "../src/state";
import { createSessionWorktree, defaultGitRunner, type GitRunner } from "../src/worktree";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const AT = 1_760_000_000_000;

function scratch(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

// ── the agent, against a fake SDK ───────────────────────────────────────────

type SdkCall = { prompt?: string; options?: Record<string, unknown> };

/**
 * The narrow slice of the SDK a structured call uses, faked — and RECORDING the
 * options it was handed, because half of what this file asserts is what the
 * agent asked for rather than what it got back.
 *
 * `answer()` is called inside the iteration, so a throwing one fails exactly
 * where a provider error would: inside `structuredAgent`'s own try.
 */
function fakeSdk(answer: () => unknown, recorded: SdkCall): ClaudeAgentSdk {
  const handlers = new Map<string, (input: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>>();
  return {
    tool(name, _description, _shape, handler) {
      handlers.set(name, handler);
      return { name };
    },
    createSdkMcpServer(input) {
      return { name: input.name, tools: input.tools };
    },
    query(input) {
      recorded.prompt = input.prompt;
      recorded.options = input.options;
      return (async function* () {
        const value = answer();
        // `undefined` is a model that stopped talking without emitting — the
        // refusal case, and deliberately not the same as an empty decision.
        if (value !== undefined) await handlers.get("emit_result")?.(value);
        yield { type: "result", usage: { input_tokens: 10, output_tokens: 4 } } as Record<string, unknown>;
      })();
    },
  };
}

function agentWith(answer: () => unknown): { agent: LoomAgent; call: SdkCall } {
  const call: SdkCall = {};
  const agent = createLoomAgent({
    loadSdk: async () => fakeSdk(answer, call),
    // Never resolved for real: the machine running this suite is not required
    // to have Claude Code installed.
    resolveExecutable: () => "/nowhere/claude",
    now: () => AT,
  });
  return { agent, call };
}

const DECISION = { triage: [], dispatch: [], park: [], ask: [], note: "nothing changed" };

test("the orchestrator is handed no Bash, no Write and no Edit — the wall is what says so", async () => {
  /**
   * §16's tick reads and decides; `probe`, `list` and `detail` are run by
   * machinery and pasted into the prompt. An orchestrator with a shell could run
   * the gate, push, or merge — every boundary the Program declares would become
   * a request rather than a wall.
   */
  const { agent, call } = agentWith(() => DECISION);
  const answer = await agent("decide", { projectId: "project_one", cwd: "/tmp/checkout" });

  expect(answer).toEqual({ ok: true, value: DECISION });
  // AVAILABILITY, approval and deny — the three layers `agent.ts` keeps
  // travelling together, asserted together.
  expect(call.options?.tools).toEqual([...READ_ONLY_TOOLS]);
  expect(call.options?.allowedTools).toEqual([...READ_ONLY_TOOLS, "mcp__out__emit_result"]);
  expect(call.options?.disallowedTools).toEqual([...NEVER_TOOLS]);
  for (const forbidden of ["Bash", "Write", "Edit"]) {
    expect(call.options?.tools).not.toContain(forbidden);
    expect(call.options?.allowedTools).not.toContain(forbidden);
    expect(call.options?.disallowedTools).toContain(forbidden);
  }
  // The project's own checkout, so `Read`/`Grep` can answer "does the file this
  // item names still exist" instead of triaging from a title.
  expect(call.options?.cwd).toBe("/tmp/checkout");

  /**
   * AND THE WALL IS WHAT ENFORCES IT, not the absence of an option. A future
   * caller that asks for `Bash` gets it dropped rather than granted, which is
   * the property that keeps this true when someone widens the loom's tools.
   */
  expect(assertWall(["Read", "Bash"])).toMatchObject({ tools: ["Read"], dropped: ["Bash"] });
});

test("a decision in the wrong shape comes back as a sentence, not a throw", async () => {
  // The SDK validates against the schema it was given; this fake calls the
  // handler directly, which is exactly the "it emitted something that does not
  // fit" path `structuredAgent` re-parses for.
  const { agent } = agentWith(() => ({ triage: [{ item: 7, classification: "dispatchable", reason: "" }] }));
  const answer = await agent("decide", { projectId: "project_one", cwd: "/tmp/checkout" });

  expect(answer.ok).toBe(false);
  if (answer.ok) throw new Error("unreachable");
  // The failing PATH is the actionable part and survives into the ledger.
  expect(answer.reason).toContain("triage.0.item");
  expect(answer.reason).toContain("shape");
  expect(answer.reason).toContain("Nothing was dispatched");
  // Not a rate limit, and it must not read like one.
  expect(answer.reason).not.toContain("rate limited");
});

test("a rate limit says so, and says something different from a refusal", async () => {
  /**
   * THE DISTINCTION IS THE POINT. A rate limit is about the ACCOUNT — nothing
   * is wrong with the Program and the next tick will work — while a model that
   * stopped without deciding is about THIS call. An operator reading the ledger
   * at 8am goes to two different places, so they get two different sentences.
   */
  const limited = await agentWith(() => {
    throw new Error("429 too many requests; retry-after: 60");
  }).agent("decide", { projectId: "project_one", cwd: "/tmp/checkout" });
  expect(limited.ok).toBe(false);
  if (limited.ok) throw new Error("unreachable");
  expect(limited.reason).toContain("rate limited");
  expect(limited.reason).toContain("not because anything is wrong with this project's Program");
  expect(limited.reason).toContain("will accept work again at");

  const refused = await agentWith(() => undefined).agent("decide", { projectId: "project_one", cwd: "/tmp/checkout" });
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("unreachable");
  expect(refused.reason).toContain("without ever deciding anything");
  expect(refused.reason).not.toContain("rate limited");
  expect(refused.reason).not.toBe(limited.reason);

  /**
   * AND A LIMIT THAT ARRIVES BEFORE THE QUERY IS STILL A LIMIT.
   * `structuredAgent` only tests the error it catches from the query itself, so
   * a 429 raised while the SDK is loading arrives as `unavailable` — and telling
   * an operator to install Claude when the account is out of budget for the hour
   * sends them to the one place with nothing to fix.
   */
  const early = createLoomAgent({
    loadSdk: async () => {
      throw new Error("usage limit reached for this account");
    },
    resolveExecutable: () => "/nowhere/claude",
    now: () => AT,
  });
  const answer = await early("decide");
  expect(answer.ok).toBe(false);
  if (answer.ok) throw new Error("unreachable");
  expect(answer.reason).toContain("rate limited");
  expect(answer.reason).not.toContain("Claude Code is missing");
});

test("no Claude on this machine is reported as being about the machine", async () => {
  const agent = createLoomAgent({
    loadSdk: async () => fakeSdk(() => DECISION, {}),
    resolveExecutable: () => {
      throw new Error("claude was not found on PATH");
    },
  });
  const answer = await agent("decide");
  expect(answer.ok).toBe(false);
  if (answer.ok) throw new Error("unreachable");
  expect(answer.reason).toContain("THIS MACHINE");
  expect(answer.reason).toContain("claude --version");
});

// ── the session port, against a real store and a REAL git ───────────────────

/**
 * REAL GIT, DELIBERATELY, AND THIS IS THE FILE'S CORRECTION.
 *
 * These three tests used to run against a `GitRunner` that answered every
 * command with success and touched no disk — and that fake is precisely what let
 * `start()` ship cutting a SECOND worktree nobody worked in. A store whose git
 * cannot tell one checkout from another cannot be asked which one the worker
 * got. Git is local, deterministic and free; the network, a real Claude session
 * and somebody's rate limit are what this suite must never reach, and none of
 * them appear below.
 */
const git: GitRunner = defaultGitRunner;

function must(result: { status: number; stdout: string; stderr: string }, what: string): string {
  if (result.status !== 0) throw new Error(`${what} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

type World = { store: EngineStore; projectId: string; projectRoot: string; engineRoot: string };

function storeWithProject(): World {
  const directory = scratch("telar-loom-wiring-store-");
  fs.mkdirSync(path.join(directory, "repo"), { recursive: true });
  // `realpathSync` because the store canonicalises a registered root and macOS
  // hands out `/var` symlinks for `/private/var`.
  const projectRoot = fs.realpathSync.native(path.join(directory, "repo"));
  fs.writeFileSync(path.join(projectRoot, "README.md"), "# one\n");
  must(git(projectRoot, ["init"]), "git init");
  must(git(projectRoot, ["config", "user.email", "loom@example.invalid"]), "git config email");
  must(git(projectRoot, ["config", "user.name", "Loom Wiring"]), "git config name");
  must(git(projectRoot, ["config", "commit.gpgsign", "false"]), "git config gpgsign");
  must(git(projectRoot, ["add", "-A"]), "git add");
  must(git(projectRoot, ["commit", "-m", "chore: the project as it stands"]), "git commit");
  must(git(projectRoot, ["branch", "-M", "main"]), "git branch -M main");

  const engineRoot = path.join(directory, "engine");
  const store = new EngineStore(engineRoot, () => AT, { git });
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  return { store, projectId: "project_one", projectRoot, engineRoot };
}

/**
 * WHAT `provisionLoom` HANDS THE PORT: a checkout that already exists, on the
 * branch the Program named, off the base it declared. Cut the same way dispatch
 * cuts it — the engine's own `createSessionWorktree`, then `checkout -B` onto
 * the Program's name — so what these tests adopt is what the runtime adopts.
 */
function loomWorktree(world: World, branch: string): { path: string; branch: string; baseRef: string } {
  const cut = createSessionWorktree(git, {
    engineRoot: world.engineRoot,
    projectRoot: world.projectRoot,
    sessionId: `loom-${branch.replace(/[^a-z0-9]/gi, "")}`,
    baseRef: "main",
  });
  must(git(cut.path, ["checkout", "-B", branch]), `checkout -B ${branch}`);
  git(world.projectRoot, ["branch", "-D", cut.branch]);
  return { path: cut.path, branch, baseRef: cut.baseRef };
}

test("start() adopts the worktree the loom prepared instead of cutting a second one", async () => {
  const world = storeWithProject();
  const { store, projectId } = world;
  const port = createLoomSessionPort({ store });
  const prepared = loomWorktree(world, "loom/issue-7");
  fs.writeFileSync(path.join(prepared.path, "node_modules.marker"), "setup ran here\n");

  const { sessionId } = await port.start({
    projectId,
    worktree: prepared.path,
    branch: prepared.branch,
    baseRef: prepared.baseRef,
    prompt: "the brief",
    title: "issue-7 — the seventh issue",
  });

  const session = store.getSession(sessionId);
  // WORKTREE MODE IS WHAT LETS TWO LOOMS RUN AT ONCE. Two workers in one
  // checkout produce a diff nobody can attribute.
  expect(session.envMode).toBe("worktree");
  expect(session.workspace.mode).toBe("worktree");
  expect(session.title).toBe("issue-7 — the seventh issue");

  /**
   * THE WHOLE BUG, IN THREE LINES. The worker's checkout is the one the loom
   * prepared — the branch the Program named, the directory `setup` ran in — and
   * not a `telar/<sessionId>` cut off project HEAD. Asserting the branch alone
   * would not have caught it either: the old code produced a truthy branch, it
   * was simply the wrong one, in the wrong directory.
   */
  expect(session.workspace.path).toBe(prepared.path);
  expect(session.workspace.branch).toBe("loom/issue-7");
  expect(session.workspace.branch).not.toMatch(/^telar\//);
  expect(fs.existsSync(path.join(session.workspace.path, "node_modules.marker"))).toBe(true);

  // ONE CHECKOUT, ONE BRANCH. Two per loom is the RAM ceiling wrong by a factor
  // of two, and a `telar/*` ref left behind for every item ever dispatched.
  expect(worktreeList(world)).toHaveLength(2);
  expect(branchList(world)).toEqual(["loom/issue-7", "main"]);

  // EXACTLY ONE. The brief is complete by construction and nobody talks to a
  // worker again; a second turn would be a conversation this surface does not
  // have.
  const turns = store.turns(sessionId);
  expect(turns).toHaveLength(1);
  expect(turns[0]?.input).toBe("the brief");
  expect(turns[0]?.state).toBe("queued");

  /**
   * AND IT QUEUED WITH NO WORKER REGISTERED. `daemon.ts` answers `POST /turns`
   * with a 503 `worker_unavailable` in that state — but that check is on the
   * HTTP path, and this port is in-process. A loom dispatched at 3am must not be
   * refused because a worker happened to be mid-restart.
   *
   * IT IS REPORTED AS `unclaimed`, NOT AS `running`, and the difference is the
   * whole point of queueing into a void being allowed at all. Nothing is
   * executing this brief; saying `running` would have been true of the session
   * and false about the world, and it is what let a loom sit `working` forever
   * on a deck that drew the project as healthy.
   */
  expect(await port.status(sessionId)).toBe("unclaimed");
});

test("status() tells a queued or running worker from a finished one, and both from a session that is gone", async () => {
  const world = storeWithProject();
  const { store, projectId } = world;
  const port = createLoomSessionPort({ store });
  const prepared = loomWorktree(world, "loom/issue-7");
  const { sessionId } = await port.start({
    projectId,
    worktree: prepared.path,
    branch: prepared.branch,
    baseRef: prepared.baseRef,
    prompt: "the brief",
    title: "issue-7",
  });

  // QUEUED IS ALIVE — reporting it `done` would gate an empty worktree and
  // stick the loom seconds after dispatching it — but it is alive in a way that
  // NOTHING IS DOING ANYTHING ABOUT, which `running` cannot say.
  expect(await port.status(sessionId)).toBe("unclaimed");

  const claimed = store.claimTurn(sessionId, "worker_one");
  if (!claimed?.claim) throw new Error("the store did not hand out a claim");
  // THE CLAIM IS THE LINE. One worker took the turn, so from here the answer is
  // `running` for as long as the work takes — a slow worker can never be
  // mistaken for a missing one, which is what keeps the bound in `advanceOne` a
  // liveness check rather than a work timeout.
  expect(await port.status(sessionId)).toBe("running");
  store.markRunning(sessionId, claimed.runId, claimed.claim.token);
  expect(await port.status(sessionId)).toBe("running");

  store.completeTurn(sessionId, claimed.runId, claimed.claim.token, { text: "done" });
  // The completion signal is the same event the web app treats as the end of a
  // turn (`apps/web/lib/engine/session-sync.ts:16`).
  expect(store.readEvents(sessionId).some((event) => event.type === "turn.completed")).toBe(true);
  expect(await port.status(sessionId)).toBe("done");

  // A session id nothing goes by. The tick after a reaped worker asks exactly
  // this and must not throw its way out of the reconcile pass.
  expect(await port.status("session_nothing_goes_by")).toBe("gone");

  // ARCHIVED IS `gone`, NOT `done`: what is left was cleaned up rather than
  // merely finished, and nobody can ask it anything afterwards.
  store.archiveSession(sessionId);
  expect(await port.status(sessionId)).toBe("gone");

  /**
   * AND ARCHIVING DID NOT TAKE THE LOOM'S CHECKOUT WITH IT.
   *
   * This is the second half of adoption and it is load-bearing on the same
   * failure: the gate counts commits in this directory AFTER the worker has
   * ended, and `publish` pushes its branch. A store that reaped it here would
   * delete the night's work between those two steps and the loom would report
   * that its worker committed nothing — the exact sentence the original bug
   * produced, reached by a different road.
   */
  expect(fs.existsSync(prepared.path)).toBe(true);
  expect(worktreeList(world)).toContain(fs.realpathSync.native(prepared.path));
  expect(branchList(world)).toContain("loom/issue-7");
});

test("start() refuses a second live worker in a checkout that already has one", async () => {
  /**
   * Every ladder rung and every human answer re-provisions the loom against the
   * SAME checkout. `provisionLoom` stops the previous session first, so the
   * ordinary path never reaches this — which is exactly why the invariant is
   * held here too rather than left to the caller's cooperation. Two live agents
   * in one worktree produce a diff attributable to neither and a gate that
   * measures whichever instant it happened to arrive in, and neither symptom
   * names its cause.
   */
  const world = storeWithProject();
  const { store, projectId } = world;
  const port = createLoomSessionPort({ store });
  const prepared = loomWorktree(world, "loom/issue-7");
  const first = await port.start({
    projectId,
    worktree: prepared.path,
    branch: prepared.branch,
    baseRef: prepared.baseRef,
    prompt: "the brief",
    title: "issue-7",
  });

  await expect(
    port.start({
      projectId,
      worktree: prepared.path,
      branch: prepared.branch,
      baseRef: prepared.baseRef,
      prompt: "the same brief again",
      title: "issue-7 rung 2",
    }),
  ).rejects.toThrow(/still working in/);

  /**
   * AND STOPPING THE FIRST ONE IS WHAT MAKES ROOM — which is the property that
   * keeps this a guard rather than a wall. `stop` settles the turns and
   * deliberately LEAVES the session active, so a check written against
   * `session.state` would have refused the rung forever and broken the ladder.
   * Liveness is a question about turns.
   */
  await port.stop(first.sessionId);
  expect(store.getSession(first.sessionId).state).toBe("active");
  const second = await port.start({
    projectId,
    worktree: prepared.path,
    branch: prepared.branch,
    baseRef: prepared.baseRef,
    prompt: "the same brief again",
    title: "issue-7 rung 2",
  });
  expect(second.sessionId).not.toBe(first.sessionId);
});

test("stop() settles every runnable turn and leaves the session in place", async () => {
  const world = storeWithProject();
  const { store, projectId } = world;
  const port = createLoomSessionPort({ store });
  const prepared = loomWorktree(world, "loom/issue-7");
  const { sessionId } = await port.start({
    projectId,
    worktree: prepared.path,
    branch: prepared.branch,
    baseRef: prepared.baseRef,
    prompt: "the brief",
    title: "issue-7",
  });
  // A second queued turn is what a cancel must not leave behind for a worker to
  // pick up ten seconds later.
  store.submitTurn(sessionId, { runId: "run_second", input: "and another thing" });

  await port.stop(sessionId);

  expect(store.turns(sessionId).every((turn) => turn.state === "stopped")).toBe(true);
  expect(await port.status(sessionId)).toBe("done");
  // THE SESSION AND ITS CHECKOUT SURVIVE. `cancelLoom` keeps the branch on
  // purpose — it is the loom's output, and destroying commits is a separate
  // human decision from stopping a run.
  expect(store.getSession(sessionId).state).toBe("active");
  expect(fs.existsSync(prepared.path)).toBe(true);

  // Idempotent: a session already gone is exactly what the caller wanted.
  await port.stop("session_nothing_goes_by");
});

// ── the refusals: a caller-supplied path reaches `git` ──────────────────────

test("a prepared workspace that is not this project's worktree is refused, and says which check failed", async () => {
  /**
   * VALIDATION IS IN THE STORE, per the house rule: an in-process caller must
   * hit the same wall an HTTP one would. `provisionLoom` runs inside a try that
   * turns a throw into the loom's `stuck` reason, so each of these sentences is
   * one a human reads at 8am — which is why they name the failing check rather
   * than returning a code.
   */
  const world = storeWithProject();
  const { store, projectId } = world;
  const prepared = loomWorktree(world, "loom/issue-7");

  // OUTSIDE THE ENGINE'S WORKTREES ROOT. A path from a caller reaches `git`,
  // and `git -C <anywhere>` is an execution surface.
  expect(() => store.createSession({ projectId, workspace: { path: world.projectRoot, branch: "main" } })).toThrow(
    /worktrees directory/,
  );
  expect(() => store.createSession({ projectId, workspace: { path: "/etc", branch: "main" } })).toThrow(/worktrees directory/);
  expect(() =>
    store.createSession({ projectId, workspace: { path: path.join(world.engineRoot, "worktrees", "..", "..", "etc"), branch: "x" } }),
  ).toThrow(/worktrees directory/);

  // INSIDE THE FENCE BUT NOT A WORKTREE.
  const empty = path.join(world.engineRoot, "worktrees", "not-a-checkout");
  fs.mkdirSync(empty, { recursive: true });
  expect(() => store.createSession({ projectId, workspace: { path: empty, branch: "loom/x" } })).toThrow(/not a git worktree/);
  expect(() => store.createSession({ projectId, workspace: { path: path.join(empty, "nope"), branch: "loom/x" } })).toThrow(
    /nothing to adopt/,
  );

  /**
   * ON A DIFFERENT BRANCH THAN THE ONE NAMED — the check that maps directly
   * onto the bug. `publish` pushes the branch RECORDED on the session, so a
   * recorded branch that is not the checked-out one sends the work nowhere and
   * says nothing while doing it.
   */
  expect(() => store.createSession({ projectId, workspace: { path: prepared.path, branch: "loom/somewhere-else" } })).toThrow(
    /is on loom\/issue-7, not loom\/somewhere-else/,
  );

  // AND A CONTRADICTION IS REFUSED RATHER THAN RESOLVED. A caller handing over
  // a checkout while asking for `local` has said two things; picking one would
  // decide for them.
  expect(() =>
    store.createSession({ projectId, envMode: "local", workspace: { path: prepared.path, branch: prepared.branch } }),
  ).toThrow(/contradicts/);

  // NOTHING WAS RECORDED BY ANY OF THEM.
  expect(store.listSessions(projectId)).toEqual([]);
});

test("a plain worktree session still cuts its own checkout, and archiving still reaps it", async () => {
  /**
   * THE UNCHANGED PATH, PINNED. Adoption is additive: a caller that names no
   * workspace gets `telar/<sessionId>` off project HEAD and owns it, which is
   * every session in the product that is not a loom worker. If this ever starts
   * failing, adoption has stopped being optional.
   */
  const world = storeWithProject();
  const { store, projectId } = world;

  const session = store.createSession({ projectId, envMode: "worktree", title: "an ordinary detached session" });
  if (session.workspace.mode !== "worktree") throw new Error("unreachable");
  expect(session.workspace.branch).toBe(`telar/${session.id}`);
  expect(session.workspace.path.startsWith(path.join(world.engineRoot, "worktrees"))).toBe(true);
  expect(session.workspace.adopted).toBeUndefined();
  expect(fs.existsSync(session.workspace.path)).toBe(true);
  expect(worktreeList(world)).toHaveLength(2);

  store.archiveSession(session.id);
  // ITS OWN CHECKOUT, SO ITS OWN TO FREE. The branch survives — it is the
  // session's output — but the directory and the registration do not.
  expect(fs.existsSync(session.workspace.path)).toBe(false);
  expect(worktreeList(world)).toHaveLength(1);
  expect(branchList(world)).toContain(`telar/${session.id}`);
});

/** Every checkout git currently knows about, symlink-resolved so two spellings
 *  of one temp directory compare equal. */
function worktreeList(world: World): string[] {
  return must(git(world.projectRoot, ["worktree", "list", "--porcelain"]), "git worktree list")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => fs.realpathSync.native(line.slice("worktree ".length).trim()));
}

function branchList(world: World): string[] {
  return must(git(world.projectRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]), "git for-each-ref")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

test("the orchestrator conversation opens against the project's own root, never a worktree", async () => {
  const { store, projectId, projectRoot } = storeWithProject();
  const port = createLoomSessionPort({ store });

  const { sessionId } = await port.create({
    projectId,
    cwd: projectRoot,
    title: `Loom — ${projectId}`,
    prompt: "look first, ask only what cannot be determined",
  });

  const session = store.getSession(sessionId);
  /**
   * §16's whole distinction. Pinning this one to a worktree would have it
   * describing a private, hours-stale copy of the project it is talking about.
   */
  expect(session.envMode).toBe("local");
  expect(session.workspace.mode).toBe("local");
  expect(session.workspace.path).toBe(projectRoot);
  expect(session.workspace.path).not.toContain("worktrees");
  expect(store.turns(sessionId)).toHaveLength(1);

  // SEEDED ONLY ON CREATION. A session opened with no prompt is idle and
  // reusable, which is what `ensureLoomSession` hands back rather than replaces.
  const bare = await port.create({ projectId, cwd: projectRoot, title: "Loom" });
  expect(store.turns(bare.sessionId)).toHaveLength(0);
  expect(await port.status(bare.sessionId)).toBe("done");

  // And a cwd the registry does not agree with is refused rather than quietly
  // opened somewhere else.
  await expect(port.create({ projectId, cwd: path.join(projectRoot, "elsewhere"), title: "Loom" })).rejects.toThrow(
    /diverged/,
  );
});

// ── the daemon, wired for real ──────────────────────────────────────────────

test("a daemon wired to the real orchestrator boots inert and closes clean", async () => {
  /**
   * CONSTRUCTION MUST DO NOTHING. `createLoomAgent` allocates a closure — no SDK
   * import, no CLI resolution — and `createLoomSessionPort` closes over the
   * store. This is the property that lets `startEngine` wire both
   * unconditionally while every existing test still boots a daemon that cannot
   * reach a provider, and it is asserted the only way it can be: a daemon with
   * NO loom injections at all starts, serves and stops.
   */
  const directory = scratch("telar-loom-wiring-daemon-");
  fs.mkdirSync(path.join(directory, "repo"), { recursive: true });
  const projectRoot = fs.realpathSync.native(path.join(directory, "repo"));
  const daemon = await startEngine({ engineRoot: path.join(directory, "engine") });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: projectRoot });

  expect((await client.looms()).projects).toHaveLength(1);
  expect((await client.loomProgram("project_one")).exists).toBe(false);

  /**
   * AND NOTHING WAS REACHED. A dispatch against a project with no
   * `.telar/loom.md` is stopped by machinery before the session port or the
   * model call — so the refusal leaves no loom and, crucially, NO SESSION. A
   * port that had cut a worktree on the way to failing would show up here.
   */
  await expect(client.dispatchLoom("project_one", { item: "issue-7" })).rejects.toThrow();
  expect((await client.looms()).looms).toEqual([]);
  expect((await client.listSessions("project_one")).sessions).toEqual([]);
});

// ── the sentinel across a restart ───────────────────────────────────────────

/** The recurring timer, injected: created and cleared are COUNTED, and the sweep
 *  is fired by hand, so none of these tests waits on a real clock. */
function trackedInterval() {
  const state = { created: 0, cleared: 0, fire: undefined as undefined | (() => void) };
  const interval = (fn: () => void, _ms: number): { clear(): void } => {
    state.created += 1;
    state.fire = fn;
    return {
      clear() {
        state.cleared += 1;
      },
    };
  };
  return { state, interval };
}

function recordingExec(commands: string[]): LoomExec {
  return async (input) => {
    commands.push(input.command);
    return { code: 0, stdout: "one-line-fingerprint\n", stderr: "", timedOut: false };
  };
}

const PROGRAM = ["# Loom program", "", "## Work source", "", "```probe", "probe-me", "```", "", "```list", "list-items", "```", ""].join(
  "\n",
);

/** A project registered and a Program on disk, written through the real daemon,
 *  then closed — so what follows reads a store a previous process left behind. */
async function seedEngineRoot(): Promise<{ engineRoot: string; projectRoot: string }> {
  const directory = scratch("telar-loom-wiring-restart-");
  const engineRoot = path.join(directory, "engine");
  fs.mkdirSync(path.join(directory, "repo"), { recursive: true });
  const projectRoot = fs.realpathSync.native(path.join(directory, "repo"));
  // The agent is injected even though nothing here watches: `startEngine` wires
  // a real one now, and a seeding daemon that ever grew a watch would otherwise
  // reach the machine's Claude Code on its first probe.
  const quiet: LoomAgent = async () => ({ ok: true, value: DECISION });
  const first = await startEngine({ engineRoot, now: () => AT, loomExec: recordingExec([]), loomAgent: quiet });
  const client = new EngineClient(first.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: projectRoot });
  await client.saveLoomProgram("project_one", PROGRAM);
  await first.close();
  return { engineRoot, projectRoot };
}

test("a first-run daemon arms no timer and probes nothing", async () => {
  /**
   * `resume()` guards this itself — it arms only when a watch record on disk
   * already says `running` — and a fresh engine has none. Verified rather than
   * trusted, because "an idle daemon must not probe on boot" is the property
   * that lets `resume()` be called unconditionally.
   */
  const directory = scratch("telar-loom-wiring-fresh-");
  const probes: string[] = [];
  const timer = trackedInterval();
  const daemon = await startEngine({
    engineRoot: path.join(directory, "engine"),
    loomInterval: timer.interval,
    loomExec: recordingExec(probes),
  });
  daemons.push(daemon);

  expect(timer.state.created).toBe(0);
  expect(probes).toEqual([]);
});

test("the backoff a quiet night earned survives a restart, and the timer it arms is the one close() clears", async () => {
  const { engineRoot } = await seedEngineRoot();
  const paths = loomPaths(engineRoot);
  /**
   * A NIGHT OF QUIET, WRITTEN DIRECTLY rather than waited for. `quietChecks` and
   * the stored fingerprint look derivable and are not: a resume that reset them
   * would re-probe a silent repository every 300s forever — exactly the cost the
   * backoff exists to prevent — while the deck looked perfectly healthy.
   */
  writeWatch(paths, "project_one", {
    projectId: "project_one",
    running: true,
    intervalSec: 1200,
    quietChecks: 2,
    lastProbeAt: AT - 1200_000,
    // Not due yet, so this test observes the resumed state rather than racing a
    // sweep to read it.
    nextProbeAt: AT + 1200_000,
  });
  writeSentinel(paths, "project_one", fingerprintFrom("one-line-fingerprint\n", AT - 1200_000));
  const before = readSentinel(paths, "project_one");

  const probes: string[] = [];
  const timer = trackedInterval();
  const second = await startEngine({ engineRoot, now: () => AT, loomInterval: timer.interval, loomExec: recordingExec(probes) });

  // RESUMED, so the timer exists on the new process — the whole bug.
  expect(timer.state.created).toBe(1);
  timer.state.fire?.();
  // …and nothing probed, because this watch is not due. The arming is what was
  // missing, not a re-baselining.
  expect(probes).toEqual([]);

  const resumed = readWatch(paths, "project_one");
  expect(resumed.running).toBe(true);
  expect(resumed.intervalSec).toBe(1200);
  expect(resumed.quietChecks).toBe(2);
  expect(readSentinel(paths, "project_one")).toEqual(before);

  /**
   * AND THE RESUMED TIMER IS THE HANDLE `close()` CLEARS. If it were not, the
   * teardown invariant would cover the start path and not the resumed one — and
   * a suite that resumes then closes would HANG rather than fail, which is the
   * worst diagnostic outcome available.
   */
  await second.close();
  expect(timer.state.cleared).toBe(1);
});

test("a resumed watch probes again with nobody touching the switch, and reads its own fingerprint as unchanged", async () => {
  /**
   * THE MEASURED BUG, INVERTED. Two daemons over one engine root gave `A
   * probed: 1`, restart, `watch.running` still true on disk, `B probed: 0`.
   * This is that zero, flipped.
   */
  const { engineRoot } = await seedEngineRoot();
  const paths = loomPaths(engineRoot);
  writeWatch(paths, "project_one", {
    projectId: "project_one",
    running: true,
    intervalSec: 1200,
    quietChecks: 2,
    lastProbeAt: AT - 1200_000,
    nextProbeAt: AT,
  });
  writeSentinel(paths, "project_one", fingerprintFrom("one-line-fingerprint\n", AT - 1200_000));

  const probes: string[] = [];
  const timer = trackedInterval();
  let ticks = 0;
  const agent: LoomAgent = async () => {
    ticks += 1;
    return { ok: true, value: DECISION };
  };
  const second = await startEngine({
    engineRoot,
    now: () => AT,
    loomInterval: timer.interval,
    loomExec: recordingExec(probes),
    loomAgent: agent,
  });
  daemons.push(second);

  expect(timer.state.created).toBe(1);
  timer.state.fire?.();
  await until(() => probes.includes("probe-me"), "the resumed sentinel never ran the Program's probe");
  await until(() => readWatch(paths, "project_one").quietChecks === 3, "the resumed pass never settled");

  const after = readWatch(paths, "project_one");
  /**
   * UNCHANGED AGAINST A FINGERPRINT IT STILL HAS. A resume that dropped the
   * sentinel would read its first probe as a change — there would be nothing to
   * compare against — and wake an agent on evidence of nothing.
   */
  expect(ticks).toBe(0);
  expect(after.lastChangeAt).toBeUndefined();
  // Doubled FROM 1200, which is what says 1200 was the number it resumed with:
  // a re-baselined watch would have backed off from the Program's 300.
  expect(after.intervalSec).toBe(2400);
  expect(after.lastError).toBeUndefined();
});

test("a `list` that fails refuses the tick instead of reporting an empty backlog", async () => {
  /**
   * MEASURED TWICE, BECAUSE THE ANSWER CHANGED UNDERNEATH THE FIRST
   * MEASUREMENT — and the claim this pins is the one that survived the change.
   *
   * A failed `list` and an empty one are the same shape and mean opposite
   * things. The failure mode is not a crash, it is a system that ticks cleanly
   * forever while `gh` is unauthenticated, decides nothing, reports `done`, and
   * renders healthy on every surface. "Idle is free" becomes "broken is
   * indistinguishable from idle", which is the one reading §3.6 cannot afford.
   *
   * WHAT IS ASSERTED IS THAT OUTCOME, NOT THE MECHANISM. The tick refuses today;
   * it previously handed the exit code to the orchestrator with an explicit
   * prohibition against reading it as emptiness. Both satisfy the rule, and a
   * test written against either mechanism would have gone green through a
   * behaviour swap while the rule itself went unchecked.
   *
   * THE AGENT IS NOT ASKED, and that is a cost assertion rather than a style
   * one: an outage lasting eight hours must cost zero model calls, not one per
   * tick. It is also the only evidence available that the refusal happened
   * BEFORE the expensive half.
   */
  const directory = scratch("telar-loom-wiring-list-");
  fs.mkdirSync(path.join(directory, "repo"), { recursive: true });
  const projectRoot = fs.realpathSync.native(path.join(directory, "repo"));

  const loomExec: LoomExec = async (input) =>
    input.command.includes("list-items")
      ? { code: 4, stdout: "", stderr: "gh: not authenticated", timedOut: false }
      : { code: 0, stdout: "fingerprint\n", stderr: "", timedOut: false };

  // RECORDING, not quiet: "the orchestrator was never asked" is half the claim,
  // and an agent that answers without counting cannot make it.
  const prompts: string[] = [];
  const loomAgent: LoomAgent = async (prompt) => {
    prompts.push(prompt);
    return { ok: true, value: DECISION };
  };

  const daemon = await startEngine({ engineRoot: path.join(directory, "engine"), loomExec, loomAgent });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: projectRoot });
  await client.saveLoomProgram(
    "project_one",
    ["# Loom program", "", "## Work source", "", "```list", "list-items", "```", ""].join("\n"),
  );

  const { run } = await client.tickLoom("project_one");
  let settled = run;
  for (let attempt = 0; attempt < 400 && settled.state === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    settled = (await client.loomWork()).runs.find((candidate) => candidate.id === run.id) ?? settled;
  }

  // LOUD, NOT QUIET. `done` here would be the bug: the tick would be claiming it
  // looked at the backlog and found nothing worth doing.
  expect(settled.state).toBe("failed");
  expect(settled.error ?? "").toContain("exited 4");
  expect(settled.error ?? "").toContain("gh: not authenticated");
  expect(settled.error ?? "").toContain("Refusing rather than reporting an empty backlog");

  // Zero model calls for as long as the outage lasts.
  expect(prompts).toEqual([]);

  // AND THE HUMAN'S OWN RECORD KEEPS IT. A run record is transient; the ledger
  // is what answers "what happened at 3am" the next morning.
  const { entries } = await client.loomLedger("project_one");
  expect(entries.some((entry) => entry.kind === "error" && entry.summary.includes("`list` command exited 4"))).toBe(true);

  // Nothing was dispatched off a triage cache the world was never checked
  // against — the risk that makes "refuse" better than "decide from stale".
  expect((await client.looms()).looms).toEqual([]);
});

/** Poll rather than sleep: a detached pass settles on its own schedule, and a
 *  fixed delay is how a test like this starts flaking. */
async function until(condition: () => boolean, complaint: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(complaint);
}
