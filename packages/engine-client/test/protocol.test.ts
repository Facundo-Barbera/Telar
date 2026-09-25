/**
 * Protocol v2 tests.
 *
 * WHAT THESE ARE FOR. A schema file typechecks whether or not it is correct —
 * `z.object({})` is valid TypeScript and validates nothing. So these assert the
 * two properties a typecheck cannot see:
 *
 *   1. The schemas DISCRIMINATE — they reject the malformed payloads they exist
 *      to reject, not merely accept the good ones. An accept-only test suite
 *      passes over `z.unknown()`.
 *   2. The decisions encoded as code (auto-resolution, liveness, forward
 *      compatibility) behave as the contract's comments claim.
 */
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
    // The token is the ONLY thing standing between a loopback port and any
    // process on the machine, so a weak one must not parse.
    expect(EngineDiscovery.safeParse({ ...base, port: 4321, token: "short" }).success).toBe(false);
    expect(EngineDiscovery.safeParse({ ...base, port: 70000, token: "x".repeat(32) }).success).toBe(false);
    expect(EngineDiscovery.safeParse({ ...base, port: 4321, token: "x".repeat(32) }).success).toBe(true);
  });
});

describe("the package barrel", () => {
  /**
   * THE TRAP THIS PINS, because it is invisible to both tsc and a reading of
   * the source: when two modules reachable through `export *` export the same
   * NAME, ES semantics resolve the ambiguity by OMITTING the name — no error,
   * no warning, just `undefined` at every call site.
   *
   * It bit twice. `events.ts` briefly re-exported the entity schemas that
   * `entities.ts` already exported; and during the cutover v1 and v2 coexisted
   * sharing NINE names, which is why v2 was namespaced until v1 was deleted.
   * v1 is gone now and v2 is the package root — this asserts the root really
   * carries it rather than silently carrying nothing.
   */
  test("the protocol is exported from the package root, not swallowed by a name clash", () => {
    expect(packageRoot.ENGINE_PROTOCOL_VERSION).toBe(2);
    expect(typeof packageRoot.EngineEvent?.safeParse).toBe("function");
    expect(typeof packageRoot.autoResolution).toBe("function");
  });

  test("every entity schema survives the barrel", () => {
    // Each of these is exported by one module and IMPORTED by events.ts. If
    // events.ts ever re-exports one, it disappears from ../src/protocol and
    // this fails — which is the only signal anyone would get.
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

  /**
   * WHY THE SHELF SHELVED IT — issue #378. The stamp is what lets a row say
   * "settled after its work for X was delivered" instead of leaving a person
   * to wonder which of their decisions this was.
   */
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
    // A union of one today. Accepting a kind this build does not understand
    // would put an unreadable reason on a row that must be able to explain
    // itself; a client meeting a newer engine drops the whole session record
    // instead, which is the loud failure.
    expect(
      Session.safeParse({ ...session, settledBy: { kind: "vibes", coordinatorSessionId: "c", runId: "r", at } }).success,
    ).toBe(false);
  });

  test("the never-re-settle record is a list of assignment runs", () => {
    expect(Session.safeParse({ ...session, unsettledAssignments: ["run_task", "run_other"] }).success).toBe(true);
    expect(Session.safeParse({ ...session, unsettledAssignments: [""] }).success).toBe(false);
  });
});

/**
 * THE DELEGATION GRACE, AND WHAT A POLICY WRITTEN BEFORE IT STILL MEANS.
 *
 * The second field is defaulted rather than required for one reason, and it is
 * the reason worth a test: `getInboxPolicy` answers a failed parse with the
 * WHOLE default, so a required field would have thrown away the quiet window
 * every existing reader had chosen.
 */
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
    // The two are not alternatives: `input` is the durable record a
    // `sessions_read` hands back, `agentNotice` is what the recipient's model
    // was given instead. A client that kept only one of them would either
    // flood a context or lose a message.
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
    // OPTIONAL BY CONSTRUCTION: turns stored before notices existed have none,
    // and a decoder that required one would reject a session's own history.
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
    // THE POINT OF THE DISCRIMINATED UNION. v1's `data: Record<string,
    // unknown>` accepted this, which is why journal.ts had to hand-check
    // `typeof event.data.text === "string"` before touching a field.
    expect(ItemDetail.safeParse({ type: "file_change", command: { command: "ls" } }).success).toBe(false);
    expect(ItemDetail.safeParse({ type: "command_execution", change: { path: "a" } }).success).toBe(false);
  });

  test("an unknown item type is representable, so a new row is never dropped", () => {
    expect(ItemDetail.safeParse({ type: "unknown", label: "something new" }).success).toBe(true);
  });

  test("a steered agent message keeps its notice beside the body it stands in for", () => {
    // Declared on the schema rather than passed through untyped, because a zod
    // object DROPS what it does not declare — an undeclared `notice` would be
    // silently erased at exactly the seam that carries it to the transcript.
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
    // A cached client WILL meet a newer engine. One unrecognised row must not
    // kill the stream.
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
    // The one kind the engine has no defensible answer to invent. A fabricated
    // answer to a question is worse than a parked session, and this is the
    // assertion that stops a later "make auto really mean auto" change from
    // quietly making one up.
    for (const mode of RuntimeMode.options) {
      expect(autoResolution(mode, "user_input"), mode).toBeNull();
      expect(requiresHuman(mode, "user_input"), mode).toBe(true);
    }
  });

  test("secret_access NEVER auto-resolves, in any mode — full-access included", () => {
    // A mode widens what the AGENT may do, never what the VAULT gives up. A
    // credential fill also carries the human's item pick in its resolution,
    // which no policy could invent. This is the load-bearing assertion of the
    // 1Password design: if it goes red, secrets can leave the vault unasked.
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
    // "It was stuck and nobody was notified" has to be a detectable state, not
    // an inference from absence.
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
  /**
   * WHAT THIS BLOCK USED TO SAY, and why the inversion is the point.
   *
   * It asserted that an ordinary sub-agent carried no `warp` block and that a
   * Warp agent was the SAME `Task` with linkage attached — the structural claim
   * that aggregation is a projection, so nothing had to know about warps to
   * represent an agent. #877 retired Warp. The projection claim survives; the
   * block does not, and these tests now pin its absence.
   */
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
    /**
     * ASSERTED ON THE OUTPUT, not on `success`. Zod strips unknown keys rather
     * than rejecting them, so a schema that merely no longer declares `warp`
     * would still parse this happily — and a test reading `success` alone would
     * pass identically whether the field was removed or still declared. What
     * matters to a client is that nothing downstream can read it back.
     */
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
  /**
   * THE ROUND TRIP, PINNED, because a broken one is invisible.
   *
   * The bug this exists for: the cockpit built this query correctly, the engine
   * parsed it correctly, and the Next adapter in between forwarded only `refresh`.
   * Choosing a milestone typechecked at every layer, passed every test, sent a
   * request with the milestone in it — and returned every issue in the repository.
   * Nothing failed. It just did nothing.
   */
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
