// Hermetic tests for the "workspace" in-process MCP server (story 5.1, AC5–AC8).
//
// HARNESS: ultra-mcp.test.ts's, copied deliberately — @telar/core is
// mock.module'd so THIS SUITE REACHES NO STATE ROOT, and the SDK server's
// registered handlers are invoked directly. Note the precise claim: not "touches
// no disk" but "reaches no state root". The store's own disk behaviour is
// packages/core/test/workspace-store.test.ts's, under a sandboxed TELAR_HOME;
// what is proved HERE is the server's own behaviour, which is why the store is a
// stub rather than the real thing.
//
// THE SOURCE-TEXT ARMS ARE NOT HERE ON PURPOSE. "no z.object( in this file" and
// "no rmSync in any handler" are claims about SOURCE TEXT, which is
// invariants.test.ts's native idiom (INV-11 arms 4 and 5) and not this file's.
// Splitting them that way also keeps them tree-wide: a scan scoped to the file
// it is defending is vacuous the moment someone adds a second file.
//
// T2 — THIS IS THE FOURTH PROCESS-GLOBAL mock.module("@telar/core", …) IN
// apps/web, and the snapshot-and-restore ritual below does NOT contain the leak:
// mock.module runs at module EVALUATION, and under a filtered run bun evaluates
// every file's module scope before running any test, so afterAll never fires.
// Repairing the three existing instances is story 1.3's item and is not this
// story's — but this file does not become a fourth silent one either: the mock
// is installed in the narrowest form that still works, and the LAST test in this
// file is a vacuity guard that fails loudly if the stub is live where it should
// not be.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dep of this Next app
// (loom-mcp.answer-blocked.test.ts carries the identical note). The runtime is
// `bun test`.
// @ts-expect-error no @types/bun in this workspace
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
// Capture the REAL @telar/core (hoisted above the mock.module below) so afterAll
// can restore it — bun's mock.module is process-global and would otherwise leak
// into sibling test files.
import * as realCore from "@telar/core";
import type { AccountProfile } from "@telar/core";

// SNAPSHOT the real exports into a plain object NOW, before mock.module runs.
// `realCore` is a live ES-module namespace: once mock.module replaces the
// module, `realCore`'s own bindings reflect the MOCK, so restoring
// `() => realCore` in afterAll would re-install the mock and leak it forward.
const realCoreSnapshot = { ...realCore };

// ── the fake store (reset in beforeEach) ────────────────────────────────────
type FakeItem = Record<string, unknown> & { id: string; title: string };
type FakeLane = { key: string; label: string; window: string; note?: string; items: string[] };

let lanes: FakeLane[] = [];
let items: FakeItem[] = [];
let unreadable: { id: string; reason: string }[] = [];
const createItemCalls: Record<string, unknown>[] = [];
const updateItemCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
let createItemThrows: string | null = null;
let updateItemThrows: string | null = null;

const PATCHABLE = ["title", "lane", "project", "desk", "unplaced", "mirrored", "deadline", "verdict"];

// THE STUBS ARE NAMED LOCAL FUNCTIONS, not inline members of the mock factory,
// and that is so the harness's own tests can exercise them WITHOUT calling
// `<namespace>.readLanes(...)`. INV-7's readerCallSites resolves dynamic-import
// namespace bindings, so `(await import("@telar/core")).updateItem(…)` in this
// file reads to the scanner as an un-sandboxed reader call — correctly, since
// it cannot know the module is mocked. Calling the local double instead is not
// evasion: `stubUpdateItem` genuinely is a test double and genuinely reaches no
// state root, which is exactly what the scan is asking this file to demonstrate.
let readLanesCalls = 0;

const stubReadLanes = () => {
  readLanesCalls++;
  return lanes;
};

const stubUpdateItem = (id: string, patch: Record<string, unknown>) => {
  updateItemCalls.push({ id, patch });
  if (updateItemThrows) throw new Error(updateItemThrows);
  // The real store THROWS on a forbidden key; the double mirrors that, or this
  // suite would prove the server safe against a store that is not.
  const forbidden = Object.keys(patch).filter((k) => !PATCHABLE.includes(k));
  if (forbidden.length) throw new Error(`AC9/NFR-OW-19: updateItem cannot write ${forbidden.join(", ")}`);
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  Object.assign(item, patch);
  if (patch.lane !== undefined) item.lane = patch.lane;
  return item;
};

