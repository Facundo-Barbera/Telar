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

describe("SpoolSubject identity — area and color", () => {
  const base = { key: "casa", name: "Casa", created: "Tue", schemaVersion: 1 };

  test("both fields are optional — a subject with no identity is fully ordinary", () => {
    const parsed = packageRoot.SpoolSubject.parse(base);
    expect(parsed.area).toBeUndefined();
    expect(parsed.color).toBeUndefined();
  });

  test("color is a CLOSED token set — a hex value or an urgency word is refused, a token passes", () => {
    // The closed set is the design law made structural: color says WHOSE a
    // subject is, never how urgent, and free hex is how an "urgent red" would
    // sneak in.
    expect(packageRoot.SpoolSubjectColor.options).toEqual(["plum", "sea", "moss", "amber", "slate", "rose", "sky", "sand"]);
    expect(packageRoot.SpoolSubject.safeParse({ ...base, color: "#ff0000" }).success).toBe(false);
    expect(packageRoot.SpoolSubject.safeParse({ ...base, color: "red" }).success).toBe(false);
    const parsed = packageRoot.SpoolSubject.parse({ ...base, area: "Personal", color: "sea" });
    expect(parsed.area).toBe("Personal");
    expect(parsed.color).toBe("sea");
  });

  test("rank is optional — a subject with none is fully ordinary, and a stated one round-trips", () => {
    const parsed = packageRoot.SpoolSubject.parse(base);
    expect(parsed.rank).toBeUndefined();
    expect(packageRoot.SpoolSubject.parse({ ...base, rank: 2 }).rank).toBe(2);
  });
});

describe("SpoolAperture and SpoolArea — the smart view and the permit ceiling", () => {
  test("the aperture's view is a CLOSED set, and the shape is one value with no history", () => {
    // Today and Scheduled are apertures of one room, not routes — and the slot
    // holds one current value, so the schema is an object, never an array.
    expect(packageRoot.SpoolApertureView.options).toEqual(["everything", "today", "scheduled"]);
    expect(packageRoot.SpoolAperture.parse({ view: "today" })).toMatchObject({ view: "today", schemaVersion: 1 });
    expect(packageRoot.SpoolAperture.safeParse({ view: "urgent" }).success).toBe(false);
  });

  test("an area's ceiling is optional and drawn from the SAME permit enum as subjects", () => {
    // One enum, one ordering: a ceiling that spelled its own levels could
    // drift from the levels it exists to clamp.
    const bare = packageRoot.SpoolArea.parse({ name: "Personal", created: "Sat" });
    expect(bare.ceiling).toBeUndefined();
    expect(bare.schemaVersion).toBe(1);
    const capped = packageRoot.SpoolArea.parse({ name: "Personal", ceiling: "read", created: "Sat" });
    expect(capped.ceiling).toBe("read");
    expect(packageRoot.SpoolArea.safeParse({ name: "Personal", ceiling: "urgent", created: "Sat" }).success).toBe(false);
  });
});

describe("SpoolTagUsage — one tag's read-time row in the warehouse", () => {
  test("a tag row is just the name and its two counts, both required numbers", () => {
    const row = packageRoot.SpoolTagUsage.parse({ tag: "urgente", items: 2, notes: 1 });
    expect(row).toEqual({ tag: "urgente", items: 2, notes: 1 });
    expect(packageRoot.SpoolTagUsage.safeParse({ tag: "urgente", items: 2 }).success).toBe(false);
  });
});

