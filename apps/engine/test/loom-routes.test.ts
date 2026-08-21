/**
 * The Loom over HTTP — the daemon's `/v2/looms/**` arms and the typed client,
 * end to end.
 *
 * SEPARATE FROM `loom-store.test.ts`, which drives the store directly against a
 * temp directory. That suite owns the rules; this one owns the SEAM, and the
 * distinction earns its keep in exactly two places.
 *
 * First, statuses. The store speaks two vocabularies — a refusal with a
 * sentence, and a `null` lookup — and the seam is where those become 400 and
 * 404 WITHOUT losing the sentence. A refusal that arrives as a bare 400 with no
 * message is the regression this file exists to catch and that one cannot.
 *
 * Second, routing. `/v2/looms/program` matches the `:loomId` regex as happily
 * as a loom id does, so "the Program editor still works" is a claim about arm
 * ORDER in `daemon.ts` rather than about anything the store does.
 *
 * NOTHING HERE SHELLS OUT OR SPENDS RATE LIMIT. The nine runtime verbs arrive
 * through `EngineDaemonOptions.loomRuntime`, the same injection promise `gh` and
 * the provider probe already make; the disk-backed reads run for real against a
 * temp root.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError, type Loom, type LoomRun, type LoomWatch } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import type { LoomAgent, LoomSessionPort } from "../src/loom/dispatch";
import type { LoomExec } from "../src/loom/exec";
import { appendLedger, loomPaths, writeLoom, writeTriage, type LoomRuntime } from "../src/loom/store";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

type Harness = {
  client: EngineClient;
  daemon: EngineDaemon;
  /** The engine's own root — where the loom store's files land. */
  engineRoot: string;
  /** A registered project and the repository root its Program is written into. */
  projectId: string;
  projectRoot: string;
};

type Injected = {
  loomRuntime?: LoomRuntime;
  loomExec?: LoomExec;
  loomAgent?: LoomAgent;
  loomSession?: LoomSessionPort;
};

async function looms(options: Injected = {}): Promise<Harness> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-loom-routes-"));
  roots.push(directory);
  const engineRoot = path.join(directory, "engine");
  // `realpathSync` because the engine canonicalises a registered root and macOS
  // hands out `/var` symlinks for `/private/var` — comparing the two is a test
  // that fails on one CI runner and passes on the other.
  fs.mkdirSync(path.join(directory, "repo"), { recursive: true });
  const projectRoot = fs.realpathSync.native(path.join(directory, "repo"));
  const daemon = await startEngine({
    engineRoot,
    ...(options.loomRuntime ? { loomRuntime: options.loomRuntime } : {}),
    /**
     * THE TWO EXPENSIVE PORTS ARE DEFAULTED HERE, NOT LEFT TO EACH TEST.
     *
     * Opting IN to safety is the shape that already failed once in this file:
     * `startEngine` began wiring a real agent, the restart tests passed only
     * `loomExec`, and a first probe on a fresh project woke a tick that reached
     * the machine's own Claude Code — visible in the suite output as a CLI
     * version banner, and invisible in the pass count. Every test that forgets
     * is a test that spends somebody's rate limit to answer a prompt nobody
     * reads, and it still goes green.
     *
     * So the harness refuses BY DEFAULT and a test opts out by naming its own.
     * The next person to add a case here cannot reintroduce that by omission.
     */
    loomExec: options.loomExec ?? UNEXPECTED_EXEC,
    loomAgent: options.loomAgent ?? QUIET_AGENT,
    ...(options.loomSession ? { loomSession: options.loomSession } : {}),
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: projectRoot });
  return { client, daemon, engineRoot, projectId: "project_one", projectRoot };
}

/** The wire, unmediated — because a status code is the thing under test in half
 *  this file, and `EngineClient` deliberately hands back only the body. */