mock.module("@telar/core", () => ({
  readLanes: stubReadLanes,
  listItems: () => ({ items, unreadable }),
  getWorkspaceItem: (id: string) => items.find((i) => i.id === id) ?? null,
  rankOf: (ls: FakeLane[], id: string) => {
    for (const l of ls) {
      const i = l.items.indexOf(id);
      if (i >= 0) return i + 1;
    }
    return null;
  },
  createItem: (input: Record<string, unknown>) => {
    createItemCalls.push(input);
    if (createItemThrows) throw new Error(createItemThrows);
    const known = lanes.some((l) => l.key === input.lane);
    const item: FakeItem = {
      id: "i-new001",
      title: input.title as string,
      provenance: "session",
      captured: "Tue 16:42",
      schemaVersion: 1,
      lane: known ? (input.lane as string) : "unfiled",
      desk: true,
      ...(known ? {} : { unplaced: true }),
      ...(input.project ? { project: input.project } : {}),
      timeline: [{ at: "Tue 16:42", actor: "session", text: input.creationNote as string }],
    };
    items.push(item);
    const target = lanes.find((l) => l.key === item.lane);
    if (target) target.items.push(item.id);
    return item;
  },
  updateItem: stubUpdateItem,
  readPacketAttachments: () => [],
  attachmentTally: () => ({ files: 0, mockups: 0 }),
}));

afterAll(() => {
  mock.module("@telar/core", () => realCoreSnapshot);
});

const { createWorkspaceMcpServer, WORKSPACE_AUTO_TOOLS } = await import("./workspace-mcp");

// Reach into the SDK server's registered tools to invoke a handler directly —
// identical idiom to ultra-mcp.test.ts's toolHandler.
function toolHandler(server: unknown, name: string) {
  const tools = (
    server as {
      instance: { _registeredTools: Record<string, { handler: (a: unknown, extra: unknown) => Promise<unknown> }> };
    }
  ).instance._registeredTools;
  const t = tools[name];
  if (!t) throw new Error(`tool ${name} not registered`);
  return (args: Record<string, unknown> = {}) => t.handler(args, {});
}

function registry(server: unknown): Record<string, unknown> {
  return (server as { instance: { _registeredTools: Record<string, unknown> } }).instance._registeredTools;
}

function inputSchemaKeys(server: unknown, name: string): string[] {
  const tools = (
    server as { instance: { _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }> } }
  ).instance._registeredTools;
  return Object.keys(tools[name]?.inputSchema?.shape ?? {});
}

const account = { name: "facundo@personal", provider: "claude" } as unknown as AccountProfile;

function makeServer(overrides: Partial<Parameters<typeof createWorkspaceMcpServer>[0]> = {}) {
  return createWorkspaceMcpServer({
    project: "aurora",
    account,
    getSessionId: () => "sess-1",
    ...overrides,
  });
}

const textOf = (r: unknown) =>
  ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
const isError = (r: unknown) => Boolean((r as { isError?: boolean }).isError);
const jsonOf = (r: unknown) => JSON.parse(textOf(r));

beforeEach(() => {
  lanes = [
    { key: "aurora", label: "Aurora", window: "work hours", items: ["i-a1"] },
    { key: "unfiled", label: "Unfiled", window: "whenever", items: [] },
  ];
  items = [
    { id: "i-a1", title: "Accept payments-retry loom", project: "aurora", lane: "aurora", provenance: "note", captured: "Tue 16:42", schemaVersion: 1, desk: true },
    { id: "i-o1", title: "Another project's secret", project: "office", lane: "aurora", provenance: "note", captured: "Wed 09:00", schemaVersion: 1 },
    { id: "i-f1", title: "A floating note", lane: "aurora", provenance: "note", captured: "Wed 11:02", schemaVersion: 1 },
  ];
  unreadable = [];
  createItemCalls.length = 0;
  updateItemCalls.length = 0;
  createItemThrows = null;
  updateItemThrows = null;
});

// ── AC6 proof 4 — registration ──────────────────────────────────────────────