describe("SpoolNote, SpoolSearchHit, tags and the socket card — the shelf/search/socket pass", () => {
  const stamp = { label: "Tue 16:42", at: 1_700_000_000_000 };

  test("a note parses with its defaults, keeps unknown keys, and refuses an author outside the two hands", () => {
    const note = packageRoot.SpoolNote.parse({
      id: "n-1",
      title: "NO TOCAR #302/#304",
      body: "frozen until the client confirms",
      created: stamp,
      updated: stamp,
      author: "session",
      futureKey: "kept", // z.looseObject — a later build's field survives
    });
    expect(note.tags).toEqual([]); // defaulted
    expect(note.schemaVersion).toBe(1);
    expect((note as Record<string, unknown>).futureKey).toBe("kept");
    // The author set is CLOSED — provenance has exactly two hands.
    expect(
      packageRoot.SpoolNote.safeParse({ id: "n-2", title: "t", body: "b", created: stamp, updated: stamp, author: "model" }).success,
    ).toBe(false);
    // A retirement carries its reason or it is not a retirement.
    expect(
      packageRoot.SpoolNote.safeParse({ id: "n-3", title: "t", body: "b", created: stamp, updated: stamp, author: "you", retired: { label: "Tue", at: 1 } }).success,
    ).toBe(false);
  });

  test("a search hit's kind is the closed four, and `closed` is the marked-not-hidden channel", () => {
    const hit = packageRoot.SpoolSearchHit.parse({ kind: "note", id: "n-1", title: "t", snippet: "s", closed: true });
    expect(hit.closed).toBe(true);
    expect(packageRoot.SpoolSearchHit.safeParse({ kind: "lane", id: "x", title: "t", snippet: "s" }).success).toBe(false);
  });

  test("an item carries tags additively, and the look outcome carries digest lines the same way", () => {
    const item = packageRoot.SpoolItem.parse({
      id: "i-1",
      title: "cuadrar facturación",
      provenance: "you",
      captured: "Tue 16:42",
      tags: ["facturación", "q3"],
    });
    expect(item.tags).toEqual(["facturación", "q3"]);
    // Absent stays absent — additive, no default array materialises on packets.
    expect(packageRoot.SpoolItem.parse({ id: "i-2", title: "x", provenance: "you", captured: "Tue" }).tags).toBeUndefined();

    const outcome = packageRoot.SpoolLookOutcome.parse({
      subject: "ozom-gv",
      fresh: false,
      digest: [{ text: "Hito 1 · Agosto — 8 PRs merged, 7 issues closed", observationIds: ["o-1", "o-2"] }],
    });
    expect(outcome.digest![0]!.observationIds).toEqual(["o-1", "o-2"]);
    expect(packageRoot.SpoolLookOutcome.parse({ subject: "s", fresh: false }).digest).toBeUndefined();
  });

  test("the socket's connect card is three strings, all required — a card with no secret is not a card", () => {
    const card = { url: "http://127.0.0.1:4321/v2/spool/mcp", secret: "s".repeat(43), addCommand: "claude mcp add …" };
    expect(packageRoot.SpoolMcpInfo.parse(card)).toEqual(card);
    expect(packageRoot.SpoolMcpInfo.safeParse({ url: card.url, addCommand: card.addCommand }).success).toBe(false);
  });
});

describe("SpoolPickup.moved is addressed — a person can be on several subjects at once", () => {
  test("a moved line is a subject and a text, not a bare sentence", () => {
    // With `currentFocus` never ending the others, several subjects can be
    // open at once — a plain string here is unattributable the moment two
    // are, which is exactly the bug a focused room hit: another subject's
    // moved line rendered under its "In its hands" band with no way to tell
    // it apart. `SpoolMoved` is the fix's addressed shape.
    const moved = packageRoot.SpoolMoved.parse({ subject: "ozom-gv", text: "Hito 1 — answered: yes." });
    expect(moved).toEqual({ subject: "ozom-gv", text: "Hito 1 — answered: yes." });
    expect(packageRoot.SpoolMoved.safeParse({ text: "no subject" }).success).toBe(false);
  });

  test("the pickup's moved array is SpoolMoved[], not string[]", () => {
    const pickup = packageRoot.SpoolPickup.parse({
      current: [],
      moved: [{ subject: "ozom-gv", text: "Hito 1 — answered: yes." }],
      waiting: [],
    });
    expect(pickup.moved).toEqual([{ subject: "ozom-gv", text: "Hito 1 — answered: yes." }]);
    expect(packageRoot.SpoolPickup.safeParse({ current: [], moved: ["a bare sentence"], waiting: [] }).success).toBe(
      false,
    );
  });
});

