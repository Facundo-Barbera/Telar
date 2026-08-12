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
  EngineEvent,
  Item,
  ItemDetail,
  Request,
  RequestKind,
  RuntimeMode,
  Session,
  Task as TaskSchema,
  Turn,
  autoResolution,
  livenessOf,
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
    for (const [name, schema] of Object.entries({ Session, Turn, Item, Request })) {
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
    const parsed = Request.safeParse({
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
      Request.safeParse({
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
    expect(livenessOf([task({ state: "waiting" })])).toBe("working");
  });
});

describe("Warp linkage", () => {
  test("an ordinary sub-agent carries no warp block", () => {
    // The structural claim of the design: aggregation is a projection, so
    // nothing has to know about warps to represent an agent.
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

  test("a warp agent is the same Task with linkage attached", () => {
    const parsed = TaskSchema.safeParse({
      id: "t1",
      sessionId: "s1",
      runId: "r1",
      kind: "agent",
      state: "running",
      startedAt: at,
      updatedAt: at,
      warp: {
        warpRunId: "w1",
        warpName: "review-changes",
        phaseIndex: 0,
        phaseTitle: "Review",
        agentIndex: 2,
      },
    });
    expect(parsed.success).toBe(true);
  });
});