describe("workspace MCP server — tool registration", () => {
  test("registers exactly the four tools, IN ORDER, matching WORKSPACE_AUTO_TOOLS", () => {
    // The ultra-style registry test. The loom side has no equivalent; that is
    // the hole this deliberately does not reproduce.
    expect([...WORKSPACE_AUTO_TOOLS]).toEqual([
      "mcp__workspace__list_items",
      "mcp__workspace__list_lanes",
      "mcp__workspace__create_item",
      "mcp__workspace__update_item",
    ]);
    const names = Object.keys(registry(makeServer()));
    expect(names).toEqual(["list_items", "list_lanes", "create_item", "update_item"]);
    // The constant and the registration say the same thing in the same order —
    // MCP_INVENTORY compares tool lists as ORDERED lists, so a reorder here
    // would drift from invariants.test.ts with a message about ordering.
    expect(names.map((n) => `mcp__workspace__${n}`)).toEqual([...WORKSPACE_AUTO_TOOLS]);
  });

  test("the four names carry no accept-shaped token — the moat, judged semantically", () => {
    // ACCEPT_STEMS, verbatim from invariants.test.ts. Duplicated here for the
    // same reason core duplicates the tool names: this file cannot import a
    // test's internals, and the pin is what makes the duplication safe.
    const ACCEPT_STEMS = ["accept", "approve", "done", "complete", "land", "merge", "ship", "deliver", "finalize", "promote", "finish", "resolve", "close", "confirm", "sign", "ack", "clear"];
    const accepty = (n: string) =>
      n.split(/[^A-Za-z0-9]+/).filter(Boolean).map((t) => t.toLowerCase())
        .filter((t) => ACCEPT_STEMS.some((s) => t.startsWith(s)));
    for (const n of Object.keys(registry(makeServer()))) expect(accepty(n)).toEqual([]);
    // TWO-DIRECTION DISCRIMINATOR: the same function really does fire on the
    // names this surface is forbidden to grow.
    expect(accepty("promote_subtask")).toEqual(["promote"]);
    expect(accepty("close_lane")).toEqual(["close"]);
    expect(accepty("mark_completed")).toEqual(["completed"]);
  });
});

// ── AC8 proof 5 — no identity and no scope on any input shape ───────────────

describe("AC8 the negative tool contract — input shapes carry no identity and no scope", () => {
  test("every input shape's EXACT key set is pinned, and none of them names project/account/session", () => {
    const s = makeServer();
    expect(new Set(inputSchemaKeys(s, "list_items"))).toEqual(new Set([]));
    expect(new Set(inputSchemaKeys(s, "list_lanes"))).toEqual(new Set([]));
    expect(new Set(inputSchemaKeys(s, "create_item"))).toEqual(new Set(["title", "laneKey"]));
    expect(new Set(inputSchemaKeys(s, "update_item"))).toEqual(
      new Set(["itemId", "title", "laneKey", "desk", "unplaced", "mirrored"]),
    );

    // ANTI-VACUITY FIRST: the scan really found the four real tools, so the
    // absences below are statements about a surface rather than about {}.
    const all = Object.keys(registry(s));
    expect(all.length).toBe(4);

    const everyKey = all.flatMap((n) => inputSchemaKeys(s, n));
    expect(everyKey.length).toBeGreaterThanOrEqual(8);
    for (const forbidden of [
      // identity
      "by", "account", "sessionId", "session", "provenance", "actor",
      // scope — hard rule 8: a `project` key here is the cross-project leak
      "project", "projectSlug",
      // path-shaped: permissions.ts's PATH_KEYS, resolved for EVERY tool call
      "path", "file_path", "notebook_path",
      // the moat and the never-overwritten fields
      "raw", "rawSource", "promotedFrom", "tracking", "subtasks", "timeline",
      "status", "state", "accepted", "schemaVersion", "captured", "rank",
    ]) {
      expect(everyKey).not.toContain(forbidden);
    }
  });

  test("no tool can create, rename, split or retire a lane — list_lanes only READS", () => {
    const s = makeServer();
    const names = Object.keys(registry(s));
    expect(names.filter((n) => /lane/.test(n))).toEqual(["list_lanes"]);
    // …and the one lane-shaped input anywhere is a lane KEY to file into, never
    // a lane definition to author: no label and no window can be passed.
    const laneInputs = names.flatMap((n) => inputSchemaKeys(s, n)).filter((k) => /lane/i.test(k));
    expect(laneInputs).toEqual(["laneKey", "laneKey"]);
    for (const k of ["label", "window", "note", "lanes"]) {
      expect(names.flatMap((n) => inputSchemaKeys(s, n))).not.toContain(k);
    }
  });

  test("there is no delete tool, and nothing in the surface is delete-shaped", () => {
    for (const n of Object.keys(registry(makeServer()))) {
      expect(n).not.toMatch(/delete|remove|drop|purge|destroy|archive|clear/);
    }
    // Discriminator: the same predicate fires on names this surface must never
    // grow, so it is a check rather than a tautology over four short strings.
    for (const bad of ["delete_item", "remove_lane", "purge_workspace"]) {
      expect(bad).toMatch(/delete|remove|drop|purge|destroy|archive|clear/);
    }
  });
});

