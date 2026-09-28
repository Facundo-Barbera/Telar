import { describe, expect, test } from "bun:test";
import {
  ENGINE_PROTOCOL_VERSION,
  EngineDiscovery,
  forgeQuery,
  parseForgeQuery,
  EngineEvent,
  Item,
  ItemDetail,
  EngineRequest,
  DEFAULT_SETTLE_DELEGATED_AFTER_HOURS,
  InboxPolicy,
  MAX_AUTO_SETTLE_HOURS,
  RequestKind,
  RuntimeMode,
  Session,
  Task as TaskSchema,
  Turn,
  autoResolution,
  livenessOf,
  waitingToolOf,
  countsAsActivity,
  isUnstatedEnding,
  requiresHuman,
  safeParseEvent,
  type Task,
} from "../src/protocol";
import * as packageRoot from "../src/index";

const at = 1_700_000_000_000;

describe("protocol version", () => {
  test("is 2 — a hard break from v1, not an extension of it", () => {
    expect(ENGINE_PROTOCOL_VERSION).toBe(2);
    // Discovery pins the version so a v1 daemon is rejected at handshake rather
    // than half-understood. This is the whole mechanism of the hard break.
    expect(EngineDiscovery.safeParse({
      version: 1,
      daemonId: "d",
      host: "127.0.0.1",
      port: 4321,
      token: "x".repeat(32),
      startedAt: at,
    }).success).toBe(false);
  });

  test("discovery rejects a short token and an out-of-range port", () => {
    const base = { version: 2 as const, daemonId: "d", host: "127.0.0.1" as const, startedAt: at };
    expect(EngineDiscovery.safeParse({ ...base, port: 4321, token: "short" }).success).toBe(false);
    expect(EngineDiscovery.safeParse({ ...base, port: 70000, token: "x".repeat(32) }).success).toBe(false);
    expect(EngineDiscovery.safeParse({ ...base, port: 4321, token: "x".repeat(32) }).success).toBe(true);
  });
});

describe("the package barrel", () => {
  test("the protocol is exported from the package root, not swallowed by a name clash", () => {
    expect(packageRoot.ENGINE_PROTOCOL_VERSION).toBe(2);
    expect(typeof packageRoot.EngineEvent?.safeParse).toBe("function");
    expect(typeof packageRoot.autoResolution).toBe("function");
  });

  test("every entity schema survives the barrel", () => {
    for (const [name, schema] of Object.entries({ Session, Turn, Item, EngineRequest })) {
      expect(schema, `${name} vanished from the protocol barrel`).toBeDefined();
      expect(typeof schema.safeParse, `${name} is not a schema`).toBe("function");
    }
  });
});

const session = {
  id: "s1",
  projectId: "p1",
  environmentId: "local" as const,
  title: "t",
  state: "active" as const,
  createdAt: at,
  updatedAt: at,
  providerInstanceId: "claude:personal",
  driver: "claude" as const,
  workspace: { mode: "local" as const, path: "/repo" },
  envMode: "local" as const,
  runtimeMode: "auto" as const,
  interactionMode: "default" as const,
  detached: true,
};