async function call(
  daemon: EngineDaemon,
  method: string,
  pathname: string,
  options: { body?: unknown; token?: string | null } = {},
): Promise<{ status: number; body: any }> {
  const token = options.token === undefined ? daemon.discovery.token : options.token;
  const response = await fetch(`http://${daemon.discovery.host}:${daemon.discovery.port}${pathname}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json() };
}

const AT = 1_760_000_000_000;

/**
 * AN ORCHESTRATOR THAT DECIDES NOTHING, FOR THE TESTS THAT ARE NOT ABOUT ONE.
 *
 * `startEngine` now wires a REAL `loomAgent` where a refusing placeholder used
 * to sit, so a daemon started here with no injection reaches the machine's own
 * Claude Code the first time a probe wakes a tick — and the first probe on a
 * fresh project always does, because it has no previous fingerprint to compare
 * against. The sentinel tests below are about arming a timer; without this they
 * would quietly spend somebody's rate limit to answer a prompt nobody reads.
 * `daemon.ts:51-85` is the rule, and this is what obeying it costs.
 */
const QUIET_AGENT: LoomAgent = async () => ({ ok: true, value: { triage: [], dispatch: [], park: [], ask: [], note: "" } });

/**
 * The shell, for tests that never meant to reach one.
 *
 * ANSWERS RATHER THAN THROWS, because a throw inside a detached tick is not a
 * test failure — it is settled onto a run record nobody in that test reads, so
 * the leak would stay silent in a different way. A recognisable stdout means a
 * test that unexpectedly depends on a real command fails on the ASSERTION, in
 * its own words, instead of on somebody's `gh` quota.
 */
const UNEXPECTED_EXEC: LoomExec = async () => ({
  code: 0,
  stdout: "the loom route tests never run a real command — inject `loomExec` if this test needs one\n",
  stderr: "",
  timedOut: false,
});

function loomRecord(patch: Partial<Loom> = {}): Loom {
  return {
    id: "loom_one",
    projectId: "project_one",
    item: "issue-7",
    title: "The seventh issue",
    state: "working",
    attempts: 0,
    ladderRung: 0,
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  };
}

/**
 * The runtime verbs, faked and RECORDING.
 *
 * It records because half of what these arms do is argument passing — the id
 * out of the path, the flag out of the body — and an answer that looks right
 * proves nothing about which project the daemon actually named.
 */
function fakeRuntime(): { runtime: LoomRuntime; calls: string[] } {
  const calls: string[] = [];
  const sessions = new Set<string>();
  const run = (kind: LoomRun["kind"]): LoomRun => ({
    id: `run_${kind.replace("-", "_")}`,
    projectId: "project_one",
    kind,
    state: "running",
    startedAt: AT,
    dispatched: [],
  });
  const watch = (running: boolean): LoomWatch => ({
    projectId: "project_one",
    running,
    intervalSec: 300,
    quietChecks: 0,
  });
  const runtime: LoomRuntime = {
    ensureLoomSession: async (projectId) => {
      calls.push(`ensureLoomSession:${projectId}`);
      const created = !sessions.has(projectId);
      sessions.add(projectId);
      return { sessionId: `session_${projectId}`, created };
    },
    close: () => {
      calls.push("close");
    },
    loomWork: () => {
      calls.push("loomWork");
      return { runs: [run("tick")] };
    },
    startLoomWatch: (projectId) => {
      calls.push(`startLoomWatch:${projectId}`);
      return { watch: watch(true) };
    },
    stopLoomWatch: (projectId) => {
      calls.push(`stopLoomWatch:${projectId}`);
      return { watch: watch(false) };
    },
    tickLoom: (projectId) => {
      calls.push(`tickLoom:${projectId}`);
      return { run: run("tick") };
    },
    dryRunLoom: (projectId) => {
      calls.push(`dryRunLoom:${projectId}`);
      return { run: run("dry-run") };
    },
    dispatchLoom: async (projectId, input) => {
      calls.push(`dispatchLoom:${projectId}:${input.item}:${input.title ?? "-"}:${input.brief ?? "-"}`);
      return { loom: loomRecord({ id: "loom_dispatched", item: input.item, state: "queued" }) };
    },
    cancelLoom: async (loomId) => {
      calls.push(`cancelLoom:${loomId}`);
      return { loom: loomRecord({ id: loomId, state: "cancelled" }) };
    },
    answerLoom: async (loomId, answer) => {
      calls.push(`answerLoom:${loomId}:${answer}`);
      return { loom: loomRecord({ id: loomId, state: "working" }) };
    },
    suggestLoomProgram: (projectId) => {
      calls.push(`suggestLoomProgram:${projectId}`);
      return { markdown: "# Loom\n\n## Work source\n", findings: ["the repo has a `gh` remote"] };
    },
  };
  return { runtime, calls };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("an untouched engine serves an empty looms overview rather than a 404 or a throw", async () => {
  // A store that has never been written is the ordinary first-run state, and
  // the deck has to render it. Note the project summary IS present: "registered,
  // no Program yet" is where every project starts, and the deck's invitation to
  // run setup is drawn from exactly that row.
  const { client } = await looms();
  const overview = await client.looms();
  expect(overview.looms).toEqual([]);
  expect(overview.triage).toEqual([]);
  expect(overview.unreadable).toEqual([]);
  // The runs pane needs a process; the rest of the page does not. A detached
  // runtime answers an accurate empty list rather than taking the deck down.
  expect(overview.runs).toEqual([]);
  expect(overview.projects).toHaveLength(1);
  expect(overview.projects[0]).toMatchObject({ projectId: "project_one", hasProgram: false });
  expect(overview.projects[0].programPath).toContain(path.join(".telar", "loom.md"));
});

test("every loom route refuses an unauthenticated caller", async () => {
  // The bearer gate sits ABOVE this whole block, so one route proving it would
  // be one route's worth of proof — an arm accidentally mounted before the gate
  // is exactly the mistake worth catching, and only the sweep catches it.
  const { daemon } = await looms({ loomRuntime: fakeRuntime().runtime });
  const attempts: Array<[string, string, unknown?]> = [
    ["GET", "/v2/looms"],
    ["GET", "/v2/looms/program?project=project_one"],
    ["PUT", "/v2/looms/program", { projectId: "project_one", markdown: "# Loom" }],
    ["POST", "/v2/looms/program/suggest", { projectId: "project_one" }],
    ["GET", "/v2/looms/ledger?project=project_one"],
    ["GET", "/v2/looms/triage?project=project_one"],
    ["GET", "/v2/looms/work"],
    ["POST", "/v2/looms/watch", { projectId: "project_one", running: true }],
    ["POST", "/v2/looms/tick", { projectId: "project_one" }],
    ["POST", "/v2/looms/dry-run", { projectId: "project_one" }],
    ["POST", "/v2/looms/dispatch", { projectId: "project_one", item: "issue-7" }],
    ["GET", "/v2/looms/loom_one"],
    ["POST", "/v2/looms/loom_one/cancel"],
    ["POST", "/v2/looms/loom_one/answer", { answer: "ship it" }],
  ];
  for (const [method, pathname, body] of attempts) {
    const answer = await call(daemon, method, pathname, { token: null, ...(body === undefined ? {} : { body }) });
    expect([method, pathname, answer.status]).toEqual([method, pathname, 401]);
    expect(answer.body.error.code).toBe("engine_unauthorized");
  }
});

test("a wrong bearer token is refused exactly like a missing one", async () => {
  const { daemon } = await looms();
  const answer = await call(daemon, "GET", "/v2/looms", { token: "not-the-token" });
  expect(answer.status).toBe(401);
});

test("a project with no Program answers exists:false rather than 404", async () => {
  // THE FIRST-RUN STATE. The editor is the thing that fixes it, so it has to be
  // able to open — and it needs the path the file WOULD live at in order to say
  // where it is about to write.
  const { client, projectRoot } = await looms();
  const doc = await client.loomProgram("project_one");
  expect(doc.exists).toBe(false);
  expect(doc.program).toBeNull();
  expect(doc.markdown).toBe("");
  expect(doc.path).toBe(path.join(projectRoot, ".telar", "loom.md"));
});

test("PUT then GET round-trips the Program's markdown", async () => {
  const { client, projectRoot } = await looms();
  const markdown = ["# Loom", "", "## Work source", "", "list: `gh issue list --json number`", ""].join("\n");
  const saved = await client.saveLoomProgram("project_one", markdown);
  expect(saved.exists).toBe(true);
  expect(saved.markdown).toBe(markdown);
  // Through the seam AND on disk, in the project's own repo — the Program is a
  // file the user edits in their checkout, not engine state.
  expect((await client.loomProgram("project_one")).markdown).toBe(markdown);
  expect(fs.readFileSync(path.join(projectRoot, ".telar", "loom.md"), "utf8")).toBe(markdown);
  // And the deck's one-call read agrees with the document read.
  expect((await client.looms()).projects[0]).toMatchObject({ hasProgram: true });
});

test("/v2/looms/program is not swallowed by the :loomId regex", async () => {
  /**
   * THE ORDERING TEST. `^/v2/looms/([^/]+)$` matches `program` perfectly well,
   * so hoisting the id arm above the literal ones turns the Program editor into
   * "loom not found" — a 404 that sends a person to look at their loom list
   * instead of at the route table. Same for `program/suggest`, which a `:loomId`
   * arm with a greedy tail would take.
   */
  const { daemon, client } = await looms({ loomRuntime: fakeRuntime().runtime });
  await client.saveLoomProgram("project_one", "# Loom\n");
  const doc = await call(daemon, "GET", "/v2/looms/program?project=project_one");
  expect(doc.status).toBe(200);
  expect(doc.body.markdown).toBe("# Loom\n");
  expect(doc.body.error).toBeUndefined();
  const suggested = await call(daemon, "POST", "/v2/looms/program/suggest", { body: { projectId: "project_one" } });
  expect(suggested.status).toBe(200);
  expect(suggested.body.findings).toEqual(["the repo has a `gh` remote"]);
  // The id arm still answers for something that IS an id — the literals did not
  // shadow it in the other direction.
  expect((await call(daemon, "GET", "/v2/looms/loom_one")).status).toBe(404);
});

test("an unknown loom id is a 404 that says so", async () => {
  const { client } = await looms();
  const error = (await client.loom("loom_nothing").catch((e: unknown) => e)) as EngineClientError;
  expect(error).toBeInstanceOf(EngineClientError);
  expect(error.status).toBe(404);
  expect(error.code).toBe("not_found");
  expect(error.message).toBe("loom not found");
});

test("a store refusal arrives with its sentence intact, not as a bare 400", async () => {
  /**
   * THE REGRESSION THIS FILE EXISTS FOR. Every one of these rules lives in the
   * store, deliberately, so an in-process caller hits the same wall an HTTP one
   * does — which means the ONLY thing that can go wrong at this layer is the
   * translation losing the words. A status with no sentence is a support ticket.
   */
  const { daemon, client } = await looms({ loomRuntime: fakeRuntime().runtime });

  // A blank answer: the ROUTE does not judge this, the store does — and it says
  // why in a sentence a person can act on.
  const blank = await call(daemon, "POST", "/v2/looms/loom_one/answer", { body: { answer: "   " } });
  expect(blank.status).toBe(400);
  expect(blank.body.error).toEqual({
    code: "invalid_request",
    message: "an answer needs words — an empty one would just close the question",
  });

  // A blank dispatch item, same rule from the same side of the wall.
  const noItem = await call(daemon, "POST", "/v2/looms/dispatch", { body: { projectId: "project_one", item: " " } });
  expect(noItem.status).toBe(400);
  expect(noItem.body.error.message).toBe("a dispatch needs the work item's ref");

  // A project nothing goes by is `not_found`, and the 404 still carries words.
  const unknown = await call(daemon, "GET", "/v2/looms/program?project=project_missing");
  expect(unknown.status).toBe(404);
  expect(unknown.body.error).toEqual({ code: "not_found", message: "project does not exist" });

  // A malformed id never reaches the filesystem: the store's own guard names
  // what is wrong with it rather than composing a path out of it. On the LEDGER
  // arm deliberately — a tolerant reader that swallows its own path guard along
  // with the "never written yet" case answers 200 with an empty ledger, and a
  // traversal that reads as an empty answer is the quietest possible failure.
  const traversal = await call(daemon, "GET", `/v2/looms/ledger?project=${encodeURIComponent("../../etc")}`);
  expect(traversal.status).toBe(400);
  expect(traversal.body.error.message).toBe('invalid project id for the loom store: "../../etc"');
  // The registry's own guard says it differently, and both sentences survive.
  const guarded = await call(daemon, "GET", `/v2/looms/program?project=${encodeURIComponent("../../etc")}`);
  expect(guarded.status).toBe(400);
  expect(guarded.body.error.message).toContain("must contain only letters");
  // And the well-formed-but-never-run project still degrades to empty.
  expect(await client.loomLedger("project_one")).toEqual({ entries: [] });

  // And the typed client surfaces the same words rather than a generic failure.
  const error = (await client.saveLoomProgram("project_missing", "# Loom").catch((e: unknown) => e)) as EngineClientError;
  expect(error.status).toBe(404);
  expect(error.message).toBe("project does not exist");
});

test("the route rejects only what the store cannot see", async () => {
  // A param that never arrived is invisible from inside the store — it would be
  // handed `undefined` and refuse in the vocabulary of ids. These four are the
  // whole list of what this edge judges for itself.
  const { daemon } = await looms({ loomRuntime: fakeRuntime().runtime });

  const noProject = await call(daemon, "GET", "/v2/looms/ledger");
  expect(noProject.status).toBe(400);
  expect(noProject.body.error.message).toContain("?project=");

  const badLimit = await call(daemon, "GET", "/v2/looms/ledger?project=project_one&limit=soon");
  expect(badLimit.status).toBe(400);
  expect(badLimit.body.error.message).toContain("limit must be a positive whole number");

  const noRunning = await call(daemon, "POST", "/v2/looms/watch", { body: { projectId: "project_one" } });
  expect(noRunning.status).toBe(400);
  expect(noRunning.body.error.message).toContain("running must be true to start the watch or false to stop it");

  const noMarkdown = await call(daemon, "PUT", "/v2/looms/program", { body: { projectId: "project_one" } });
  expect(noMarkdown.status).toBe(400);
  expect(noMarkdown.body.error.message).toContain("markdown is required");
});

test("tick and dry-run answer 202 with the run, and are watched through /v2/looms/work", async () => {
  /**
   * 202 IS THE CONTRACT, not a cosmetic choice. A tick spends a model call and
   * can run for minutes; the spool's night proved that awaiting one here makes a
   * working daemon look unreachable. The status is the promise that the answer
   * is a RECEIPT and the work is still going.
   */
  const { daemon, calls } = await (async () => {
    const fake = fakeRuntime();
    return { ...(await looms({ loomRuntime: fake.runtime })), calls: fake.calls };
  })();

  const ticked = await call(daemon, "POST", "/v2/looms/tick", { body: { projectId: "project_one" } });
  expect(ticked.status).toBe(202);
  expect(ticked.body.run).toMatchObject({ id: "run_tick", kind: "tick", state: "running", projectId: "project_one" });

  const dry = await call(daemon, "POST", "/v2/looms/dry-run", { body: { projectId: "project_one" } });
  expect(dry.status).toBe(202);
  expect(dry.body.run).toMatchObject({ kind: "dry-run", state: "running" });

  // Two paths, two verbs — a shared arm that forgot to branch would tick twice.
  expect(calls).toEqual(["tickLoom:project_one", "dryRunLoom:project_one"]);

  const work = await call(daemon, "GET", "/v2/looms/work");
  expect(work.status).toBe(200);
  expect(work.body.runs).toHaveLength(1);
});

test("the wired runtime is reachable: a tick runs the real composer and settles", async () => {
  /**
   * "THE ROUTES EXIST" AND "THE ROUTES DO ANYTHING" ARE DIFFERENT CLAIMS, and
   * every other test in this file only makes the first one — they short-circuit
   * the orchestrator with `loomRuntime`. This one goes through `startEngine`'s
   * own composition: the real run registry, the real supervisor, the real tick.
   *
   * The two expensive ports are injected and NOTHING ELSE IS. No shell is
   * spawned (`loomExec` answers), no model is called (`loomAgent` answers), no
   * rate limit is spent — which is the promise `EngineDaemonOptions` makes and
   * the reason those four options exist.
   */
  const commands: string[] = [];
  const prompts: string[] = [];
  const loomExec: LoomExec = async (input) => {
    commands.push(input.command);
    return { code: 0, stdout: "issue-1\trev-1\n", stderr: "", timedOut: false };
  };
  const loomAgent: LoomAgent = async (prompt) => {
    prompts.push(prompt);
    // A tick that decides to do nothing is a GOOD tick — §3.6's whole point is
    // that idle has to be affordable, so this is the ordinary case, not a stub.
    return { ok: true, value: { triage: [], dispatch: [], park: [], ask: [], note: "nothing worth waking anyone for" } };
  };

  const { daemon, client } = await looms({ loomExec, loomAgent });
  await client.saveLoomProgram(
    "project_one",
    ["# Loom program", "", "## Work source", "", "```probe", "echo 1", "```", "", "```list", "list-items", "```", ""].join("\n"),
  );

  const ticked = await call(daemon, "POST", "/v2/looms/tick", { body: { projectId: "project_one" } });
  expect(ticked.status).toBe(202);
  expect(ticked.body.run).toMatchObject({ projectId: "project_one", kind: "tick", state: "running" });

  // THE RUN IS VISIBLE WHILE IT RUNS — the other half of the 202. A run that
  // only appeared once it finished would make the detached answer a lie.
  const runId: string = ticked.body.run.id;
  let settled = ticked.body.run;
  for (let attempt = 0; attempt < 200 && settled.state === "running"; attempt += 1) {
    const runs = (await client.loomWork()).runs;
    expect(runs.some((run) => run.id === runId)).toBe(true);
    settled = runs.find((run) => run.id === runId)!;
    if (settled.state === "running") await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(settled.state).toBe("done");
  expect(settled.settledAt).toBeGreaterThan(0);

  // It really went through the Program: the injected exec ran the `list`
  // command the markdown declared, and the injected agent was asked once.
  expect(commands.some((command) => command.includes("list-items"))).toBe(true);
  expect(prompts).toHaveLength(1);
});

test("a second tick while one is running answers with the run already going", async () => {
  // ONE TICK PER PROJECT. A human hammering the button gets told about the tick
  // they already started rather than paying for a second one.
  const loomExec: LoomExec = async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { code: 0, stdout: "issue-1\trev-1\n", stderr: "", timedOut: false };
  };
  const loomAgent: LoomAgent = async () => ({ ok: true, value: { triage: [], dispatch: [], park: [], ask: [], note: "" } });
  const { daemon, client } = await looms({ loomExec, loomAgent });
  await client.saveLoomProgram("project_one", ["# Loom program", "", "## Work source", "", "```list", "list-items", "```", ""].join("\n"));

  const first = await call(daemon, "POST", "/v2/looms/tick", { body: { projectId: "project_one" } });
  const second = await call(daemon, "POST", "/v2/looms/tick", { body: { projectId: "project_one" } });
  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  expect(second.body.run.id).toBe(first.body.run.id);
});

test("every route is reachable and answers in its documented envelope", async () => {
  /**
   * THE SWEEP. Fourteen arms, each one asserted for the SHAPE the spec's §15.2
   * table promises — `{loom}` and `{run}` and `{entries}` wrappers, and the two
   * deliberate bare bodies (`GET /v2/looms` and the Program document). A route
   * that answers correct data in the wrong envelope is a client crash, and it is
   * invisible to every test that only checks a status.
   */
  const fake = fakeRuntime();
  const { daemon, client, engineRoot } = await looms({ loomRuntime: fake.runtime });
  const paths = loomPaths(engineRoot);
  writeLoom(paths, loomRecord());
  appendLedger(paths, "project_one", { at: AT, kind: "dispatch", loomId: "loom_one", item: "issue-7", summary: "dispatched issue-7" });
  writeTriage(paths, "project_one", {
    "issue-7": { item: "issue-7", updatedAt: "rev-1", classification: "dispatchable", reason: "it is specified", ask: "do it", at: AT },
  });

  // GET /v2/looms — BARE, like `GET /v2/spool`.
  const overview = await call(daemon, "GET", "/v2/looms");
  expect(overview.status).toBe(200);
  expect(Object.keys(overview.body).sort()).toEqual(["looms", "projects", "runs", "triage", "unreadable"]);
  expect(overview.body.looms).toHaveLength(1);
  expect(overview.body.runs).toHaveLength(1);

  // GET/PUT /v2/looms/program — the document, bare.
  expect((await call(daemon, "PUT", "/v2/looms/program", { body: { projectId: "project_one", markdown: "# Loom\n" } })).status).toBe(200);
  expect((await call(daemon, "GET", "/v2/looms/program?project=project_one")).body.exists).toBe(true);

  // POST /v2/looms/program/suggest — {markdown, findings}.
  expect(await client.suggestLoomProgram("project_one")).toEqual({
    markdown: "# Loom\n\n## Work source\n",
    findings: ["the repo has a `gh` remote"],
  });

  // GET /v2/looms/ledger — {entries}, newest first, `?limit=` honoured.
  expect(await client.loomLedger("project_one")).toEqual({
    entries: [{ at: AT, kind: "dispatch", loomId: "loom_one", item: "issue-7", summary: "dispatched issue-7" }],
  });
  expect((await client.loomLedger("project_one", 1)).entries).toHaveLength(1);

  // GET /v2/looms/triage — {entries}, a LIST even though disk keys it by item.
  const triage = await client.loomTriage("project_one");
  expect(triage.entries).toHaveLength(1);
  expect(triage.entries[0]).toMatchObject({ item: "issue-7", classification: "dispatchable" });

  // GET /v2/looms/work — {runs}.
  expect((await client.loomWork()).runs[0]).toMatchObject({ kind: "tick" });

  // POST /v2/looms/watch — {watch}, one slot and a flag.
  expect((await client.setLoomWatch("project_one", true)).watch).toMatchObject({ running: true });
  expect((await client.setLoomWatch("project_one", false)).watch).toMatchObject({ running: false });

  // POST /v2/looms/dispatch — {loom}, with the optional halves passed through
  // only when they were actually stated.
  expect((await client.dispatchLoom("project_one", { item: "issue-9" })).loom).toMatchObject({ item: "issue-9" });
  await client.dispatchLoom("project_one", { item: "issue-9", title: "Nine", brief: "do the ninth" });

  // GET /v2/looms/:loomId — {loom}, wrapped here because the store answers bare.
  const one = await call(daemon, "GET", "/v2/looms/loom_one");
  expect(one.status).toBe(200);
  expect(one.body).toEqual({ loom: loomRecord() });

  // POST /v2/looms/:loomId/cancel and /answer — {loom}.
  expect((await client.cancelLoom("loom_one")).loom).toMatchObject({ id: "loom_one", state: "cancelled" });
  expect((await client.answerLoom("loom_one", "ship it")).loom).toMatchObject({ id: "loom_one" });

  // The ids and flags actually reached the runtime — the path and body parsing
  // is half of what these arms do, and a right-looking answer proves none of it.
  expect(fake.calls).toEqual([
    // The deck's one read asks the runtime for its in-flight runs, first thing.
    "loomWork",
    "suggestLoomProgram:project_one",
    "loomWork",
    "startLoomWatch:project_one",
    "stopLoomWatch:project_one",
    "dispatchLoom:project_one:issue-9:-:-",
    "dispatchLoom:project_one:issue-9:Nine:do the ninth",
    "cancelLoom:loom_one",
    "answerLoom:loom_one:ship it",
  ]);
});

test("a path param arrives decoded, and a slash in it does not become a route", async () => {
  // `decodeURIComponent` on the capture, and `[^/]+` around it: an id with a
  // percent-encoded space is one id, and an id with a real slash is simply not
  // this route rather than a silently truncated lookup.
  const fake = fakeRuntime();
  const { daemon } = await looms({ loomRuntime: fake.runtime });
  expect((await call(daemon, "POST", "/v2/looms/loom%20one/cancel")).status).toBe(200);
  expect(fake.calls).toEqual(["cancelLoom:loom one"]);
  expect((await call(daemon, "GET", "/v2/looms/project_one/looms/x")).status).toBe(404);
});

test("the orchestrator session is ensured rather than created twice", async () => {
  /**
   * CREATE-OR-RETURN, and `created` is the whole reason this is one route
   * instead of two: the cockpit opens a project without knowing whether anyone
   * ever has, and a "create" that fails on the second visit would make every
   * caller do the two-step. This is the CONVERSATION — the tick is headless and
   * keeps no transcript, which is the design's answer to context growth.
   */
  const fake = fakeRuntime();
  const { daemon, client } = await looms({ loomRuntime: fake.runtime });
  const first = await call(daemon, "POST", "/v2/looms/session", { body: { projectId: "project_one" } });
  expect(first.status).toBe(200);
  expect(first.body).toEqual({ sessionId: "session_project_one", created: true });
  expect(await client.ensureLoomSession("project_one")).toEqual({ sessionId: "session_project_one", created: false });
  expect(fake.calls).toEqual(["ensureLoomSession:project_one", "ensureLoomSession:project_one"]);

  // And it is a LITERAL path: mounted before the `:loomId` regex, or "session"
  // reads as a loom id and this answers 404.
  expect((await call(daemon, "POST", "/v2/looms/session", { body: {} })).status).toBe(400);
});

test("a watch a human turned on survives a daemon restart and keeps probing", async () => {
  /**
   * THE RESTART IS THE TEST. `running` is persisted on the watch record, so a
   * daemon that comes back up without re-arming the sentinel reports
   * `watch.running: true` from `loomOverview` and draws "watching" on the deck
   * while probing exactly zero times — an overnight run that stopped at the
   * first restart and still claims otherwise. This asserted zero probes before
   * `startEngine` called `resume()`.
   *
   * TWO DAEMONS OVER ONE ENGINE ROOT, so the second reads the first's disk, and
   * a one-second cadence in the Program so the second one is due again inside a
   * test's patience rather than five minutes later. The probe command is
   * injected, so "it probed" is counted rather than shelled.
   */
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-loom-restart-"));
  roots.push(directory);
  const engineRoot = path.join(directory, "engine");
  fs.mkdirSync(path.join(directory, "repo"), { recursive: true });
  const projectRoot = fs.realpathSync.native(path.join(directory, "repo"));

  const probes: string[][] = [[], []];
  const execFor = (sink: string[]): LoomExec => async (input) => {
    sink.push(input.command);
    return { code: 0, stdout: "one-line-fingerprint\n", stderr: "", timedOut: false };
  };
  const program = [
    "# Loom program",
    "",
    "## Work source",
    "",
    "```probe",
    "probe-me",
    "```",
    "",
    "```list",
    "list-items",
    "```",
    "",
    "## When to look",
    "",
    "every 1s, backing off to 2s",
    "",
  ].join("\n");

  const first = await startEngine({ engineRoot, loomExec: execFor(probes[0]), loomAgent: QUIET_AGENT });
  daemons.push(first);
  const before = new EngineClient(first.discovery);
  await before.registerProject({ id: "project_one", name: "One", root: projectRoot });
  await before.saveLoomProgram("project_one", program);
  expect((await before.setLoomWatch("project_one", true)).watch.running).toBe(true);
  await probed(probes[0]);
  const parked = (await before.looms()).projects[0]!.watch;
  // Closed, not abandoned — the supervisor's interval has to come down with the
  // daemon that armed it, or this suite hangs instead of failing.
  await first.close();
  daemons.splice(daemons.indexOf(first), 1);

  const second = await startEngine({ engineRoot, loomExec: execFor(probes[1]), loomAgent: QUIET_AGENT });
  daemons.push(second);
  const after = new EngineClient(second.discovery);
  // The record still says running — which is precisely why it has to BE running.
  const resumed = (await after.looms()).projects[0]!.watch;
  expect(resumed.running).toBe(true);
  /**
   * ARMED IS ANSWERABLE FROM THE RECORD ALONE — `running` plus the PRESENCE of
   * `nextProbeAt`, which `defaultWatch` deliberately omits (see
   * `readWatchRecord`: the omission is the signal, not an oversight). Asserted
   * here, before the probe wait below, so a resume that regressed to a no-op
   * fails in milliseconds with the right sentence instead of after fifteen
   * seconds of polling and a claim about the sentinel never running.
   */
  expect(typeof resumed.nextProbeAt).toBe("number");
  /**
   * RESUMED, NOT RESTARTED. `startLoomWatch` is the workaround that looks
   * equivalent and is not: it rebases `quietChecks` and `nextProbeAt`, so a
   * reboot would read as a human pressing the button and spend the backoff a
   * quiet night earned. These two fields surviving is what says which happened.
   */
  expect(resumed.quietChecks).toBe(parked.quietChecks);
  expect(resumed.lastProbeAt).toBe(parked.lastProbeAt);

  // And the sentinel is genuinely armed on the new process, not merely claimed.
  await probed(probes[1]);
  // 60s rather than the default 5: this waits on the sentinel's real cadence
  // twice, across two daemon starts, and it must not be the thing that fails
  // when the box is busy. It finishes in ~2s when nothing is competing.
}, 60_000);