// ── AC5 proof 1 — the scope is opts.project, resolved server-side ───────────

describe("AC5 list_items returns THIS session's project slice", () => {
  test("a project-scoped server returns only that project's items; floating ones are excluded, not errors", async () => {
    const res = await toolHandler(makeServer(), "list_items")();
    expect(isError(res)).toBe(false);
    const out = jsonOf(res);
    expect(out.scope).toBe("aurora");
    expect(out.items.map((i: { id: string }) => i.id)).toEqual(["i-a1"]);
    // The floating item and the other project's item are both simply absent.
    expect(textOf(res)).not.toContain("Another project's secret");
    expect(textOf(res)).not.toContain("A floating note");
  });

  test("an UNSCOPED server (5.3's master) returns everything — the branch exists so 5.3 edits nothing", async () => {
    const res = await toolHandler(makeServer({ project: undefined }), "list_items")();
    const out = jsonOf(res);
    expect(out.scope).toBe("all projects");
    expect(out.items.map((i: { id: string }) => i.id)).toEqual(["i-a1", "i-o1", "i-f1"]);
  });

  test("SMUGGLING: feeding project/account into list_items changes nothing — the server's own values win", async () => {
    const res = await toolHandler(makeServer(), "list_items")({
      project: "EVIL",
      account: "EVIL",
      sessionId: "EVIL",
    });
    const out = jsonOf(res);
    expect(out.scope).toBe("aurora"); // never "EVIL"
    expect(out.items.map((i: { id: string }) => i.id)).toEqual(["i-a1"]);
  });

  test("list_items surfaces the unreadable channel so one bad packet never blanks the rest", async () => {
    unreadable = [{ id: "i-bad", reason: "listed in lane \"aurora\" but has no readable packet" }];
    const out = jsonOf(await toolHandler(makeServer(), "list_items")());
    expect(out.items.length).toBe(1);
    expect(out.unreadable).toEqual(unreadable);
    // …and it is omitted entirely when there is nothing wrong.
    unreadable = [];
    expect(jsonOf(await toolHandler(makeServer(), "list_items")()).unreadable).toBeUndefined();
  });

  test("the reported lane is the AUTHORITATIVE one from lanes.yaml, not the packet's stale recovery hint", async () => {
    // AD-6: a hand-edit WINS. When a human moves an id between stacks in
    // lanes.yaml the store deliberately does NOT rewrite packet.yaml — that is
    // what keeps a reorder to one small file — so `item.lane` is stale by
    // design afterwards. Reporting it would tell the session the OLD lane after
    // every hand-edit. (Found by the dev-server proof's cross-lane move, not by
    // a unit test; this is that finding, pinned.)
    lanes = [
      { key: "aurora", label: "Aurora", window: "work hours", items: [] },
      { key: "office", label: "Office", window: "work hours", items: ["i-a1"] },
    ];
    // i-a1's packet still says `lane: "aurora"` — the stale hint.
    expect(items.find((i) => i.id === "i-a1")!.lane).toBe("aurora");

    const out = jsonOf(await toolHandler(makeServer(), "list_items")());
    expect(out.items[0]!.lane).toBe("office"); // lanes.yaml won
    expect(out.items[0]!.rank).toBe(1);
  });

  test("an item in NO stack falls back to its packet's hint, then to null", async () => {
    // The other direction, so the line above is a choice rather than a constant.
    lanes = [{ key: "free", label: "Free", window: "whenever", items: [] }];
    const out = jsonOf(await toolHandler(makeServer(), "list_items")());
    expect(out.items[0]!.lane).toBe("aurora"); // the hint, since no stack holds it
    expect(out.items[0]!.rank).toBeNull(); // unfiled — a resting state, not an error
  });

  test("list_lanes reports the user's lanes with counts and never their contents", async () => {
    const out = jsonOf(await toolHandler(makeServer(), "list_lanes")());
    expect(out).toEqual([
      { key: "aurora", label: "Aurora", window: "work hours", items: 1 },
      { key: "unfiled", label: "Unfiled", window: "whenever", items: 0 },
    ]);
  });
});