describe("SpoolLobby — mission control, ranked, never enumerated", () => {
  test("a lobby subject carries needsYou/moved/sessionLive/folded, and sessionLive is three-valued", () => {
    const subjectRow = {
      key: "ozom-gv",
      name: "Ozom GV",
      area: "Ozom",
      color: "sea",
      needsYou: 3,
      moved: { count: 2, line: "As of the look at Sat 07:40: 8 PRs merged, 7 issues closed" },
      sessionLive: true,
      nextPin: { day: "2026-08-18", label: "Tuesday" },
      folded: false,
    };
    expect(packageRoot.SpoolLobbySubject.parse(subjectRow)).toEqual(subjectRow);
    // sessionLive is a real boolean or an honest null — never omitted, never guessed.
    expect(packageRoot.SpoolLobbySubject.parse({ ...subjectRow, sessionLive: null, nextPin: undefined }).sessionLive).toBeNull();
    expect(packageRoot.SpoolLobbySubject.safeParse({ ...subjectRow, sessionLive: undefined }).success).toBe(false);
    // `rank` rides along the same card, absent by default — what lets a drag
    // surface compute drop positions without a second fetch of the registry.
    expect(packageRoot.SpoolLobbySubject.parse(subjectRow).rank).toBeUndefined();
    expect(packageRoot.SpoolLobbySubject.parse({ ...subjectRow, rank: 1 }).rank).toBe(1);
  });

  test("moved carries a line only when the look composed one — a moved count with no digest is still honest", () => {
    expect(packageRoot.SpoolLobbyMoved.parse({ count: 0 })).toEqual({ count: 0 });
    expect(packageRoot.SpoolLobbyMoved.parse({ count: 2, line: "As of the look at Sat 07:40: …" }).line).toBeDefined();
  });

  test("nextPin's label is a stored weekday, never a bare date — and the day must be ISO", () => {
    expect(packageRoot.SpoolLobbyNextPin.parse({ day: "2026-08-18", label: "Tuesday" })).toEqual({
      day: "2026-08-18",
      label: "Tuesday",
    });
    expect(packageRoot.SpoolLobbyNextPin.safeParse({ day: "8/18/2026", label: "Tuesday" }).success).toBe(false);
  });

  test("an area groups its subjects and carries its own raw ceiling — never a composed rollup sentence", () => {
    const area = {
      name: "Ozom",
      ceiling: "draft",
      subjects: [
        {
          key: "ozom-gv",
          name: "Ozom GV",
          needsYou: 0,
          moved: { count: 0 },
          sessionLive: false,
          folded: true,
        },
      ],
    };
    expect(packageRoot.SpoolLobbyArea.parse(area)).toEqual(area);
    // No default ceiling — an area that has never stated one carries none.
    expect(packageRoot.SpoolLobbyArea.parse({ name: "Ozom", subjects: [] }).ceiling).toBeUndefined();
  });

  test("the lobby is areas (in whatever order the caller sorted them) plus one unareaed remainder — never a flat list", () => {
    const lobby = packageRoot.SpoolLobby.parse({
      areas: [{ name: "Ozom", subjects: [] }],
      unareaed: [
        { key: "floating-subject", name: "Floating", needsYou: 0, moved: { count: 0 }, sessionLive: null, folded: true },
      ],
    });
    expect(lobby.areas).toHaveLength(1);
    expect(lobby.unareaed).toHaveLength(1);
    expect(packageRoot.SpoolLobby.safeParse({ areas: [] }).success).toBe(false);
  });
});

describe("SpoolBrief — the re-entry brief for one subject's room", () => {
  test("an open thread quotes the stored question, and handle/who/note are additive — present only when stored", () => {
    const bare = packageRoot.SpoolBriefOpenThread.parse({ threadId: "t-1", question: "Does our ad data match?" });
    expect(bare.handle).toBeUndefined();
    expect(bare.who).toBeUndefined();
    const full = packageRoot.SpoolBriefOpenThread.parse({
      threadId: "t-2",
      question: "Does our ad data match?",
      handle: "#ad-data",
      who: "Ana",
      note: "needs the live tracker",
    });
    expect(full).toEqual({
      threadId: "t-2",
      question: "Does our ad data match?",
      handle: "#ad-data",
      who: "Ana",
      note: "needs the live tracker",
    });
  });

  test("a next item is cited — source is required, never a bare title with no provenance", () => {
    const next = packageRoot.SpoolBriefNextItem.parse({ itemId: "i-1", title: "an item", source: "pinned to 2026-08-18" });
    expect(next.source).toBe("pinned to 2026-08-18");
    expect(packageRoot.SpoolBriefNextItem.safeParse({ itemId: "i-1", title: "an item" }).success).toBe(false);
  });

  test("a dead item is facts only — id and title, no composed verdict", () => {
    const dead = packageRoot.SpoolBriefDeadItem.parse({ itemId: "i-1", title: "an item" });
    expect(dead).toEqual({ itemId: "i-1", title: "an item" });
  });

  test("the brief composes pickup/sinceYourLook/open/next/notes/deadItems for exactly one subject, next capped at 3", () => {
    const brief = packageRoot.SpoolBrief.parse({
      subject: "ozom-gv",
      pickup: { current: [], moved: [] },
      sinceYourLook: { subject: "ozom-gv", fresh: false },
      open: { stuckOnYou: [], waitingOnOthers: [] },
      next: [],
      notes: { count: 0 },
      deadItems: [],
    });
    expect(brief.subject).toBe("ozom-gv");
    // sinceYourLook reuses SpoolLookOutcome whole — the brief never calls out, so `fresh` stays honestly false.
    expect(brief.sinceYourLook.fresh).toBe(false);

    const tooMany = [
      { itemId: "i-1", title: "a", source: "pinned to 2026-08-18" },
      { itemId: "i-2", title: "b", source: "pinned to 2026-08-19" },
      { itemId: "i-3", title: "c", source: "pinned to 2026-08-20" },
      { itemId: "i-4", title: "d", source: "pinned to 2026-08-21" },
    ];
    expect(packageRoot.SpoolBrief.safeParse({ ...brief, next: tooMany }).success).toBe(false);
  });
});
