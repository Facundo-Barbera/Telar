/**
 * The `sessions` toolkit — one session creating and driving others.
 *
 * ── EVERYTHING HERE RUNS AGAINST A REAL STORE AND A REAL GIT REPOSITORY ─────
 * There is no fake capability in this file, deliberately. A stub that answered
 * every member with a plausible success would assert that the WALL composes
 * sentences and nothing about whether the rules those sentences describe exist
 * — and the rules are the whole feature: the env mode is the store's, the
 * refusal sentences are the store's. So the capability
 * below is the same seven-member object the daemon's socket builds, over an
 * `EngineStore` on a temporary root, and `envMode: "worktree"` cuts an actual
 * worktree off an actual repository. Nothing here starts a session, spawns a
 * provider or spends a token: a turn is SUBMITTED and never claimed, because no
 * worker is registered.
 *
 * ── MOST OF THIS FILE ASSERTS AN ABSENCE ────────────────────────────────────
 * This wall's contract is mostly what it cannot do, and a
 * comment claiming a negative is worth nothing:
 *   · nothing accept-shaped, and nothing that archives or deletes (INV-1);
 *   · nothing that records WHO created a session — no parent, no child, no
 *     link, which is the design under test rather than a gap in it;
 *   · NO cap on creation — asserted, not assumed, because the prose says so;
 *   · every one of these tools denied to a warp child.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { worktreeReady } from "./worktree-ready";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertTelarToolNames, parseToolName, qualifyTelarTool, TELAR_CAPABILITIES } from "@telar/engine-client";
import { EngineStore } from "../src/state";
import { sessionsTools, pageEvents, type SessionsCapability } from "../src/sessions-tools/tools";
import { TELAR_SKILL } from "../src/orientation";
import { collectSessionsWallTools } from "../src/sessions-tools/socket";
import { toolInputSchema } from "../src/mcp-socket";
import { WARP_CHILD_DISALLOWED_TOOLS } from "../src/warp/spawn";

/**
 * A Claude default this temp home already knows, so a claim is not withheld
 * waiting for a model list nobody is going to read here. Real homes learn this
 * from the provider; see `rememberClaudeDefault`.
 */
function knownClaudeDefault(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
}