describe("Session", () => {
  test("accepts a detached, worktree-backed session", () => {
    const parsed = Session.safeParse({
      ...session,
      envMode: "worktree",
      workspace: { mode: "worktree", path: "/wt/s1", branch: "telar/s1", baseRef: "abc123" },
    });
    expect(parsed.success).toBe(true);
  });

  test("a worktree workspace without a branch is rejected", () => {
    // The branch is what makes the worktree reachable and cleanable. A
    // worktree row without one is unreviewable and unremovable.
    expect(
      Session.safeParse({ ...session, workspace: { mode: "worktree", path: "/wt/s1" } }).success,
    ).toBe(false);
  });

  test("an unknown runtime mode is rejected rather than defaulted", () => {
    // Silently falling back to a default here would widen or narrow what a
    // session may do without anyone asking for it.
    expect(Session.safeParse({ ...session, runtimeMode: "yolo" }).success).toBe(false);
  });

  test("environmentId is pinned to local while there is one host", () => {
    expect(Session.safeParse({ ...session, environmentId: "remote" }).success).toBe(false);
  });

  test("settledBy carries the coordinator, the errand and when", () => {
    const parsed = Session.safeParse({
      ...session,
      settledOverride: "settled",
      settledAt: at,
      settledBy: { kind: "delegation", coordinatorSessionId: "session_coord", runId: "run_task", at },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.settledBy?.coordinatorSessionId).toBe("session_coord");
  });

  test("an unknown settle reason is rejected rather than kept unlabelled", () => {
    expect(
      Session.safeParse({ ...session, settledBy: { kind: "vibes", coordinatorSessionId: "c", runId: "r", at } }).success,
    ).toBe(false);
  });

  test("the never-re-settle record is a list of assignment runs", () => {
    expect(Session.safeParse({ ...session, unsettledAssignments: ["run_task", "run_other"] }).success).toBe(true);
    expect(Session.safeParse({ ...session, unsettledAssignments: [""] }).success).toBe(false);
  });
});

describe("InboxPolicy", () => {
  test("a policy written before the delegation grace keeps its own window", () => {
    const parsed = InboxPolicy.safeParse({ autoSettleAfterHours: 6 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.autoSettleAfterHours).toBe(6);
    expect(parsed.success && parsed.data.settleDelegatedAfterHours).toBe(DEFAULT_SETTLE_DELEGATED_AFTER_HOURS);
  });

  test("`null` is the off switch, and is distinct from the default", () => {
    const parsed = InboxPolicy.safeParse({ autoSettleAfterHours: null, settleDelegatedAfterHours: null });
    expect(parsed.success && parsed.data.settleDelegatedAfterHours).toBeNull();
  });

  test("the grace shares the quiet window's bounds", () => {
    expect(InboxPolicy.safeParse({ autoSettleAfterHours: 24, settleDelegatedAfterHours: 0 }).success).toBe(false);
    expect(InboxPolicy.safeParse({ autoSettleAfterHours: 24, settleDelegatedAfterHours: 1.5 }).success).toBe(false);
    expect(InboxPolicy.safeParse({ autoSettleAfterHours: 24, settleDelegatedAfterHours: MAX_AUTO_SETTLE_HOURS + 1 }).success).toBe(false);
  });
});

describe("Turn", () => {
  const turn = {
    runId: "r1",
    sessionId: "s1",
    sequence: 0,
    state: "queued" as const,
    input: "hi",
    acceptedAt: at,
    updatedAt: at,
  };

  test("keeps v1's crash-recovery states", () => {
    // These are the states that make a detached turn safe to recover. Losing
    // them turns crash recovery into guesswork, so they are pinned by name.
    for (const state of ["ambiguous", "discarded", "stopped", "claimed"]) {
      expect(Turn.safeParse({ ...turn, state }).success, state).toBe(true);
    }
  });

  test("a negative sequence is rejected", () => {
    expect(Turn.safeParse({ ...turn, sequence: -1 }).success).toBe(false);
  });

  test("an agent turn carries BOTH the message and the notice that stands in for it", () => {
    const parsed = Turn.safeParse({
      ...turn,
      input: "the whole report",
      origin: "session",
      sender: { sessionId: "session_worker" },
      agentIntent: "report",
      agentDelivery: "passive",
      agentNotice: '[agent message · report] from session session_worker (run r1, 16 chars): "the whole report"',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.input).toBe("the whole report");
      expect(parsed.data.agentNotice).toContain("16 chars");
    }
    expect(Turn.safeParse({ ...turn, origin: "session", sender: {} }).success).toBe(true);
  });
});

describe("ItemDetail", () => {
  test("narrows by type — a file_change carries a change and nothing else", () => {
    const parsed = ItemDetail.safeParse({
      type: "file_change",
      change: { path: "src/a.ts", kind: "edit", linesAdded: 3, linesRemoved: 1 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "file_change") {
      expect(parsed.data.change.path).toBe("src/a.ts");
    }
  });

  test("a payload from the wrong variant is rejected", () => {
    expect(ItemDetail.safeParse({ type: "file_change", command: { command: "ls" } }).success).toBe(false);
    expect(ItemDetail.safeParse({ type: "command_execution", change: { path: "a" } }).success).toBe(false);
  });

  test("an unknown item type is representable, so a new row is never dropped", () => {
    expect(ItemDetail.safeParse({ type: "unknown", label: "something new" }).success).toBe(true);
  });

  test("a steered agent message keeps its notice beside the body it stands in for", () => {
    const parsed = ItemDetail.safeParse({
      type: "user_message",
      text: "the whole report",
      sender: { sessionId: "session_worker" },
      notice: '[agent message · report] from session session_worker (run r1, 16 chars): "the whole report"',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "user_message") {
      expect(parsed.data.text).toBe("the whole report");
      expect(parsed.data.notice).toContain("16 chars");
    }
  });
});

describe("EngineEvent", () => {
  const base = { id: 1, at, sessionId: "s1" };

  test("a content delta parses and carries its stream", () => {
    const parsed = EngineEvent.safeParse({
      ...base,
      type: "content.delta",
      itemId: "i1",
      stream: "reasoning_text",
      text: "thinking…",
    });
    expect(parsed.success).toBe(true);
  });

  test("session.settled carries the reason, so a subscriber need not diff snapshots", () => {
    const parsed = EngineEvent.safeParse({
      ...base,
      type: "session.settled",
      settledBy: { kind: "delegation", coordinatorSessionId: "session_coord", runId: "run_task", at },
    });
    expect(parsed.success).toBe(true);
    // The reason is the payload. An event that only said "settled" would leave
    // worktree removal — the case the issue parks — with nothing to act on.
    expect(EngineEvent.safeParse({ ...base, type: "session.settled" }).success).toBe(false);
  });

  test("event ids are positive — 0 is not a valid cursor origin", () => {
    // Clients start tailing from cursor 0 meaning "from the beginning"; an
    // event with id 0 would be skipped by its own replay.
    expect(EngineEvent.safeParse({ ...base, id: 0, type: "turn.started" }).success).toBe(false);
  });

  test("safeParseEvent skips an unknown type instead of throwing", () => {
    expect(safeParseEvent({ ...base, type: "quantum.entangled", payload: 1 })).toBeNull();
    expect(safeParseEvent({ ...base, type: "turn.started" })).not.toBeNull();
  });

  test("safeParseEvent skips a malformed row of a KNOWN type", () => {
    // The harder half: the type is recognised but the payload is wrong. This
    // is what a provider-side field rename looks like, and it must degrade to
    // a skipped row rather than an exception.
    expect(safeParseEvent({ ...base, type: "content.delta", itemId: "i1" })).toBeNull();
  });
});

describe("autoResolution — the policy that decides if detached runs work", () => {
  test("full-access never asks", () => {
    for (const kind of ["command_execution", "file_change", "file_read", "tool_call"] as const) {
      expect(autoResolution("full-access", kind)).toBe("accept");
    }
  });

  test("auto-accept-edits passes edits and reads, still asks about commands", () => {
    expect(autoResolution("auto-accept-edits", "file_change")).toBe("accept");
    expect(autoResolution("auto-accept-edits", "file_read")).toBe("accept");
    expect(autoResolution("auto-accept-edits", "command_execution")).toBeNull();
    expect(autoResolution("auto-accept-edits", "tool_call")).toBeNull();
  });

  test("approval-required asks about everything except reads", () => {
    expect(autoResolution("approval-required", "file_read")).toBe("accept");
    expect(autoResolution("approval-required", "file_change")).toBeNull();
    expect(autoResolution("approval-required", "command_execution")).toBeNull();
  });

  test("user_input NEVER auto-resolves, in any mode", () => {
    for (const mode of RuntimeMode.options) {
      expect(autoResolution(mode, "user_input"), mode).toBeNull();
      expect(requiresHuman(mode, "user_input"), mode).toBe(true);
    }
  });

  test("secret_access NEVER auto-resolves, in any mode — full-access included", () => {
    for (const mode of RuntimeMode.options) {
      expect(autoResolution(mode, "secret_access"), mode).toBeNull();
      expect(requiresHuman(mode, "secret_access"), mode).toBe(true);
    }
  });

  test("the ladder only ever widens — no mode asks about more than a stricter one", () => {
    // Ordered least to most permissive. A change that made `auto` stricter
    // than `auto-accept-edits` for some kind would be a UI lie, since the
    // settings screen presents these as a ladder.
    const ladder = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
    for (const kind of RequestKind.options) {
      let seenAccept = false;
      for (const mode of ladder) {
        const resolves = autoResolution(mode, kind) !== null;
        if (seenAccept) {
          expect(resolves, `${mode}/${kind} narrowed after a wider mode accepted`).toBe(true);
        }
        seenAccept ||= resolves;
      }
    }
  });

  test("requiresHuman is the exact inverse of autoResolution", () => {
    for (const mode of RuntimeMode.options) {
      for (const kind of RequestKind.options) {
        expect(requiresHuman(mode, kind)).toBe(autoResolution(mode, kind) === null);
      }
    }
  });
});

describe("Request", () => {
  test("a parked request records whether anyone was told", () => {
    const parsed = EngineRequest.safeParse({
      id: "q1",
      runId: "r1",
      sessionId: "s1",
      state: "open",
      openedAt: at,
      notified: false,
      detail: { kind: "command_execution", command: { command: "rm -rf /" } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.notified).toBe(false);
  });

  test("a user_input request requires its fields", () => {
    expect(
      EngineRequest.safeParse({
        id: "q1",
        runId: "r1",
        sessionId: "s1",
        state: "open",
        openedAt: at,
        detail: { kind: "user_input", prompt: "which env?" },
      }).success,
    ).toBe(false);
  });
});

describe("livenessOf — one definition of 'still working'", () => {
  const task = (over: Partial<Task>): Task => ({
    id: "t1",
    sessionId: "s1",
    runId: "r1",
    kind: "agent",
    state: "running",
    startedAt: at,
    updatedAt: at,
    ...over,
  });

  test("no live work reads as null", () => {
    expect(livenessOf([])).toBeNull();
    expect(livenessOf([task({ state: "completed" })])).toBeNull();
  });

  test("a live agent outranks a watch loop", () => {
    // A fan-out mid-flight reads as working even when a log tail is also up.
    expect(livenessOf([task({ kind: "background" }), task({ kind: "agent" })])).toBe("working");
  });

  test("background-only work reads as monitoring", () => {
    expect(livenessOf([task({ kind: "background" })])).toBe("monitoring");
  });

  test("a session with no running turn can still be working", () => {
    // The property that makes background tasks worth modelling at all: work
    // outlives the turn that launched it.
    expect(livenessOf([task({ state: "pending" })])).toBe("working");
  });

  test("a backgrounded agent is background work, not working", () => {
    // Only asked with no turn running: the turn already walked away from it.
    expect(livenessOf([task({ backgrounded: true })])).toBe("monitoring");
    expect(livenessOf([task({ backgrounded: true }), task({ kind: "agent" })])).toBe("working");
  });

  test("paused and ambient tasks are not activity", () => {
    expect(livenessOf([task({ state: "waiting" })])).toBeNull();
    expect(livenessOf([task({ kind: "background", ambient: true })])).toBeNull();
    expect(livenessOf([task({ ambient: true }), task({ kind: "background" })])).toBe("monitoring");
    expect(countsAsActivity(task({ state: "waiting" }))).toBe(false);
    expect(countsAsActivity(task({ state: "running" }))).toBe(true);
  });

  test("only a bare completion is an unstated ending", () => {
    expect(isUnstatedEnding(task({ state: "completed" }))).toBe(true);
    expect(isUnstatedEnding(task({ state: "completed", resultText: "done" }))).toBe(false);
    expect(isUnstatedEnding(task({ state: "failed" }))).toBe(false);
  });
});

describe("a task carries no fan-out linkage", () => {
  test("an ordinary sub-agent is a whole task on its own", () => {
    const parsed = Item.safeParse({
      id: "i1",
      runId: "r1",
      sessionId: "s1",
      status: "inProgress",
      detail: { type: "task", taskId: "t1" },
      startedAt: at,
    });
    expect(parsed.success).toBe(true);
  });

  test("a `warp` block sent by an older engine is DROPPED, not carried", () => {
    const parsed = TaskSchema.safeParse({
      id: "t1",
      sessionId: "s1",
      runId: "r1",
      kind: "agent",
      state: "running",
      startedAt: at,
      updatedAt: at,
      warp: { warpRunId: "w1", warpName: "review-changes", phaseIndex: 0, phaseTitle: "Review", agentIndex: 2 },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && Object.keys(parsed.data)).not.toContain("warp");
    expect(parsed.success && (parsed.data as Record<string, unknown>).warp).toBeUndefined();
  });
});

describe("the forge query string", () => {
  test("everything a filter carries survives the trip out and back", () => {
    const issues = { state: "all" as const, milestone: "Hito 2 · Septiembre", assignee: "@me", author: "ada", labels: ["bug", "área:web"] };
    const pulls = { state: "merged" as const, assignee: "grace", labels: ["deps"] };
    const parsed = parseForgeQuery(new URLSearchParams(forgeQuery({ refresh: true, issues, pulls }).slice(1)));
    expect(parsed.issues).toEqual(issues);
    expect(parsed.pulls).toEqual(pulls);
    expect(parsed.refresh).toBe(true);
  });

  test("a LABEL WITH A COMMA survives, which a joined parameter would not", () => {
    // `--label "a,b"` asks gh for one label named `a,b`. Somebody can create that
    // label, so the flag repeats rather than joining.
    const issues = { state: "open" as const, labels: ["needs: design, maybe", "web"] };
    const parsed = parseForgeQuery(new URLSearchParams(forgeQuery({ issues }).slice(1)));
    expect(parsed.issues.labels).toEqual(["needs: design, maybe", "web"]);
  });

  test("no filters is no query string, and parses to the defaults", () => {
    expect(forgeQuery({})).toBe("");
    const parsed = parseForgeQuery(new URLSearchParams(""));
    expect(parsed).toEqual({ refresh: false, issues: { state: "open", labels: [] }, pulls: { state: "open", labels: [] } });
  });

  test("a state gh does not have is REFUSED rather than passed on", () => {
    // gh would fail on the flag and the failure would read as "GitHub is broken".
    expect(() => parseForgeQuery(new URLSearchParams("issues=merged"))).toThrow(/open, closed or all/);
    expect(() => parseForgeQuery(new URLSearchParams("pulls=nonsense"))).toThrow(/open, closed, merged or all/);
    // `merged` IS a pull request state, and only a pull request state.
    expect(parseForgeQuery(new URLSearchParams("pulls=merged")).pulls.state).toBe("merged");
  });

  test("blank values are absent rather than empty filters", () => {
    // `--assignee ""` is a filter nobody meant, and `gh` would match nothing.
    const parsed = parseForgeQuery(new URLSearchParams("issueAssignee=%20%20&issueLabel=&issueMilestone="));
    expect(parsed.issues.assignee).toBeUndefined();
    expect(parsed.issues.milestone).toBeUndefined();
    expect(parsed.issues.labels).toEqual([]);
  });
});

test("browser.control.changed parses, and an unknown controller degrades to a skipped row", () => {
  const base = { id: 1, at: 10, sessionId: "s" };
  expect(safeParseEvent({ ...base, type: "browser.control.changed", controller: "human" })).toMatchObject({
    type: "browser.control.changed",
    controller: "human",
  });
  expect(safeParseEvent({ ...base, type: "browser.control.changed", controller: "gremlin" })).toBeNull();
});

describe("waitingToolOf — only a call that merely waits", () => {
  const call = (name: string, input?: unknown) => ({ type: "mcp_tool_call" as const, call: { name, server: "telar", ...(input === undefined ? {} : { input }) } });
  const shell = (command: string) => ({ type: "command_execution" as const, command: { command } });

  test("the three known waits", () => {
    expect(waitingToolOf(call("mcp__telar__run_wait"))).toBe("run");
    expect(waitingToolOf(call("mcp__telar__terminal_wait"))).toBe("run");
    expect(waitingToolOf(shell("sleep 30"))).toBe("timer");
    expect(waitingToolOf(shell("  sleep 2m"))).toBe("timer");
    expect(waitingToolOf({ type: "dynamic_tool_call", call: { name: "TaskOutput", input: { task_id: "b1", block: true } } })).toBe("task");
  });

  test("anything that also does work is not a wait", () => {
    expect(waitingToolOf(shell("sleep 5 && bun test"))).toBeUndefined();
    expect(waitingToolOf(shell("bun test"))).toBeUndefined();
    // A non-blocking read returns at once.
    expect(waitingToolOf({ type: "dynamic_tool_call", call: { name: "TaskOutput", input: { task_id: "b1", block: false } } })).toBeUndefined();
    // Monitor returns a task id at once; the watch is background work.
    expect(waitingToolOf({ type: "dynamic_tool_call", call: { name: "Monitor", input: { description: "ci" } } })).toBeUndefined();
    expect(waitingToolOf({ type: "assistant_message", text: "" })).toBeUndefined();
  });
});

describe("an image-only message", () => {
  test("words or a picture is content; a file alone or nothing is not", () => {
    expect(packageRoot.turnHasContent("hi", [])).toBe(true);
    expect(packageRoot.turnHasContent("", ["image/png"])).toBe(true);
    expect(packageRoot.turnHasContent(" \n", ["application/pdf", "image/jpeg"])).toBe(true);
    expect(packageRoot.turnHasContent("", ["application/pdf"])).toBe(false);
    expect(packageRoot.turnHasContent("  ", [])).toBe(false);
  });

  test("seeds a title from its picture when there are no words", () => {
    expect(packageRoot.seedSessionTitle("fix   the\nbug", ["a.png"])).toBe("fix the bug");
    expect(packageRoot.seedSessionTitle("", ["Screenshot.png"])).toBe("Screenshot.png");
    expect(packageRoot.seedSessionTitle(" ", ["a.png", "b.png"])).toBe("2 images");
    expect(packageRoot.seedSessionTitle("")).toBe("");
  });
});