// ── AC5 proof 2/3/4 — creating one files it, stamps provenance, desks it ────

describe("AC5 create_item files, stamps provenance and places on the desk", () => {
  test("returns {id, lane, rank, provenance, desk} and files into the named lane", async () => {
    const res = await toolHandler(makeServer(), "create_item")({ title: "Call María", laneKey: "aurora" });
    expect(isError(res)).toBe(false);
    const out = jsonOf(res);
    expect(out).toEqual({ id: "i-new001", lane: "aurora", rank: 2, provenance: "session", desk: true });
  });

  test("the project is the SERVER's, and the session id rides the creation note's TEXT — never tool input", async () => {
    await toolHandler(makeServer({ getSessionId: () => "sess-42" }), "create_item")({
      title: "captured",
      laneKey: "aurora",
      project: "EVIL",
      account: "EVIL",
      provenance: "EVIL",
      by: "EVIL",
    } as Record<string, unknown>);
    expect(createItemCalls.length).toBe(1);
    const input = createItemCalls[0]!;
    expect(input.project).toBe("aurora"); // the SERVER's, never "EVIL"
    expect(input.creationNote).toBe("captured by facundo@personal in this session (sess-42)");
    expect(input.creationNote).not.toContain("EVIL");
    // No identity or scope key was forwarded to the store at all.
    expect(Object.keys(input).sort()).toEqual(["creationNote", "lane", "project", "title"]);
  });

  test("a session with NO id still captures the task — an item without a session is just an item", async () => {
    // watch_loom returns an actionable error when it has no session because a
    // watch without one is an orphan. Refusing to capture the user's task
    // because the chat is not yet persisted is the worse failure.
    const res = await toolHandler(makeServer({ getSessionId: () => null }), "create_item")({ title: "turn one" });
    expect(isError(res)).toBe(false);
    expect(createItemCalls[0]!.creationNote).toBe("captured by facundo@personal in this session");
  });

  test("an UNKNOWN lane files into unfiled and ASKS — it never creates the lane", async () => {
    const out = jsonOf(await toolHandler(makeServer(), "create_item")({ title: "the pdf thing", laneKey: "nope" }));
    expect(out.lane).toBe("unfiled");
    expect(out.unplaced).toBe(true);
    expect(out.note).toContain("Lanes are theirs to create");
    expect(lanes.map((l) => l.key)).toEqual(["aurora", "unfiled"]); // NFR-OW-10 held
  });

  test("a write that fails returns an actionable errResult rather than throwing through the SDK", async () => {
    createItemThrows = "EACCES: the store is not writable";
    const res = await toolHandler(makeServer(), "create_item")({ title: "doomed" });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("Could not file");
    expect(textOf(res)).toContain("EACCES");
  });
});

// ── AC8 / AC9 — update_item cannot reach the protected fields ──────────────