const roots: string[] = [];
const tmp = (prefix: string): string => {
  const directory = knownClaudeDefault(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A throwaway repository with one commit, so `HEAD` resolves and a worktree
 *  can actually be cut off it. The house idiom — see `worktree.test.ts`. */
function repo(): string {
  const root = tmp("telar-sessions-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

type Registered = {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
};

/**
 * THE CAPABILITY IS THE DAEMON'S OWN, byte for byte — every member delegating
 * to a `store.*` call and `origin: "session"` declared by this code rather than
 * by any argument. If this object and `daemon.ts`'s ever diverge, the socket
 * test's parity assertion is what notices.
 */
function capabilityOver(store: EngineStore, self?: { sessionId: string }): SessionsCapability {
  return {
    ...(self ? { self } : {}),
    list: async () => store.liveSessions(),
    create: async (input) => store.createSession({ ...input, origin: "session" }),
    send: async (sessionId, input) => store.submitAgentTurn(sessionId, input),
    read: async (sessionId, after) => store.readEvents(sessionId, after),
    status: async (sessionId) => ({ session: store.getSession(sessionId), turns: store.turns(sessionId) }),
    // The same wiring the daemon uses: an agent's stop IS a stop.
    stop: async (sessionId) => store.stopSession(sessionId, "agent"),
    settle: async (sessionId, settled) => store.updateSession(sessionId, { settledOverride: settled ? "settled" : "active" }),
    diff: async (sessionId) => store.sessionDiff(sessionId),
    subscribe: async (subscriber, input) => store.subscribe(subscriber, input),
    unsubscribe: async (id, subscriber) => store.unsubscribe(id, subscriber),
    subscriptions: async (subscriber) => store.subscriptionsFor(subscriber),
    requests: async (sessionId) => store.requests(sessionId),
    resolveRequest: async (sessionId, requestId, input) => store.resolveRequest(sessionId, requestId, { ...input, resolvedBy: "session" }),
  };
}

const WALL_NAMES = [
  "sessions_list",
  "sessions_create",
  "sessions_send",
  "sessions_read",
  "sessions_status",
  "sessions_stop",
  "sessions_settle",
  "sessions_diff",
  "sessions_subscribe",
  "sessions_unsubscribe",
  "sessions_subscriptions",
  "sessions_requests",
  "sessions_resolve_request",
];

function wall(store: EngineStore, self?: { sessionId: string }): Map<string, Registered> {
  const registered = new Map<string, Registered>();
  sessionsTools(
    (name, description, shape, run) => {
      registered.set(name, { name, description, shape, run });
      return { name };
    },
    capabilityOver(store, self),
  );
  return registered;
}

/** A store on a fresh engine root with one registered project. */
function engine(): { store: EngineStore; projectId: string; projectRoot: string } {
  const projectRoot = repo();
  const store = new EngineStore(tmp("telar-sessions-state-"));
  const project = store.registerProject({ name: "aurora", root: projectRoot });
  return { store, projectId: project.id, projectRoot };
}

/** The JSON a tool answered with, or the error text when it refused. */
async function call(tools: Map<string, Registered>, name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool named ${name} on the wall`);
  const result = await tool.run(args);
  const text = (result.content[0] as { text: string }).text;
  return { isError: result.isError === true, text, json: result.isError ? undefined : (JSON.parse(text) as Record<string, unknown>) };
}

// ── the wall's shape ────────────────────────────────────────────────────────

describe("what the wall is", () => {
  test("exactly thirteen tools, every one declaring the `sessions` capability in its name", () => {
    const { store } = engine();
    const names = [...wall(store).keys()];
    // PINNED AS A SET, not merely counted: a tool added here has to be added
    // deliberately, and the socket's parity test then requires it to appear on
    // the socket in the same change.
    expect(names).toEqual(WALL_NAMES);
    expect(() => assertTelarToolNames(names)).not.toThrow();
    expect(TELAR_CAPABILITIES).toContain("sessions");
    // The capability is legible in the qualified name a model actually sees —
    // which is what keeps these out of the generic `mcp__` bucket.
    expect(parseToolName(qualifyTelarTool("sessions_create")).capability).toBe("sessions");
  });

  test("nothing on this wall lands work — no accept, no merge, no archive, no delete", () => {
    const { store } = engine();
    const tools = [...wall(store).values()];
    // INV-1's rule, held at the source rather than only by the invariant scan:
    // this file registers tools through a factory argument rather than
    // `createSdkMcpServer`, so INV-1c's surface scan never sees it.
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/accept|approve|merge|land|ship|deliver|promote|finish|complete|done|close|archive|delete|remove/);
      expect(tool.description.length).toBeGreaterThan(0);
    }
    // ANTI-VACUITY: the same predicate over names that SHOULD trip it.
    for (const rogue of ["sessions_accept", "sessions_merge", "sessions_archive", "sessions_delete"]) {
      expect(rogue).toMatch(/accept|approve|merge|land|ship|deliver|promote|finish|complete|done|close|archive|delete|remove/);
    }
  });

  test("the prose says what no check here can enforce: this is not a way around a refusal", () => {
    const { store } = engine();
    const tools = wall(store);
    // The rule lives in words because there is nothing to check it against —
    // the created session is a peer with its own boundary and no link back.
    // The three verbs that could be bent into laundering all carry it.
    for (const name of ["sessions_create", "sessions_send", "sessions_resolve_request"]) {
      expect(tools.get(name)!.description).toContain("Never hand a peer work you were refused");
    }
    // And the read-only ones do NOT, so the sentence stays meaningful rather
    // than becoming boilerplate on every tool.
    expect(tools.get("sessions_list")!.description).not.toContain("refused");
  });
});

// ── creating: a peer, with no link to anybody ───────────────────────────────

describe("creating a session", () => {
  test("a worktree session gets a real checkout of its own, and nothing is queued in it", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const created = await call(tools, "sessions_create", { projectId, title: "port the parser", envMode: "worktree" });

    expect(created.isError).toBe(false);
    const id = created.json!.id as string;
    expect(created.json!.envMode).toBe("worktree");
    // Branch slugs come from the WORK, not the machinery (d3e615b):
    // `telar/<title-slug>-<id6>` when the session has a usable title.
    expect(created.json!.branch).toBe(`telar/port-the-parser-${id.replace(/^session_/, "").slice(0, 6)}`);
    // A REAL CHECKOUT, on disk, off the real repository — once the background
    // cut lands (#496). The tool answered before it did, which is the point.
    const session = store.getSession(id);
    expect(session.preparation).toMatchObject({ state: "preparing" });
    await worktreeReady(store, id);
    expect(fs.existsSync(path.join(session.workspace.path, "README.md"))).toBe(true);
    // CREATING STARTS NOTHING. The note says so and the queue agrees.
    expect(store.turns(id)).toEqual([]);
    expect(String(created.json!.note)).toContain("Nothing is queued and nothing has started");
  });

  test("a local session shares the project's checkout, and says so", async () => {
    const { store, projectId, projectRoot } = engine();
    const created = await call(wall(store), "sessions_create", { projectId, envMode: "local" });
    // `realpathSync` because macOS hands out /var/… and resolves it to
    // /private/var/… — the registry stores the resolved one.
    expect(store.getSession(created.json!.id as string).workspace.path).toBe(fs.realpathSync(projectRoot));
    expect(created.json!.branch).toBeUndefined();
  });

  test("NOTHING records who created it — no parent, no child, no link", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    // A session that could plausibly be "the parent", created first.
    const creator = store.createSession({ projectId, title: "the one doing the asking" });
    const created = await call(tools, "sessions_create", { projectId, envMode: "local" });
    const madeId = created.json!.id as string;

    // The stored document mentions the creator NOWHERE — not as a field, not
    // inside the title, not anywhere. This is the design under test: the two
    // are peers the moment the second exists.
    const stored = fs.readFileSync(path.join(store.paths.sessions, madeId, "session.json"), "utf8");
    expect(stored).not.toContain(creator.id);
    // What IS recorded is provenance, which is a count and not a link: it says
    // an agent asked, never WHICH agent.
    expect(store.getSession(madeId).origin).toBe("session");
    // …and the SOCKET's capability carries no identity to record one with. A
    // turn's does (`self`) — for subscriptions, which are recorded on the
    // subscription and on neither session.
    expect(Object.keys(capabilityOver(store)).sort()).toEqual([
      "create", "diff", "list", "read", "requests", "resolveRequest", "send", "settle", "status", "stop", "subscribe", "subscriptions", "unsubscribe",
    ]);
  });

  test("a project that does not exist refuses with the store's own sentence", async () => {
    const { store } = engine();
    const refused = await call(wall(store), "sessions_create", { projectId: "nope", envMode: "local" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("nope");
  });
});

// ── no cap ──────────────────────────────────────────────────────────────────

describe("there is no cap on creation", () => {
  test("twelve agent-made sessions succeed, and the prose promises no cap", async () => {
    // There used to be a live-session budget of eight. It was removed when a
    // session was allowed to orchestrate many; this pins that the store no
    // longer refuses on a count AND that the wall's own description stopped
    // promising one — a description that lied would teach a model to hoard.
    const { store, projectId } = engine();
    const tools = wall(store);
    for (let n = 0; n < 12; n++) {
      expect((await call(tools, "sessions_create", { projectId, envMode: "local", title: `worker ${n}` })).isError).toBe(false);
    }
    expect(store.liveSessions().sessions.filter((session) => session.origin === "session")).toHaveLength(12);
    // The DESCRIPTION promises no cap by saying nothing about one — the
    // discipline that used to live in it moved to the telar skill when every
    // description was cut to 350 characters (#515), and it is asserted there
    // rather than left to be believed. A description that promised a cap would
    // teach a model to hoard; a skill that dropped the discipline would teach
    // it that peers are free.
    const create = tools.get("sessions_create")!.description;
    expect(create).not.toContain("cap");
    expect(TELAR_SKILL).toContain("There is no cap, so the discipline is");
    expect(TELAR_SKILL).toContain("Create what the work needs and nothing more");
  });

  test("a refused create leaves NO worktree behind", async () => {
    // A refusal for any reason must not leave a checkout lying on disk. The
    // one refusal that remains is a project that does not exist.
    const { store, projectId } = engine();
    const made = store.createSession({ projectId, envMode: "worktree", origin: "session" });
    // The directory the count is taken against is made by the background cut,
    // so wait for the first one before counting (#496).
    await worktreeReady(store, made.id);
    const worktrees = path.join(store.paths.root, "worktrees");
    const before = fs.readdirSync(worktrees).length;
    expect(() => store.createSession({ projectId: "project_nope", envMode: "worktree", origin: "session" })).toThrow();
    expect(fs.readdirSync(worktrees).length).toBe(before);
  });
});

// ── driving ─────────────────────────────────────────────────────────────────

describe("driving a session", () => {
  test("send defaults to passive activity and does not promise an answer", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    const sent = await call(tools, "sessions_send", { sessionId: id, input: "routine checkpoint" });
    expect(sent.isError).toBe(false);
    expect(sent.json!.delivery).toBe("passive");
    expect(String(sent.json!.note)).toContain("No model was started or steered");
    expect(store.claimTurn(id, "worker_test")).toBeUndefined();
  });

  test("send queues one turn and says plainly that it is not the answer", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    const sent = await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "read the parser and report" });
    expect(sent.isError).toBe(false);
    expect(sent.json!.state).toBe("queued");
    expect(String(sent.json!.note)).toContain("Accepted for execution, not answered");
    expect(store.turns(id).map((turn) => turn.input)).toEqual(["read the parser and report"]);
    // THE RUN ID IS THE WALL'S, not a caller's: nothing in the argument shape
    // can carry one, so two messages can never collide on one.
    expect(tools.get("sessions_send")!.shape).not.toHaveProperty("runId");
  });

  test("status answers the question it exists for as a boolean, not an inference", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    const idle = await call(tools, "sessions_status", { sessionId: id });
    expect(idle.json!.running).toBe(false);
    expect(String(idle.json!.note)).toContain("Nothing is running");

    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "go" });
    const busy = await call(tools, "sessions_status", { sessionId: id });
    expect(busy.json!.running).toBe(true);
    expect((busy.json!.turns as unknown[]).length).toBe(1);
  });

  test("settle shelves a session without archiving it, and a new message lifts it back", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    const settled = await call(tools, "sessions_settle", { sessionId: id });
    expect(settled.isError).toBe(false);
    expect(settled.json).toMatchObject({ sessionId: id, settled: true });
    expect(String(settled.json!.note)).toContain("Nothing was archived");
    expect(store.getSession(id)).toMatchObject({ state: "active", settledOverride: "settled" });

    // Still live: a message lifts it, exactly as one typed by a person would.
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "one more thing" });
    expect(store.getSession(id).settledOverride).toBeUndefined();

    const back = await call(tools, "sessions_settle", { sessionId: id, settled: false });
    expect(store.getSession(id).settledOverride).toBe("active");
    expect(String(back.json!.note)).toContain("Back in the active list");

    const missing = await call(tools, "sessions_settle", { sessionId: "session_nope" });
    expect(missing.isError).toBe(true);
  });

  test("stop STOPS the session: the running turn ends, what was queued is settled, and it is idle after", async () => {
    // `sessions_stop` used to mean PAUSE — an agent stopping a peer latched it
    // until a person pressed Resume, while the Stop button did something else.
    // One verb now, whoever presses it.
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "go" });
    const claimed = store.claimTurn(id, "worker_one")!;
    store.markRunning(id, claimed.runId, claimed.claim!.token);
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "and then this" });

    const stopped = await call(tools, "sessions_stop", { sessionId: id });
    expect(stopped.json!).toMatchObject({ stopped: 2, runId: claimed.runId, state: "stopped" });
    expect(String(stopped.json!.note)).toContain("stopping ends work, it never undoes it");
    expect(String(stopped.json!.note)).toContain("IDLE now, not paused");
    // No latch anywhere.
    expect(store.getSession(id).paused).toBeUndefined();
    const [first, second] = store.turns(id);
    expect(first!.state).toBe("stopped");
    // The waiting message is settled, not held — and its words survive.
    expect(second).toMatchObject({ state: "stopped", stopReason: "agent", input: "and then this" });
    expect(second!.held).toBeUndefined();
    // Nothing left to dispatch, and no resume verb because nothing is paused.
    expect(store.claimNextTurn("worker_two")).toBeUndefined();
    expect([...tools.keys()]).not.toContain("sessions_resume");

    // THE NEXT MESSAGE JUST RUNS.
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "carry on" });
    expect(store.claimNextTurn("worker_two")?.turn.input).toBe("carry on");

    // Stopping an idle session says so rather than erroring.
    const again = await call(tools, "sessions_stop", { sessionId: id });
    expect(again.isError).toBe(false);
  });

  test("diff reads the session's own checkout and says it accepts nothing", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "worktree" })).json!.id as string;
    await worktreeReady(store, id);
    fs.writeFileSync(path.join(store.getSession(id).workspace.path, "new-file.txt"), "written by the session\n");

    const diff = await call(tools, "sessions_diff", { sessionId: id });
    expect((diff.json!.files as Array<{ path: string }>).map((file) => file.path)).toContain("new-file.txt");
    expect(String(diff.json!.note)).toContain("Nothing here merges, lands or approves");
  });

  test("a session that does not exist refuses identically on every verb", async () => {
    const { store } = engine();
    const tools = wall(store);
    for (const name of ["sessions_send", "sessions_read", "sessions_status", "sessions_diff"]) {
      const refused = await call(tools, name, { sessionId: "session_nope", input: "x" });
      expect(refused.isError).toBe(true);
      // The store's own sentence, carried out rather than replaced.
      expect(refused.text).toContain("session does not exist");
    }
  });

  test("list shows every live session across projects, and the projects one could be made in", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const made = (await call(tools, "sessions_create", { projectId, title: "made by an agent", envMode: "local" })).json!.id as string;
    const byHand = store.createSession({ projectId, title: "made by a person" }).id;
    const gone = store.createSession({ projectId, title: "finished" }).id;
    store.archiveSession(gone);

    const listed = await call(tools, "sessions_list");
    const ids = (listed.json!.sessions as Array<{ id: string; project: string }>).map((session) => session.id);
    expect(ids).toContain(made);
    // A PEER LIST, not a list of what this session made: a person's session is
    // on it exactly as an agent's is, and nothing distinguishes them.
    expect(ids).toContain(byHand);
    expect(ids).not.toContain(gone);
    expect((listed.json!.projects as Array<{ id: string; name: string }>)[0]!.name).toBe("aurora");
    // The project is named as a person would read it, not only as an id.
    expect((listed.json!.sessions as Array<{ project: string }>)[0]!.project).toBe("aurora");
  });
});

// ── the bound on read ───────────────────────────────────────────────────────

/** Mirrors `MAX_RESULT_CHARS` in the wall: a slice budget, not a limit on what
 *  is retrievable. Stated here so the test says why 20 000 characters is enough
 *  to need more than one slice. */
const MAX_RESULT_CHARS_EXPECTED = 8_000;

describe("sessions_read is bounded", () => {
  test("a long journal comes back as a page that SAYS it is one, with a cursor that skips nothing", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    // Real journal traffic: a send through the wall, then the engine's
    // single-run stop — two events a lap that never fill the queue (a stopped
    // turn is not a queued one). NOT `sessions_stop`: that pauses the
    // session, and every send after the first would be held.
    for (let lap = 0; lap < 40; lap++) {
      await call(tools, "sessions_send", { intent: "task", sessionId: id, input: `message ${lap}` });
      store.stopTurn(id);
    }
    const whole = store.readEvents(id, 0);
    expect(whole.length).toBeGreaterThan(50);

    // `from: "start"` IS THE OLD DEFAULT, kept and named (#515). The bare call
    // now reads the END of the journal — asserted below.
    const first = await call(tools, "sessions_read", { sessionId: id, from: "start" });
    const page = first.json!.events as Array<{ id: number }>;
    expect(first.json!.more).toBe(true);
    expect(page.length).toBeLessThanOrEqual(50);
    // THE CURSOR IS THE LAST EVENT ON THE PAGE, never the last one read — a
    // cursor that ran ahead would silently drop everything the budget trimmed.
    expect(first.json!.cursor).toBe(page.at(-1)!.id);
    expect(String(first.json!.note)).toContain("A PAGE, not the whole journal");
    expect(String(first.json!.note)).toContain(`after: ${first.json!.cursor}`);

    // Paging forward loses NOTHING: the pages, concatenated, are the journal.
    // Only the rows a page is allowed to drop are missing — `verbose` keeps
    // them, so this walk asks for them and expects every id back.
    const seen: number[] = (
      (await call(tools, "sessions_read", { sessionId: id, from: "start", verbose: true })).json!.events as Array<{ id: number }>
    ).map((event) => event.id);
    let cursor = seen.at(-1)!;
    let more = true;
    for (let guard = 0; more && guard < 20; guard++) {
      const next = await call(tools, "sessions_read", { sessionId: id, after: cursor, verbose: true });
      for (const event of next.json!.events as Array<{ id: number }>) seen.push(event.id);
      cursor = next.json!.cursor as number;
      more = next.json!.more === true;
    }
    expect(more).toBe(false);
    expect(seen).toEqual(whole.map((event) => event.id));
  });

  /**
   * ── THE DEFAULT IS THE END OF THE JOURNAL (#515) ──────────────────────────
   *
   * The tool used to page from event one, every time. On the owner's engine
   * that meant a session with 61,933 events answered "what has this been doing"
   * with its first fifty — 1,238 pages away from anything current, and no
   * caller ever walked them. The bare call is the one a model actually makes,
   * so the bare call is the one that has to answer the question it means.
   */
  test("the bare call reads the LATEST page, and says what is behind it", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    for (let lap = 0; lap < 40; lap++) {
      await call(tools, "sessions_send", { intent: "task", sessionId: id, input: `message ${lap}` });
      store.stopTurn(id);
    }
    const whole = store.readEvents(id, 0);
    const latest = await call(tools, "sessions_read", { sessionId: id });
    const page = latest.json!.events as Array<{ id: number }>;
    expect(page.length).toBeGreaterThan(0);
    // The page ENDS at the journal's end — that is what "latest" means.
    expect(page.at(-1)!.id).toBe(whole.at(-1)!.id);
    expect(latest.json!.cursor).toBe(whole.at(-1)!.id);
    // Nothing is AHEAD of the end, and the answer says so rather than handing
    // back a `more` a caller would poll on forever.
    expect(latest.json!.more).toBe(false);
    // What is BEHIND it is a different question, and it has its own word.
    expect(latest.json!.earlier).toBe(true);
    expect(String(latest.json!.note)).toContain("LATEST");
    expect(String(latest.json!.note)).toContain('from: "start"');
    // And the page begins later than the journal does: this is the tail.
    expect(page[0]!.id).toBeGreaterThan(whole[0]!.id);
  });

  test("a short journal comes back whole from the tail, with nothing behind it", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "one" });
    const read = await call(tools, "sessions_read", { sessionId: id, verbose: true });
    expect(read.json!.earlier).toBe(false);
    expect((read.json!.events as Array<{ id: number }>).map((event) => event.id)).toEqual(store.readEvents(id, 0).map((event) => event.id));
  });

  /**
   * THE ROWS A PAGE SPENDS NOTHING ON, and the ones it always keeps.
   *
   * `usage.updated` is a meter reading; a request the POLICY opened and closed
   * in one instant is "the engine allowed what it was always going to allow".
   * A request a PERSON or a SESSION answered is a decision somebody made, and
   * dropping it would hide exactly what an auditing caller came for.
   */
  test("meter rows and auto-approved requests are dropped, counted, and restored by verbose", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "work" });
    const run = store.turns(id).at(-1)!.runId;
    const token = store.claimTurn(id, "worker_budget")!.claim!.token;
    store.markRunning(id, run, token);
    store.ingestObservations(id, run, token, [
      { kind: "usage", usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 }, contextUsed: 2, contextMax: 10 } },
    ]);

    const quiet = await call(tools, "sessions_read", { sessionId: id });
    const types = (quiet.json!.events as Array<{ type: string }>).map((event) => event.type);
    expect(types).not.toContain("usage.updated");
    expect(quiet.json!.quietEvents).toBeGreaterThan(0);

    const loud = await call(tools, "sessions_read", { sessionId: id, verbose: true });
    expect((loud.json!.events as Array<{ type: string }>).map((event) => event.type)).toContain("usage.updated");
    expect(loud.json!.quietEvents).toBeUndefined();
  });

  /** A long session answered in a few hundred bytes a turn — what it was asked,
   *  what it did, what it concluded. */
  test("mode: summary folds turns instead of listing events", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    for (let lap = 0; lap < 8; lap++) {
      await call(tools, "sessions_send", { intent: "task", sessionId: id, input: `line ${lap}\nand a second line nobody needs` });
      store.stopTurn(id);
    }
    const summary = await call(tools, "sessions_read", { sessionId: id, mode: "summary" });
    const turns = summary.json!.turns as Array<{ runId: string; asked: string }>;
    expect(summary.json!.mode).toBe("summary");
    expect(summary.json!.turnCount).toBe(8);
    // The DEFAULT window, not every turn — and the FIRST line of each input.
    expect(turns).toHaveLength(5);
    expect(turns.at(-1)!.asked).toBe("line 7");
    expect(summary.json!.events).toBeUndefined();
    // Smaller than the events it stands in for, which is the entire point.
    expect(summary.text.length).toBeLessThan((await call(tools, "sessions_read", { sessionId: id })).text.length);
  });

  test("a run-scoped read answers with THAT turn's events and its final text, without paging", async () => {
    /**
     * THE OTHER HALF OF A PING-ONLY WAKE. A wake names a run and carries no
     * result (see `wakeMessage` in state.ts); this is how the recipient gets
     * the outcome — one call, that run only, with the answer handed over rather
     * than reconstructed out of observations.
     */
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    // Two turns, so "that run only" is a real filter rather than everything.
    for (const [runId, answer] of [["run_first", "the first answer"], ["run_wanted", `the answer worth reading: ${"y".repeat(3_000)}`]] as const) {
      store.submitTurn(id, { runId, input: `work ${runId}` });
      const token = store.claimTurn(id, "worker_read")!.claim!.token;
      store.markRunning(id, runId, token);
      store.completeTurn(id, runId, token, { text: answer });
    }

    const read = await call(tools, "sessions_read", { sessionId: id, runId: "run_wanted" });
    expect(read.json!.runId).toBe("run_wanted");
    expect(read.json!.state).toBe("completed");
    // The turn's own answer, whole, and its true length beside it.
    expect(String(read.json!.result)).toContain("the answer worth reading");
    expect(read.json!.resultChars).toBe(`the answer worth reading: ${"y".repeat(3_000)}`.length);
    expect(read.json!.resultFrom).toBe(0);
    expect(read.json!.resultMore).toBe(false);
    // Only that run's events — the other turn's are not in the page.
    const events = read.json!.events as Array<{ runId?: string }>;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.runId === "run_wanted")).toBe(true);
    // No cursor arithmetic was needed to get here.
    expect(String(read.json!.note)).toContain("Nothing else was needed");
  });

  test("a run-scoped read of an unknown run says so rather than pretending", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    const read = await call(tools, "sessions_read", { sessionId: id, runId: "run_never" });
    expect(read.json!.runId).toBe("run_never");
    expect(read.json!.result).toBeUndefined();
    expect(String(read.json!.note)).toContain("No turn run_never on this session");
  });

  test("a long answer is read whole in verbatim slices, and never trimmed", async () => {
    /**
     * THE ANSWER IS RETRIEVABLE IN FULL. Clipping it at a cap with no way past
     * the cap would move the problem rather than solve it: a coordinator that
     * needs the outcome would be stuck with a prefix. The slices carry no
     * ellipsis and no marker, so concatenating them is the answer exactly.
     */
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    // Distinctive and long: 20 000 characters of numbered lines, so a dropped
    // or duplicated slice is visible rather than plausible.
    // LEADING AND TRAILING WHITESPACE INCLUDED, deliberately: the answer is
    // handed over verbatim, and a trim would drop characters the turn wrote.
    const answer = `\n\n   ${Array.from({ length: 1_000 }, (_, index) => `line ${String(index).padStart(4, "0")} ${"·".repeat(8)}`).join("\n")}   \n\n`;
    expect(answer.length).toBeGreaterThan(MAX_RESULT_CHARS_EXPECTED * 2);
    store.submitTurn(id, { runId: "run_long", input: "work" });
    const token = store.claimTurn(id, "worker_read")!.claim!.token;
    store.markRunning(id, "run_long", token);
    store.completeTurn(id, "run_long", token, { text: answer });

    let cursor = 0;
    let assembled = "";
    let more = true;
    for (let guard = 0; more && guard < 20; guard += 1) {
      const read = await call(tools, "sessions_read", { sessionId: id, runId: "run_long", resultAfter: cursor });
      expect(read.json!.resultChars).toBe(answer.length);
      expect(read.json!.resultFrom).toBe(cursor);
      const slice = String(read.json!.result);
      // Verbatim: no marker anywhere inside a slice.
      expect(slice).not.toContain("not shown");
      expect(slice).not.toContain("…");
      assembled += slice;
      more = read.json!.resultMore === true;
      cursor = assembled.length;
      if (more) expect(String(read.json!.note)).toContain(`resultAfter: ${cursor}`);
    }
    expect(more).toBe(false);
    // EXACTLY the answer — same length, same characters, same edges.
    expect(assembled.length).toBe(answer.length);
    expect(assembled).toBe(answer);
    expect(assembled.startsWith("\n\n   ")).toBe(true);
    expect(assembled.endsWith("   \n\n")).toBe(true);
  });

  test("a result-only continuation carries the event cursor, so events are not replayed", async () => {
    /**
     * THE BUG THIS PINS: when the events had run out but the answer had not,
     * the continuation named only `resultAfter`. A caller following it exactly
     * would send no `after`, which defaults to 0 — and receive that run's first
     * page of events all over again, on every slice of a long answer.
     */
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    const answer = "w".repeat(20_000);
    store.submitTurn(id, { runId: "run_tail", input: "work" });
    const token = store.claimTurn(id, "worker_read")!.claim!.token;
    store.markRunning(id, "run_tail", token);
    store.completeTurn(id, "run_tail", token, { text: answer });

    // One page holds this run's few events, so `more` is false while
    // `resultMore` is true — exactly the case that used to omit the cursor.
    const first = await call(tools, "sessions_read", { sessionId: id, runId: "run_tail" });
    expect(first.json!.more).toBe(false);
    expect(first.json!.resultMore).toBe(true);
    const cursor = first.json!.cursor as number;
    expect(cursor).toBeGreaterThan(0);
    const note = String(first.json!.note);
    expect(note).toContain(`after: ${cursor}`);
    expect(note).toContain("resultAfter: 8000");

    // Following the note exactly returns no events a second time.
    const second = await call(tools, "sessions_read", { sessionId: id, runId: "run_tail", after: cursor, resultAfter: 8_000 });
    expect(second.json!.events).toEqual([]);
    expect(second.json!.resultFrom).toBe(8_000);
    expect(String(second.json!.result).length).toBe(8_000);
    expect(second.json!.resultMore).toBe(true);

    // And the whole answer still reconstructs from the slices.
    const third = await call(tools, "sessions_read", { sessionId: id, runId: "run_tail", after: second.json!.cursor as number, resultAfter: 16_000 });
    expect(third.json!.resultMore).toBe(false);
    expect(`${first.json!.result}${second.json!.result}${third.json!.result}`).toBe(answer);
  });

  test("paging a run's events does not repeat its answer, and skips the other runs' events", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    // Three runs interleaved: the one under test is opened first, then other
    // runs write events, then it writes more — so a filter that ignored runId
    // or a cursor that ignored the filter would both show up.
    const busy = "run_busy";
    store.submitTurn(id, { runId: busy, input: "work" });
    const token = store.claimTurn(id, "worker_read")!.claim!.token;
    store.markRunning(id, busy, token);
    for (let index = 0; index < 60; index += 1) {
      store.ingestObservations(id, busy, token, [
        { kind: "item.started", item: { id: `item_${index}`, detail: { type: "assistant_message", text: `step ${index}` } } },
        { kind: "item.completed", itemId: `item_${index}`, status: "completed" },
      ]);
      if (index % 20 === 0) {
        // Another run's traffic, in the middle of this one's.
        const other = `run_other_${index}`;
        store.submitTurn(id, { runId: other, input: "someone else" });
        store.stopTurn(id, other);
      }
    }
    store.completeTurn(id, busy, token, { text: "the busy answer" });

    let cursor = 0;
    let pages = 0;
    let events = 0;
    let more = true;
    for (let guard = 0; more && guard < 20; guard += 1) {
      const read = await call(tools, "sessions_read", { sessionId: id, runId: busy, ...(cursor > 0 ? { after: cursor } : {}) });
      const page = read.json!.events as Array<{ id: number; runId?: string }>;
      // Only this run's events, on every page.
      expect(page.every((event) => event.runId === busy)).toBe(true);
      // The answer rides the FIRST page only: continuations do not repeat it.
      if (pages === 0) expect(read.json!.result).toBe("the busy answer");
      else expect(read.json!.result).toBeUndefined();
      // The total is still reported, so "not on this page" is distinguishable
      // from "no answer at all".
      expect(read.json!.resultChars).toBe("the busy answer".length);
      events += page.length;
      pages += 1;
      more = read.json!.more === true;
      if (more) {
        expect(read.json!.cursor).toBe(page.at(-1)!.id);
        expect(String(read.json!.note)).toContain(`after: ${read.json!.cursor}`);
        cursor = read.json!.cursor as number;
      }
    }
    expect(pages).toBeGreaterThan(1);
    expect(more).toBe(false);
    // Every event of that run, and nothing repeated: the ids are unique.
    const all = store.readEvents(id, 0).filter((event) => event.runId === busy);
    expect(events).toBe(all.length);
  });

  test("a run with no answer text says that", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    store.submitTurn(id, { runId: "run_quiet", input: "work" });
    const quiet = store.claimTurn(id, "worker_read")!.claim!.token;
    store.markRunning(id, "run_quiet", quiet);
    // An empty answer, which is what a turn that said nothing records.
    store.completeTurn(id, "run_quiet", quiet, { text: "" });
    const silent = await call(tools, "sessions_read", { sessionId: id, runId: "run_quiet" });
    expect(silent.json!.result).toBeUndefined();
    expect(silent.json!.resultChars).toBeUndefined();
    expect(String(silent.json!.note)).toContain("no answer text");
  });

  test("without a runId there is no run scoping: no runId, no answer, just events", async () => {
    // Backwards compatibility, asserted rather than assumed. `from` is now
    // where the PAGE begins rather than always zero — see the tail tests above.
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "one" });
    const read = await call(tools, "sessions_read", { sessionId: id });
    expect(read.json!.runId).toBeUndefined();
    expect(read.json!.result).toBeUndefined();
    expect((read.json!.events as unknown[]).length).toBeGreaterThan(0);
    // An explicit cursor is still a forward walk from exactly there.
    const forward = await call(tools, "sessions_read", { sessionId: id, after: 0 });
    expect(forward.json!.from).toBe(0);
  });

  test("one enormous event is clamped and MARKED, and never squeezes the page to nothing", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "x".repeat(60_000) });

    const read = await call(tools, "sessions_read", { sessionId: id });
    const text = read.text;
    // The clamp says where it happened rather than truncating silently.
    expect(text).toContain("more characters, not shown");
    expect(text.length).toBeLessThan(40_000);
    // …and the events either side of it are still there.
    expect((read.json!.events as unknown[]).length).toBeGreaterThan(1);
  });

  test("the pager never returns an empty page while claiming there is more", () => {
    /**
     * The degenerate case the `page.length > 0` clause exists for: an event
     * that is STILL over the character budget after every string inside it has
     * been clamped must be handed over anyway, or a caller can never advance
     * past it — an empty page with `more: true` is an infinite loop.
     *
     * The fixture has to survive the clamp to be the case under test: one
     * enormous string becomes 2,000 characters and is not over budget at all,
     * so it is MANY strings, each already under the clamp.
     */
    const bulky = {
      id: 1,
      sessionId: "s",
      at: 0,
      type: "turn.accepted",
      lines: Array.from({ length: 40 }, () => "y".repeat(1_500)),
    } as never;
    expect(JSON.stringify(bulky).length).toBeGreaterThan(24_000);
    const first = pageEvents([bulky]);
    expect(first.page.length).toBe(1);
    expect(first.cursor).toBe(1);
    expect(first.more).toBe(false);

    // …and with something after it, the oversized event still comes back ALONE
    // rather than dragging the rest of the budget with it.
    const next = { id: 2, sessionId: "s", at: 0, type: "turn.stopped" } as never;
    const paged = pageEvents([bulky, next]);
    expect(paged.page.length).toBe(1);
    expect(paged.cursor).toBe(1);
    expect(paged.more).toBe(true);
  });
});

// ── the other half of the notice ────────────────────────────────────────────

/**
 * A PEER'S MESSAGE ARRIVES AS A NOTICE NAMING THIS CALL, so this call has to be
 * able to answer it — in ONE call, with the body whole. Anything less and the
 * recipient acts on the teaser, which is worse than the flood the notice
 * replaced.
 */
describe("sessions_read returns the message a notice stands in for", () => {
  test("one call, and the body comes back exactly as sent", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    const body = `Findings\n\n${"The parser drops the column on recovery. ".repeat(60)}`;
    const sent = await call(tools, "sessions_send", { sessionId: id, input: body });
    const runId = sent.json!.runId as string;
    // The SENDER is told what the other side actually sees, in the real string.
    expect(String(sent.json!.recipientSees)).toContain(`sessions_read(sessionId: "${id}", runId: "${runId}")`);

    const read = await call(tools, "sessions_read", { sessionId: id, runId });
    expect(read.json!.message).toBe(body);
    expect(read.json!.messageChars).toBe(body.length);
    expect(read.json!.messageMore).toBe(false);
    expect(read.json!.messageIntent).toBe("report");
    /**
     * AND IT IS HERE EXACTLY ONCE (#515).
     *
     * `message` is the copy that is whole and sliceable, so it is the one that
     * stays. The same body used to land twice more in the same answer — inside
     * the `turn.accepted` event's `input`, clamped to 2,000 characters, and
     * again as that event's `agentNotice` — which made a 3,809-character
     * message cost 34,669 bytes to fetch. Both are now a line naming where the
     * text actually is, rather than a truncation of it a reader might act on.
     */
    const accepted = (read.json!.events as Array<{ type: string; turn?: { input: string; agentNotice?: string } }>).find(
      (event) => event.type === "turn.accepted",
    );
    expect(accepted!.turn!.input).toContain("the `message` field");
    expect(accepted!.turn!.input).not.toContain("The parser drops the column");
    expect(accepted!.turn!.agentNotice).not.toContain("The parser drops the column");
    expect(String(read.json!.message)).not.toContain("more characters, not shown");
    // A person's words are the one thing this may never strip: they live in
    // that event and nowhere else.
    store.submitTurn(id, { runId: "run_person", input: "the editor eats my cursor" });
    const typed = await call(tools, "sessions_read", { sessionId: id, runId: "run_person" });
    const theirs = (typed.json!.events as Array<{ type: string; turn?: { input: string } }>).find((event) => event.type === "turn.accepted");
    expect(theirs!.turn!.input).toBe("the editor eats my cursor");
  });

  test("a body past the budget is read whole in verbatim slices", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    const body = "z".repeat(20_000);
    const runId = (await call(tools, "sessions_send", { sessionId: id, input: body })).json!.runId as string;

    let assembled = "";
    let cursor: number | undefined = 0;
    for (let lap = 0; lap < 5 && cursor !== undefined; lap += 1) {
      const page = await call(tools, "sessions_read", { sessionId: id, runId, messageAfter: cursor });
      assembled += page.json!.message as string;
      cursor = page.json!.messageMore === true ? (page.json!.messageFrom as number) + (page.json!.message as string).length : undefined;
    }
    expect(assembled).toBe(body);
  });

  test("a human's turn has no message to fetch — it was never replaced by a notice", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    store.submitTurn(id, { runId: "run_typed", input: "please fix the editor" });
    const read = await call(tools, "sessions_read", { sessionId: id, runId: "run_typed" });
    expect(read.json!.message).toBeUndefined();
    expect(read.json!.messageChars).toBeUndefined();
  });

  test("the wall tells senders and recipients what actually travels", () => {
    const { store } = engine();
    const tools = wall(store);
    expect(tools.get("sessions_send")!.description).toContain("handed a NOTICE naming sessions_read, not your text");
    // The description names the call and the arguments; the mechanics of the
    // notice moved to the telar skill with everything else that would not fit
    // in 350 characters (#515), and both halves are asserted.
    //
    // THE PEER-MESSAGE HALF NOW RIDES ON `runId` RATHER THAN ON THE TOOL'S OWN
    // PROSE (#563). The rule is unchanged and is still stated exactly once —
    // where the caller is choosing the argument that fetches it — and the
    // sentence it used to live in was one the Agent resent on every lap.
    expect(JSON.stringify(toolInputSchema(tools.get("sessions_read")!.shape))).toContain("a peer message in full");
    expect(TELAR_SKILL).toContain("A wake or a peer's message is a PING");
    expect(TELAR_SKILL).toContain("sessions_read(sessionId, runId)");
    expect(tools.get("sessions_subscribe")!.description).toContain("It is a PING");
  });
});

// ── subscriptions and answering a peer ──────────────────────────────────────

describe("subscribing and answering", () => {
  test("without a self there is nobody to wake: the three subscription tools refuse in words", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const target = store.createSession({ projectId, title: "a target" });
    for (const name of ["sessions_subscribe", "sessions_unsubscribe", "sessions_subscriptions"]) {
      const refused = await call(tools, name, { sessionId: target.id, subscriptionId: "sub_x" });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("no session to wake");
    }
  });

  test("an awaited result defaults to one wake; ongoing monitoring is explicit", async () => {
    const { store, projectId } = engine();
    const host = store.createSession({ projectId, title: "coordinator" });
    const target = store.createSession({ projectId, title: "worker" });
    const tools = wall(store, { sessionId: host.id });
    await call(tools, "sessions_subscribe", { sessionId: target.id });
    for (const runId of ["run_first", "run_second"]) {
      store.submitTurn(target.id, { runId, input: "work" });
      const token = store.claimTurn(target.id, "worker_one")!.claim!.token;
      store.markRunning(target.id, runId, token);
      store.completeTurn(target.id, runId, token, { text: "done" });
    }
    expect(store.subscriptionsFor(host.id)).toHaveLength(0);
    expect(store.turns(host.id)).toHaveLength(1);
    const ongoing = await call(tools, "sessions_subscribe", { sessionId: target.id, once: false });
    expect(ongoing.json!.once).not.toBe(true);
  });

  test("a peer cannot restart a human-stopped session or add to its history", async () => {
    const { store, projectId } = engine();
    const host = store.createSession({ projectId, title: "coordinator" });
    const peer = store.createSession({ projectId, title: "peer" });
    store.subscribe(host.id, { targetSessionId: peer.id });
    store.stopSession(host.id, "user");
    const tools = wall(store, { sessionId: peer.id });
    expect((await call(tools, "sessions_send", { intent: "task", sessionId: host.id, input: "another update" })).isError).toBe(true);
    store.submitTurn(peer.id, { runId: "run_peer", input: "work" });
    const token = store.claimTurn(peer.id, "worker_one")!.claim!.token;
    store.markRunning(peer.id, "run_peer", token);
    store.completeTurn(peer.id, "run_peer", token, { text: "done" });
    expect(store.turns(host.id)).toHaveLength(0);
    store.submitTurn(host.id, { runId: "run_human", input: "continue" });
    expect(store.getSession(host.id).agentMessagesBlocked).toBeUndefined();
    expect((await call(tools, "sessions_send", { intent: "task", sessionId: host.id, input: "fresh report" })).isError).not.toBe(true);
    expect(store.turns(host.id)).toHaveLength(2);
  });

  test("subscribe, list, unsubscribe — a round trip that records nothing on either session", async () => {
    const { store, projectId } = engine();
    const host = store.createSession({ projectId, title: "the orchestrator" });
    const tools = wall(store, { sessionId: host.id });
    const target = store.createSession({ projectId, title: "a worker" });

    const subscribed = await call(tools, "sessions_subscribe", { sessionId: target.id, events: ["turn_completed", "turn_failed"], once: true });
    expect(subscribed.isError).toBe(false);
    expect(subscribed.json).toMatchObject({ subscriberSessionId: host.id, targetSessionId: target.id, events: ["turn_completed", "turn_failed"], once: true });
    // #550: the wake is a NOTIFICATION now, and the note says when it lands —
    // `settled_only` by default, so it waits rather than interrupting.
    expect(String(subscribed.json!.note)).toContain("woken with a notification");
    expect(String(subscribed.json!.note)).toContain("waits for you to finish the turn you are in");

    const listed = await call(tools, "sessions_subscriptions");
    expect((listed.json!.subscriptions as unknown[]).length).toBe(1);

    // NEITHER SESSION'S RECORD MENTIONS THE OTHER — the wish is on the
    // subscription alone.
    for (const id of [host.id, target.id]) {
      const stored = fs.readFileSync(path.join(store.paths.sessions, id, "session.json"), "utf8");
      expect(stored).not.toContain(id === host.id ? target.id : host.id);
    }

    const removed = await call(tools, "sessions_unsubscribe", { subscriptionId: subscribed.json!.id });
    expect(removed.json!.removed).toBe(true);
    const again = await call(tools, "sessions_unsubscribe", { subscriptionId: subscribed.json!.id });
    expect(again.isError).toBe(false);
    expect(again.json!.removed).toBe(false);
  });

  test("a peer's question is listed with its fields, and answering it is recorded as a session's", async () => {
    const { store, projectId } = engine();
    const host = store.createSession({ projectId, title: "the orchestrator" });
    const tools = wall(store, { sessionId: host.id });
    const target = store.createSession({ projectId, title: "a worker" });
    store.submitTurn(target.id, { runId: "run_t", input: "go" });
    const token = store.claimTurn(target.id, "worker_one")!.claim!.token;
    store.markRunning(target.id, "run_t", token);
    store.openRequest(target.id, "run_t", token, {
      requestId: "req_q",
      kind: "user_input",
      detail: { kind: "user_input", prompt: "Which database?", fields: [{ key: "db", label: "Database", kind: "choice", choices: ["postgres", "sqlite"] }] },
    });

    const listed = await call(tools, "sessions_requests", { sessionId: target.id });
    expect(listed.isError).toBe(false);
    const [request] = listed.json!.requests as Array<Record<string, unknown>>;
    expect(request).toMatchObject({ id: "req_q", kind: "user_input", prompt: "Which database?" });
    expect((request!.fields as Array<Record<string, unknown>>)[0]).toMatchObject({ key: "db", choices: ["postgres", "sqlite"] });

    const answered = await call(tools, "sessions_resolve_request", { sessionId: target.id, requestId: "req_q", decision: "accept", answers: { db: "postgres" } });
    expect(answered.isError).toBe(false);
    expect(answered.json!.resolvedBy).toBe("session");
    expect(store.requests(target.id)[0]).toMatchObject({ state: "resolved", decision: "accept", resolvedBy: "session", answers: { db: "postgres" } });
  });

  test("a secret pick is the user's alone — listed by origin only, refused to resolve", async () => {
    const { store, projectId } = engine();
    const host = store.createSession({ projectId, title: "the orchestrator" });
    const tools = wall(store, { sessionId: host.id });
    const target = store.createSession({ projectId, title: "a worker" });
    store.submitTurn(target.id, { runId: "run_t", input: "go" });
    const token = store.claimTurn(target.id, "worker_one")!.claim!.token;
    store.markRunning(target.id, "run_t", token);
    store.openRequest(target.id, "run_t", token, {
      requestId: "req_s",
      kind: "secret_access",
      detail: {
        kind: "secret_access",
        secret: { origin: "https://github.com", fields: [{ kind: "password" }], candidates: [{ id: "item_1", title: "GitHub", domain: "github.com" }] },
      },
    });

    const listed = await call(tools, "sessions_requests", { sessionId: target.id });
    expect(listed.text).toContain("https://github.com");
    expect(listed.text).not.toContain("item_1");
    const refused = await call(tools, "sessions_resolve_request", { sessionId: target.id, requestId: "req_s", decision: "accept" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("user's alone");
    expect(store.requests(target.id)[0]!.state).toBe("open");
  });
});

// ── the fan-out guard ───────────────────────────────────────────────────────

describe("a warp child may not reach these tools", () => {
  test("every tool on the wall is denied to a warp child, by name", () => {
    // STRUCTURAL, not a copied list: the names come from the wall itself, so a
    // thirteenth tool fails this until it is denied too. `sessions_create` is
    // fan-out wearing another hat, and the rest are steering a session from
    // inside a script that cannot see it.
    const names = collectSessionsWallTools({} as SessionsCapability).map((tool) => tool.name);
    expect(names.length).toBe(13);
    for (const name of names) {
      expect(WARP_CHILD_DISALLOWED_TOOLS).toContain(qualifyTelarTool(name));
    }
    // ANTI-VACUITY: the list is not simply "everything".
    expect(WARP_CHILD_DISALLOWED_TOOLS).not.toContain(qualifyTelarTool("display_open"));
  });
});