/**
 * Wait for the sentinel to run the Program's `probe` at least once.
 *
 * POLLED RATHER THAN SLEPT ON A FIXED DELAY: the supervisor's cadence is its
 * own business, and a hard-coded wait is how this test would start flaking.
 *
 * THE CAP IS DELIBERATELY GENEROUS — 45s, under a 60s test budget — and that
 * costs nothing, because this returns the instant the probe lands (~1s idle).
 * A ceiling is only ever paid on the failure path, so buying it cheaply buys
 * out a whole class of load flake.
 *
 * IT WAS 4s, WHICH LIED. That made this the tighter of two nested deadlines, so
 * a loaded machine produced the sentence below — a FALSE STATEMENT about the
 * system rather than a failure of it, since a one-second cadence does not
 * reliably fire inside 4s while 58 files and several agents' suites compete for
 * the box. An inner timeout shorter than the outer one does not make a test
 * stricter, it makes it fail for the wrong reason and name the wrong culprit.
 * If this throws now, the sentinel really is not running.
 */
async function probed(commands: string[]): Promise<void> {
  for (let attempt = 0; attempt < 4_500; attempt += 1) {
    if (commands.some((command) => command.includes("probe-me"))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the sentinel never ran the Program's probe command");
}

test("a daemon restarted right after a probe waits out the cadence instead of probing on sight", async () => {
  /**
   * THE RESTART-LOOP QUOTA DRAIN, pinned.
   *
   * The test above proves a resumed sentinel is armed; it CANNOT prove this,
   * because it declares a one-second cadence and at one second "probes on
   * sight" and "waits out the remainder" are indistinguishable. So this one
   * runs at the default 300s and asserts the opposite of a probe.
   *
   * WHY IT MATTERS MORE THAN IT LOOKS: a daemon that probed on sight would turn
   * a crash loop into a quota drain — a process dying and restarting every ten
   * seconds fires the Program's `probe` every ten seconds, and the sentinel's
   * whole "idle is free" claim is defeated by something that never touches the
   * sentinel's logic. Both cases fall out of the one rule: a daemon down for six
   * hours has a `nextProbeAt` long past and sweeps immediately; this one, back
   * up moments after a probe, waits.
   *
   * `nextProbeAt` SURVIVING IS THE WHOLE ASSERTION. It is the field that carries
   * the remaining cadence, and a resume that re-baselined it would still pass
   * every other check in this file.
   */
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-loom-cadence-"));
  roots.push(directory);
  const engineRoot = path.join(directory, "engine");
  fs.mkdirSync(path.join(directory, "repo"), { recursive: true });
  const projectRoot = fs.realpathSync.native(path.join(directory, "repo"));

  const probes: string[][] = [[], []];
  const execFor = (sink: string[]): LoomExec => async (input) => {
    sink.push(input.command);
    return { code: 0, stdout: "one-line-fingerprint\n", stderr: "", timedOut: false };
  };
  // No `## When to look`, so the Program takes the default 300s cadence — the
  // one a real project ships with, and the one that makes this test meaningful.
  const program = ["# Loom program", "", "## Work source", "", "```probe", "probe-me", "```", "", "```list", "list-items", "```", ""].join("\n");

  const first = await startEngine({ engineRoot, loomExec: execFor(probes[0]), loomAgent: QUIET_AGENT });
  daemons.push(first);
  const before = new EngineClient(first.discovery);
  await before.registerProject({ id: "project_one", name: "One", root: projectRoot });
  await before.saveLoomProgram("project_one", program);
  await before.setLoomWatch("project_one", true);
  await probed(probes[0]);
  const parked = (await before.looms()).projects[0]!.watch;
  expect(parked.nextProbeAt).toBeGreaterThan(parked.lastProbeAt!);
  await first.close();
  daemons.splice(daemons.indexOf(first), 1);

  const second = await startEngine({ engineRoot, loomExec: execFor(probes[1]), loomAgent: QUIET_AGENT });
  daemons.push(second);
  const resumed = (await new EngineClient(second.discovery).looms()).projects[0]!.watch;
  // Armed and running, with every field of the cadence carried across intact —
  // not one of them rebased to "now" by the restart.
  expect(resumed.running).toBe(true);
  expect(resumed.nextProbeAt).toBe(parked.nextProbeAt);
  expect(resumed.quietChecks).toBe(parked.quietChecks);
  expect(resumed.lastProbeAt).toBe(parked.lastProbeAt);

  // And it stays quiet. Several poll cycles' worth of patience: the supervisor
  // looks every second, so this is not a window that happened to be too small.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect(probes[1].filter((command) => command.includes("probe-me"))).toEqual([]);
  /**
   * 60s for symmetry with the test above, though this one CANNOT flake under
   * load in the way that one could: it asserts the ABSENCE of a probe, and a
   * busy machine can only delay work, never invent it. Load makes this test
   * more likely to pass, which is its own reason to trust a failure here.
   */
}, 60_000);

test("a tick never loads the provider SDK — the injected ports are the only road to one", async () => {
  /**
   * THE STANDING VERSION OF A MEASUREMENT THAT WAS ONCE A HABIT.
   *
   * This file already spent somebody's rate limit once, in a way NOTHING in a
   * pass count could show: `startEngine` began wiring a real `loomAgent` where
   * a refusing placeholder had been, two tests here injected only `loomExec`,
   * and the first probe on a fresh project — which always looks like a change,
   * having no previous fingerprint — woke a tick that reached the machine's own
   * Claude Code. Green suite, correct assertions, real money. The only signal
   * was a CLI version banner in output nobody was reading.
   *
   * The harness now defaults both expensive ports, so that specific hole is
   * shut. This is the guard for the NEXT one: a habit of checking is not a
   * property, and the person who reintroduces this will not be the person who
   * remembers to look.
   *
   * A DELTA, NOT AN ABSOLUTE. `bun test` may share a process across files, and
   * `cli-resolution.test.ts` legitimately resolves provider CLIs — so "the SDK
   * is absent" is not this test's to assert. "MY tick did not load it" is, and
   * that is the claim that would have caught the original leak.
   */
  const registry = (globalThis as { Loader?: { registry?: Map<string, unknown> } }).Loader?.registry;
  if (!registry) {
    // Loud rather than skipped. A guard that quietly stops guarding is the
    // exact failure mode this whole test exists to prevent.
    throw new Error(
      "this guard reads Bun's module registry to prove a tick loads no provider SDK, and that internal is gone — rewire the probe rather than deleting the test",
    );
  }
  const sdkLoaded = (): boolean => [...registry.keys()].some((key) => key.includes("claude-agent-sdk"));
  const before = sdkLoaded();

  // A REAL tick through the real composer — the path that would reach a model
  // if the ports were not injected. Anything less proves nothing.
  const commands: string[] = [];
  const { daemon, client } = await looms({
    loomExec: async (input) => {
      commands.push(input.command);
      return { code: 0, stdout: "issue-1\trev-1\n", stderr: "", timedOut: false };
    },
    loomAgent: async () => ({ ok: true, value: { triage: [], dispatch: [], park: [], ask: [], note: "" } }),
  });
  await client.saveLoomProgram(
    "project_one",
    ["# Loom program", "", "## Work source", "", "```list", "list-items", "```", ""].join("\n"),
  );
  const ticked = await call(daemon, "POST", "/v2/looms/tick", { body: { projectId: "project_one" } });
  expect(ticked.status).toBe(202);

  const runId: string = ticked.body.run.id;
  let run = ticked.body.run;
  for (let attempt = 0; attempt < 4_500 && run.state === "running"; attempt += 1) {
    run = (await client.loomWork()).runs.find((candidate) => candidate.id === runId) ?? run;
    if (run.state === "running") await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The tick really ran the Program — otherwise this asserts nothing at all.
  expect(run.state).toBe("done");
  expect(commands.some((command) => command.includes("list-items"))).toBe(true);

  expect(sdkLoaded()).toBe(before);
}, 60_000);