describe("update_item is narrow by construction", () => {
  test("only the permitted fields reach the store, and `lane` is the store's spelling of laneKey", async () => {
    await toolHandler(makeServer(), "update_item")({
      itemId: "i-a1",
      title: "renamed",
      laneKey: "unfiled",
      desk: false,
    });
    expect(updateItemCalls.length).toBe(1);
    expect(updateItemCalls[0]!.patch).toEqual({ title: "renamed", lane: "unfiled", desk: false });
  });

  test("SMUGGLING: raw/rawSource/promotedFrom/project fed as arguments never reach the patch", async () => {
    await toolHandler(makeServer(), "update_item")({
      itemId: "i-a1",
      title: "ok",
      raw: "REWRITTEN",
      rawSource: "REWRITTEN",
      promotedFrom: "i-evil",
      tracking: { loomId: "l-evil" },
      project: "EVIL",
      schemaVersion: 99,
    } as Record<string, unknown>);
    expect(updateItemCalls[0]!.patch).toEqual({ title: "ok" });
    for (const k of ["raw", "rawSource", "promotedFrom", "tracking", "project", "schemaVersion"]) {
      expect(Object.keys(updateItemCalls[0]!.patch)).not.toContain(k);
    }
  });

  test("HARNESS FIDELITY — the store double rejects a forbidden key exactly as the real store does", () => {
    // The claim, stated precisely rather than overstated: this proves the DOUBLE
    // is not more permissive than the real store, so the test above is a
    // statement about the SERVER's filtering and not an artefact of a lenient
    // fake. The real store's own rejection is proved where it belongs, against
    // real disk — packages/core/test/workspace-store.test.ts, "AC9 a hostile
    // updateItem past the type leaves both fields byte-identical AND is
    // REPORTED". Neither file can prove the other's half.
    let thrown: Error | null = null;
    try {
      stubUpdateItem("i-a1", { raw: "REWRITTEN" });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("AC9");
    // …and it still writes a PERMITTED field, so it is not simply refusing
    // everything.
    expect((stubUpdateItem("i-a1", { title: "allowed" }) as { title: string }).title).toBe("allowed");
  });

  test("an item in ANOTHER project is indistinguishable from one that does not exist, and is NOT written", async () => {
    const res = await toolHandler(makeServer(), "update_item")({ itemId: "i-o1", title: "stolen" });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toBe('No workspace item found with id "i-o1".');
    // The scope check runs BEFORE the write — the store was never called.
    expect(updateItemCalls.length).toBe(0);
    // Byte-identical to the answer for a genuinely absent id, so the surface is
    // not an oracle for what other projects hold.
    const missing = await toolHandler(makeServer(), "update_item")({ itemId: "i-nope", title: "x" });
    expect(textOf(missing).replace("i-nope", "i-o1")).toBe(textOf(res));
  });

  test("an empty patch is refused with a sentence naming what may be changed", async () => {
    const res = await toolHandler(makeServer(), "update_item")({ itemId: "i-a1" });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("title, laneKey, desk, unplaced or mirrored");
    expect(updateItemCalls.length).toBe(0);
  });

  test("desk:false drains to the queue — the item is still there afterwards", async () => {
    const out = jsonOf(await toolHandler(makeServer(), "update_item")({ itemId: "i-a1", desk: false }));
    expect(out.id).toBe("i-a1");
    expect(out.desk).toBeUndefined(); // off the desk…
    expect(out.rank).toBe(1); // …and still in its lane. There is no delete.
  });

  test("a store-level throw becomes an actionable errResult carrying the diagnosis", async () => {
    updateItemThrows = "AC9/NFR-OW-19: updateItem cannot write `raw`";
    const res = await toolHandler(makeServer(), "update_item")({ itemId: "i-a1", title: "x" });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("Could not update");
    expect(textOf(res)).toContain("AC9");
  });
});

// ── the vacuity guard (T2) ─────────────────────────────────────────────────

describe("the harness itself", () => {
  test("VACUITY GUARD — the @telar/core stub really is installed, so every test above ran against it", async () => {
    // If the mock ever failed to install, every assertion above would run
    // against the REAL store under whatever TELAR_HOME this process inherited —
    // green, and reaching the operator's state root. This is the failure T2
    // warns about, made loud.
    //
    // Observed through the SERVER rather than by calling a reader off the module
    // namespace: the double counts its own calls, so a real store would leave
    // this counter at zero. (A namespace call here would also read to INV-7's
    // scanner as an un-sandboxed reader, which is a fair reading it cannot
    // distinguish from a genuine one.)
    const before = readLanesCalls;
    const out = jsonOf(await toolHandler(makeServer(), "list_lanes")());
    expect(readLanesCalls).toBe(before + 1);
    expect(out.map((l: { key: string }) => l.key)).toEqual(["aurora", "unfiled"]);

    // …and the module really was swapped, so this is a check and not a tautology.
    // A property READ, never a call — the identity is the whole assertion.
    const core = await import("@telar/core");
    expect(core.readLanes).toBe(stubReadLanes);
    expect(realCoreSnapshot.readLanes).not.toBe(core.readLanes);
  });
});
