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
 * Like the spool's wall, this one's contract is mostly what it cannot do, and a
 * comment claiming a negative is worth nothing:
 *   · nothing accept-shaped, and nothing that archives or deletes (INV-1);
 *   · nothing that records WHO created a session — no parent, no child, no
 *     link, which is the design under test rather than a gap in it;
 *   · NO cap on creation — asserted, not assumed, because the prose says so;
 *   · every one of these tools denied to a warp child.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertTelarToolNames, parseToolName, qualifyTelarTool, TELAR_CAPABILITIES } from "@telar/engine-client";
import { EngineStore } from "../src/state";
import { sessionsTools, pageEvents, type SessionsCapability } from "../src/sessions-tools/tools";
import { collectSessionsWallTools } from "../src/sessions-tools/socket";
import { WARP_CHILD_DISALLOWED_TOOLS } from "../src/warp/spawn";

const roots: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
      expect(tools.get(name)!.description).toContain("NEVER use this to get around something you were refused");
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
    // A REAL CHECKOUT, on disk, off the real repository.
    const session = store.getSession(id);
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
    const create = tools.get("sessions_create")!.description;
    expect(create).not.toContain("hard cap");
    expect(create).toContain("no cap");
  });

  test("a refused create leaves NO worktree behind", () => {
    // A refusal for any reason must not leave a checkout lying on disk. The
    // one refusal that remains is a project that does not exist.
    const { store, projectId } = engine();
    store.createSession({ projectId, envMode: "worktree", origin: "session" });
    const worktrees = path.join(store.paths.root, "worktrees");
    const before = fs.readdirSync(worktrees).length;
    expect(() => store.createSession({ projectId: "project_nope", envMode: "worktree", origin: "session" })).toThrow();
    expect(fs.readdirSync(worktrees).length).toBe(before);
  });
});

// ── driving ─────────────────────────────────────────────────────────────────

describe("driving a session", () => {
  test("send queues one turn and says plainly that it is not the answer", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    const sent = await call(tools, "sessions_send", { sessionId: id, input: "read the parser and report" });
    expect(sent.isError).toBe(false);
    expect(sent.json!.state).toBe("queued");
    expect(String(sent.json!.note)).toContain("Queued, not answered");
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

    await call(tools, "sessions_send", { sessionId: id, input: "go" });
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
    await call(tools, "sessions_send", { sessionId: id, input: "one more thing" });
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
    await call(tools, "sessions_send", { sessionId: id, input: "go" });
    const claimed = store.claimTurn(id, "worker_one")!;
    store.markRunning(id, claimed.runId, claimed.claim!.token);
    await call(tools, "sessions_send", { sessionId: id, input: "and then this" });

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
    await call(tools, "sessions_send", { sessionId: id, input: "carry on" });
    expect(store.claimNextTurn("worker_two")?.turn.input).toBe("carry on");

    // Stopping an idle session says so rather than erroring.
    const again = await call(tools, "sessions_stop", { sessionId: id });
    expect(again.isError).toBe(false);
  });

  test("diff reads the session's own checkout and says it accepts nothing", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "worktree" })).json!.id as string;
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
      await call(tools, "sessions_send", { sessionId: id, input: `message ${lap}` });
      store.stopTurn(id);
    }
    const whole = store.readEvents(id, 0);
    expect(whole.length).toBeGreaterThan(50);

    const first = await call(tools, "sessions_read", { sessionId: id });
    const page = first.json!.events as Array<{ id: number }>;
    expect(first.json!.more).toBe(true);
    expect(page.length).toBeLessThanOrEqual(50);
    // THE CURSOR IS THE LAST EVENT ON THE PAGE, never the last one read — a
    // cursor that ran ahead would silently drop everything the budget trimmed.
    expect(first.json!.cursor).toBe(page.at(-1)!.id);
    expect(String(first.json!.note)).toContain("This is a PAGE, not the whole journal");
    expect(String(first.json!.note)).toContain(`after: ${first.json!.cursor}`);

    // Paging forward loses NOTHING: the pages, concatenated, are the journal.
    const seen: number[] = page.map((event) => event.id);
    let cursor = first.json!.cursor as number;
    let more = true;
    for (let guard = 0; more && guard < 20; guard++) {
      const next = await call(tools, "sessions_read", { sessionId: id, after: cursor });
      for (const event of next.json!.events as Array<{ id: number }>) seen.push(event.id);
      cursor = next.json!.cursor as number;
      more = next.json!.more === true;
    }
    expect(more).toBe(false);
    expect(seen).toEqual(whole.map((event) => event.id));
  });

  test("one enormous event is clamped and MARKED, and never squeezes the page to nothing", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    await call(tools, "sessions_send", { sessionId: id, input: "x".repeat(60_000) });

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

  test("subscribe, list, unsubscribe — a round trip that records nothing on either session", async () => {
    const { store, projectId } = engine();
    const host = store.createSession({ projectId, title: "the orchestrator" });
    const tools = wall(store, { sessionId: host.id });
    const target = store.createSession({ projectId, title: "a worker" });

    const subscribed = await call(tools, "sessions_subscribe", { sessionId: target.id, events: ["turn_completed", "turn_failed"], once: true });
    expect(subscribed.isError).toBe(false);
    expect(subscribed.json).toMatchObject({ subscriberSessionId: host.id, targetSessionId: target.id, events: ["turn_completed", "turn_failed"], once: true });
    expect(String(subscribed.json!.note)).toContain("[wake");

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
    expect(WARP_CHILD_DISALLOWED_TOOLS).not.toContain(qualifyTelarTool("spool_list_items"));
  });
});
