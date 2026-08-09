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
// AND THE CLAIM IS ONLY TRUE OF THE KEYS THE FACTORY ACTUALLY DEFINES. bun's
// mock.module MERGES: an export the factory omits keeps the REAL module's
// binding (measured — under a factory returning `{ listItems }` alone,
// `typeof (await import("@telar/core")).getLoom` is still "function"). So the
// failure mode of forgetting a reader is not a TypeError, it is a silent read of
// the operator's state root, and story 5.5's `staleTracking` shipped through
// this file that way for exactly one review cycle. Anything the code under test
// can reach belongs in the factory, and VACUITY GUARD 2 at the end of the file
// pins the loom pair by identity so the next omission is loud.
//
// THE SOURCE-TEXT ARMS ARE NOT HERE ON PURPOSE. "no z.object( in this file" and
// "no rmSync in any handler" are claims about SOURCE TEXT, which is
// invariants.test.ts's native idiom (INV-11 arms 4 and 5) and not this file's.
// Splitting them that way also keeps them tree-wide: a scan scoped to the file
// it is defending is vacuous the moment someone adds a second file.
//
// T2 — THIS IS THE FOURTH PROCESS-GLOBAL mock.module("@telar/core", …) IN
// apps/web, and the snapshot-and-restore ritual below does NOT contain the leak.
// THE MECHANISM, CORRECTED IN THE REVIEW-FIX ROUND — the first version of this
// note said "afterAll never fires", which is false: bun evaluates each file's
// module scope and DOES run this file's afterAll whenever the file has a test
// that matches. The real hole is narrower and still real: under a filtered run
// (`bun test -t "…"`) that matches NOTHING here, this module scope is still
// evaluated — so the mock is installed process-wide — and with no matching test
// in the file there is nothing for afterAll to hang off. A sibling file that
// imports @telar/core then gets the double.
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
// Story 5.5: the attachment names every packet reports (one list for the whole
// fake store — the receipt's context segment counts them, it does not care
// which packet they hang off), plus the handoff's recorded side effects.
let attachments: string[] = [];
// The looms this process can SEE. lib/workspace-handoff.ts's `staleTracking`
// reads exactly this (getLoom + isTerminalWorkUnitState) to tell a LIVE
// tracking ref from a dead one, and an id that is absent here is a loom deleted
// from the god-view.
//
// IT MUST BE STUBBED, AND THE REASON IS A PROPERTY OF bun's mock.module THAT
// THIS FILE'S HEADER GOT WRONG: a key the factory does NOT define falls through
// to the REAL module rather than becoming undefined (measured — `typeof
// (await import("@telar/core")).getLoom` is "function" under a factory that
// returns `{ listItems }` alone). So an un-stubbed reader is not a loud
// TypeError, it is a silent read of whatever state root this process inherited
// — the exact failure the "THIS SUITE REACHES NO STATE ROOT" claim above
// forbids, and the reason the already-tracked test below used to fail: the real
// getLoom found no "loom-earlier" under the operator's ~/.telar, so the ref read
// as DEAD and the weave was allowed. Every reader the code under test can reach
// belongs in this factory; the vacuity guard at the end of the file now pins the
// loom pair by identity for that reason.
let looms: Record<string, { id: string; state: string; project: string; draft?: boolean }> = {};
const draftLoomCalls: Record<string, unknown>[] = [];
const bundleWrites: Array<{ id: string; relPath: string; contents: string }> = [];
let createDraftLoomThrows: string | null = null;
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
  // A LANE CHANGE IS A TWO-FILE MOVE IN THE REAL STORE, so the double performs
  // one too: it rewrites the packet's hint AND moves the id between STACKS. A
  // double that only touched the item would let this suite prove the server
  // correct against a store that silently no-ops — which is precisely the defect
  // the real store shipped with. The three branches below mirror the real
  // `updateItem` clause for clause: unknown key → stay put + unplaced; known key
  // → move and CLEAR unplaced; already in the target → keep position, drop
  // duplicates elsewhere. HARNESS FIDELITY is asserted by its own test below.
  if (patch.lane !== undefined) {
    const target = lanes.find((l) => l.key === patch.lane);
    if (!target) {
      // UNRESOLVABLE: the real store does NOT move the item and does NOT
      // redirect it into the seed lane — that would evict a filed item on a
      // model's typo. It stays put, re-pins its hint to the stack that holds it,
      // and is marked for the user.
      item.lane = lanes.find((l) => l.items.includes(id))?.key ?? item.lane;
      item.unplaced = true;
    } else {
      item.lane = target.key;
      // A successful move CLEARS unplaced unless the caller named it.
      item.unplaced = (patch.unplaced as boolean | undefined) ?? false;
      if (!target.items.includes(id)) {
        for (const l of lanes) l.items = l.items.filter((x) => x !== id);
        target.items.push(id);
      } else {
        // Already in the target: keep its position, drop stray duplicates.
        for (const l of lanes) if (l !== target) l.items = l.items.filter((x) => x !== id);
      }
    }
  }
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
  readPacketAttachments: () => attachments,
  attachmentTally: (names: string[]) => ({ files: names.length, mockups: 0 }),
  // ── story 5.5's handoff half ────────────────────────────────────────────
  // weave_batch calls lib/workspace-handoff, which calls THESE. They are
  // stubbed here for the same reason the store is: this suite proves the
  // SERVER's behaviour (scope, refusals, what the model is told), and the
  // handoff's own behaviour is lib/workspace-handoff.test.ts's.
  //
  // trackLoom is the one that matters most as a double: the real one writes
  // ONLY packets and never lanes.yaml, so this one mutates the fake item and
  // leaves `lanes` alone. A double that dropped the id from its stack would
  // let this suite prove "the rows stay in the queue" against a store that
  // removes them.
  // READS, not writes — the handoff may LOOK at a loom (to tell a dead tracking
  // ref from a live one) and may never write one. See `looms` above for why an
  // omission here would not be caught by anything.
  getLoom: (id: string) => looms[id] ?? null,
  isTerminalWorkUnitState: (s: string) =>
    s === "done" || s === "halted" || s === "failed" || s === "skipped",
  createDraftLoom: (input: Record<string, unknown>) => {
    draftLoomCalls.push(input);
    if (createDraftLoomThrows) throw new Error(createDraftLoomThrows);
    return { id: "loom-w1", draft: true, state: "queued" };
  },
  writeBundleFile: (id: string, relPath: string, contents: string) => {
    bundleWrites.push({ id, relPath, contents });
  },
  updateDraftObjectiveFromBundle: () => {},
  // NO `packetAttachmentDir` DOUBLE, because there is no such export any more:
  // the handoff NAMES a packet's attachments rather than pointing a loom at a
  // directory INV-11b puts outside its working root (store.ts keeps the
  // tombstone comment where the export used to be). A double for a deleted
  // export is a stub that can never be exercised and reads as if the seam were
  // still there.
  trackLoom: (
    ids: string[],
    ref: Record<string, unknown>,
    opts?: { replacing?: readonly string[] },
  ) => {
    const replacing = new Set(opts?.replacing ?? []);
    const tracked: FakeItem[] = [];
    const missing: string[] = [];
    const alreadyTracking: Array<{ id: string; loomId: string }> = [];
    for (const id of ids) {
      const item = items.find((i) => i.id === id);
      if (!item) {
        missing.push(id);
        continue;
      }
      // HARNESS FIDELITY, same rule as stubUpdateItem's forbidden-key throw: the
      // real trackLoom REFUSES to re-point an item that already tracks another
      // loom unless the caller named it in `replacing`. A double that overwrote
      // unconditionally would let this suite prove the weave safe against a
      // store that silently orphans the first loom's membership.
      const existing = (item.tracking as { loomId?: string } | undefined)?.loomId;
      if (existing && existing !== ref.loomId && !replacing.has(id)) {
        alreadyTracking.push({ id, loomId: existing });
        continue;
      }
      item.tracking = ref;
      tracked.push(item);
    }
    return { tracked, missing, alreadyTracking };
  },
}));

afterAll(() => {
  mock.module("@telar/core", () => realCoreSnapshot);
});

const { createWorkspaceMcpServer, WORKSPACE_AUTO_TOOLS, WORKSPACE_WEAVE_TOOL } = await import(
  "./workspace-mcp"
);

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
  attachments = [];
  // One LIVE loom the fixtures can point a tracking ref at. "loom-earlier" is
  // still weaving, so a row that tracks it is not re-weavable; the tests that
  // want the other answer delete it or settle it into a terminal state.
  looms = { "loom-earlier": { id: "loom-earlier", state: "running", project: "aurora" } };
  createItemCalls.length = 0;
  updateItemCalls.length = 0;
  draftLoomCalls.length = 0;
  bundleWrites.length = 0;
  createItemThrows = null;
  updateItemThrows = null;
  createDraftLoomThrows = null;
});

// ── AC6 proof 4 — registration ──────────────────────────────────────────────

describe("workspace MCP server — tool registration", () => {
  test("registers the four AUTO tools plus the one APPROVAL-GATED tool, IN ORDER", () => {
    // The ultra-style registry test. The loom side has no equivalent; that is
    // the hole this deliberately does not reproduce.
    expect([...WORKSPACE_AUTO_TOOLS]).toEqual([
      "mcp__workspace__list_items",
      "mcp__workspace__list_lanes",
      "mcp__workspace__create_item",
      "mcp__workspace__update_item",
    ]);
    const names = Object.keys(registry(makeServer()));
    // STORY 5.5 ADDED THE FIFTH, LAST, and it is NOT in WORKSPACE_AUTO_TOOLS:
    // weave_batch is approval-gated (CAP-11), so the auto list and the
    // registration deliberately differ by exactly that one name. Both facts are
    // asserted, because "the lists differ" is only safe when the difference is
    // pinned.
    expect(names).toEqual(["list_items", "list_lanes", "create_item", "update_item", "weave_batch"]);
    expect([...WORKSPACE_AUTO_TOOLS]).not.toContain(WORKSPACE_WEAVE_TOOL);
    expect(WORKSPACE_WEAVE_TOOL).toBe("mcp__workspace__weave_batch");
    // The constant and the registration say the same thing in the same order —
    // MCP_INVENTORY compares tool lists as ORDERED lists, so a reorder here
    // would drift from invariants.test.ts with a message about ordering.
    expect(names.filter((n) => `mcp__workspace__${n}` !== WORKSPACE_WEAVE_TOOL).map((n) => `mcp__workspace__${n}`)).toEqual([
      ...WORKSPACE_AUTO_TOOLS,
    ]);
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
    // Story 5.5. `itemIds` is the selection, `reason` is the master's one-line
    // rationale and `title` names the loom — no `by`, no `account`, no
    // `project`: the weave takes its project from the ITEMS and its scope from
    // the server's own options, exactly like every tool above it.
    expect(new Set(inputSchemaKeys(s, "weave_batch"))).toEqual(
      new Set(["itemIds", "reason", "title"]),
    );

    // ANTI-VACUITY FIRST: the scan really found the five real tools, so the
    // absences below are statements about a surface rather than about {}.
    const all = Object.keys(registry(s));
    expect(all.length).toBe(5);

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
    // A COUNT under a project scope, because the reason text names ids and lane
    // keys from EVERY project: an unreadable packet has no readable `project`
    // field by construction, so the array cannot be filtered, and passing it
    // through made this the one channel on the surface that leaked across the
    // scope boundary the rest of the file enforces.
    unreadable = [{ id: "i-bad", reason: 'listed in lane "office" but has no readable packet' }];
    const out = jsonOf(await toolHandler(makeServer(), "list_items")());
    expect(out.items.length).toBe(1);
    expect(out.unreadable).toBe(1);
    expect(textOf(await toolHandler(makeServer(), "list_items")())).not.toContain("i-bad");
    expect(textOf(await toolHandler(makeServer(), "list_items")())).not.toContain("office");

    // …the FULL diagnosis only for the project-less master (5.3's), which is the
    // one caller already entitled to see every project.
    const master = jsonOf(await toolHandler(makeServer({ project: undefined }), "list_items")());
    expect(master.unreadable).toEqual(unreadable);

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
    // THE SECOND TERM OF THE SAME EXPRESSION, and the precise claim is that the
    // two tests pin the two TERMS — not that both fail under one reversion.
    // `lanes.find(…)?.key ?? item.lane ?? null` dies twice, differently:
    //   - drop `lanes.find(…)?.key` (report the hint) → the test ABOVE fails,
    //     this one passes, because for an item in no stack the authoritative
    //     lookup returns undefined and both implementations agree by
    //     construction. Nothing can discriminate that path, and a test claiming
    //     to would be the claim, not the proof.
    //   - drop `?? item.lane` (report only the stack) → THIS one fails and the
    //     one above passes.
    // Each term therefore has exactly one arm that can kill it.
    lanes = [{ key: "free", label: "Free", window: "whenever", items: [] }];
    const out = jsonOf(await toolHandler(makeServer(), "list_items")());
    expect(out.items[0]!.lane).toBe("aurora"); // the hint, since no stack holds it
    expect(out.items[0]!.rank).toBeNull(); // unfiled — a resting state, not an error

    // …and the THIRD term: an item whose packet names no lane either reports
    // null rather than inventing one.
    items = [{ id: "i-a1", title: "hintless", project: "aurora", provenance: "note", captured: "Tue 16:42", schemaVersion: 1 }];
    expect(jsonOf(await toolHandler(makeServer(), "list_items")()).items[0]!.lane).toBeNull();
  });

  test("summarise's OUTPUT SHAPE is pinned — the ripening history is not spent on every list call", async () => {
    // The function's own contract is that `raw`, `fixed`, `acceptance` and
    // `timeline` are deliberately NOT sent: they are what a packet view renders,
    // not context every list call should pay tokens for. Nothing asserted it, so
    // adding `raw` and `timeline` to the model-facing payload left the whole
    // apps/web suite green — against the stated contract.
    items = [
      {
        id: "i-a1",
        title: "Everything at once",
        project: "aurora",
        lane: "aurora",
        provenance: "note",
        captured: "Tue 16:42",
        schemaVersion: 1,
        desk: true,
        unplaced: true,
        mirrored: "#214",
        deadline: { label: "Fri", kind: "self" },
        verdict: "loom",
        subtasks: [{ id: "st-1", title: "one" }],
        // Present on the item, and NONE of these may appear in the payload.
        raw: "the user's own words",
        rawSource: "Telar Note · Tue 16:42",
        fixed: "the expert's brief",
        acceptance: ["it works"],
        timeline: [{ at: "Tue 16:42", actor: "session", text: "captured" }],
        promotedFrom: "i-parent",
        tracking: { loomId: "l-1" },
      },
    ];
    const out = jsonOf(await toolHandler(makeServer(), "list_items")());
    expect(Object.keys(out.items[0]!).sort()).toEqual(
      ["deadline", "desk", "id", "lane", "mirrored", "project", "rank", "subtasks", "title", "unplaced", "verdict"].sort(),
    );
    // The sub-task channel is a COUNT, not the sub-tasks themselves (NFR-OW-3).
    expect(out.items[0]!.subtasks).toBe(1);
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

  test("a lane move is REPORTED from the moved stacks — the new lane and the new rank", async () => {
    // The surface's half of the store's two-file move. Reading lanes BEFORE the
    // write would report the rank the item held in the lane it just left.
    lanes = [
      { key: "aurora", label: "Aurora", window: "work hours", items: ["i-a1"] },
      { key: "unfiled", label: "Unfiled", window: "whenever", items: ["i-x", "i-y"] },
    ];
    const out = jsonOf(await toolHandler(makeServer(), "update_item")({ itemId: "i-a1", laneKey: "unfiled" }));
    expect(out.lane).toBe("unfiled");
    expect(out.rank).toBe(3); // appended at the tail, below what was already there
    expect(out.note).toBeUndefined(); // a lane that exists gets no note
    expect(lanes.find((l) => l.key === "aurora")!.items).toEqual([]);
  });

  test("a laneKey naming NO existing lane says so, and the item does NOT move", async () => {
    // This surface accepted an unknown laneKey, returned isError:false and said
    // nothing at all, so a model was told a move succeeded that had not
    // happened. create_item has always said it; update_item did not. And the
    // item stays where it is: an update has a home, so a typo must not evict it.
    const out = jsonOf(
      await toolHandler(makeServer(), "update_item")({ itemId: "i-a1", laneKey: "a-lane-nobody-made" }),
    );
    expect(out.lane).toBe("aurora"); // still where it was
    expect(out.rank).toBe(1); // …at the rank it held
    expect(out.unplaced).toBe(true); // …and the user is asked
    expect(out.note).toContain('No lane named "a-lane-nobody-made" exists');
    expect(out.note).toContain("did NOT move");
    expect(out.note).not.toContain('landed in "unfiled"'); // create's sentence, not update's
    expect(out.note).toContain("Lanes are theirs to create");
    expect(lanes.find((l) => l.key === "aurora")!.items).toEqual(["i-a1"]);
  });

  test("a store-level throw becomes an actionable errResult carrying the diagnosis", async () => {
    updateItemThrows = "AC9/NFR-OW-19: updateItem cannot write `raw`";
    const res = await toolHandler(makeServer(), "update_item")({ itemId: "i-a1", title: "x" });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("Could not update");
    expect(textOf(res)).toContain("AC9");
  });
});

// ── story 5.5 / CAP-11 — weave_batch, the one approval-gated tool ──────────
//
// The GATE itself is not provable from here: "hard-routed to the interactive
// card in every permission mode" is a claim about lib/server/turn-hooks.ts and
// the chat route, and invariants.test.ts's INV-11g holds it. What IS this
// file's is everything the tool does once a human has approved it — scope, the
// refusals, and the words the model reads back.

describe("CAP-11 weave_batch — the batch handoff", () => {
  const aurora2: FakeItem = {
    id: "i-a2",
    title: "Exports: PDF",
    project: "aurora",
    lane: "aurora",
    provenance: "note",
    captured: "Wed 10:10",
    schemaVersion: 1,
    fixed: "Ship the PDF export behind the same toggle as CSV.",
    acceptance: ["a PDF lands in downloads", "the toggle hides it"],
  };

  test("weaves the selection into ONE draft loom, hands over premise + context, and leaves every row in its lane", async () => {
    items.push(aurora2);
    lanes.find((l) => l.key === "aurora")!.items.push("i-a2");
    attachments = ["notes.md", "flow.png"];

    const out = jsonOf(
      await toolHandler(makeServer(), "weave_batch")({
        itemIds: ["i-a1", "i-a2"],
        reason: "both touch aurora's exports module",
      }),
    );

    // ONE loom for the whole batch — item-model.md's "one loom carries the
    // whole batch", not one per row.
    expect(draftLoomCalls.length).toBe(1);
    expect(draftLoomCalls[0]!.project).toBe("aurora");
    expect(out.loomId).toBe("loom-w1");
    expect(out.url).toBe("/looms/loom-w1");
    // A DRAFT. This tool never starts a loom — the commit that spends is the
    // loom side's, behind its own human click (§M.6).
    expect(out.draft).toBe(true);

    // The premise is the packets' own words: `fixed` + `acceptance`, nothing
    // re-authored (item-model.md).
    const objective = bundleWrites.find((w) => w.relPath === "objective.md")!;
    expect(objective.id).toBe("loom-w1");
    expect(objective.contents).toContain("Ship the PDF export behind the same toggle as CSV.");
    expect(objective.contents).toContain("a PDF lands in downloads");
    expect(objective.contents).toContain("both touch aurora's exports module");
    const context = bundleWrites.find((w) => w.relPath === "context.md")!;
    expect(context.contents).toContain("notes.md");
    expect(context.contents).toContain("flow.png");

    // THE ROWS STAY. Both are marked as tracking the loom and neither leaves
    // its stack — CAP-11's "leave only when it lands AND the human accepts".
    expect(out.tracking).toEqual(["i-a1", "i-a2"]);
    expect(items.find((i) => i.id === "i-a1")!.tracking).toEqual({ loomId: "loom-w1", label: expect.any(String) });
    expect(lanes.find((l) => l.key === "aurora")!.items).toEqual(["i-a1", "i-a2"]);

    // THE UNIVERSAL RECEIPT, in the model's own result: same grammar as the
    // line the queue and a birth session render.
    expect(out.receipt).toStartWith("loom created — loom-w1 · premise = ");
    expect(out.receipt).toEndWith("detached from the workspace");
    expect(out.receipt).toContain("context = 4 attachments"); // 2 items × the fake store's 2
    expect(out.note).toContain("leave when it lands and you accept");
  });

  test("an out-of-scope id is refused with the SAME sentence a nonexistent id gets, and nothing is created", async () => {
    // update_item's anti-oracle rule, applied to the verb that would otherwise
    // let a project session learn which ids another project holds.
    const foreign = await toolHandler(makeServer(), "weave_batch")({ itemIds: ["i-a1", "i-o1"] });
    const unknown = await toolHandler(makeServer(), "weave_batch")({ itemIds: ["i-a1", "i-nope"] });
    expect(isError(foreign)).toBe(true);
    expect(textOf(foreign)).toBe('No workspace item found with id "i-o1".');
    expect(textOf(unknown)).toBe('No workspace item found with id "i-nope".');
    // SCOPE IS CHECKED BEFORE THE WEAVE: no loom, no bundle, no stamp.
    expect(draftLoomCalls).toEqual([]);
    expect(bundleWrites).toEqual([]);
    expect(items.find((i) => i.id === "i-a1")!.tracking).toBeUndefined();
  });

  test("a floating item is refused with the alternative named — a session, not a failure", async () => {
    // An unscoped server (5.3's project-less master) can SEE the floating item,
    // which is what makes this refusal about the weave rather than about scope.
    const res = await toolHandler(makeServer({ project: undefined }), "weave_batch")({
      itemIds: ["i-f1"],
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("floating");
    expect(textOf(res)).toContain("start a session instead");
    expect(draftLoomCalls).toEqual([]);
  });

  test("a selection spanning two projects is refused — one loom weaves in one project", async () => {
    const res = await toolHandler(makeServer({ project: undefined }), "weave_batch")({
      itemIds: ["i-a1", "i-o1"],
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("spans 2 projects");
    expect(draftLoomCalls).toEqual([]);
  });

  test("an item tracking a LIVE loom is REFUSED, never re-woven — it leaves when that loom lands", async () => {
    // `looms` holds "loom-earlier" as running (see beforeEach), so the ref is
    // live and the refusal is about the FIRST loom still weaving on a premise
    // built from this packet — not about the mark itself.
    items.find((i) => i.id === "i-a1")!.tracking = { loomId: "loom-earlier" };
    const res = await toolHandler(makeServer(), "weave_batch")({ itemIds: ["i-a1"] });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("loom-earlier");
    expect(textOf(res)).toContain("lands and you accept");
    expect(draftLoomCalls).toEqual([]);
    // …and the original stamp is untouched.
    expect(items.find((i) => i.id === "i-a1")!.tracking).toEqual({ loomId: "loom-earlier" });
  });

  test("a ref to a CANCELLED loom is re-weavable — the mark is not a life sentence", async () => {
    // THE OTHER HALF OF THE SAME RULE, and the reason the refusal above is
    // survivable. A loom the human halted can never land and can never be
    // accepted, so its members could never leave the queue and — under a blanket
    // refusal — could never be woven again either. The handoff names those ids in
    // trackLoom's `replacing`, which is the ONLY lift of the re-point refusal;
    // the double above enforces that, so this proves the list really was passed.
    looms["loom-earlier"] = { id: "loom-earlier", state: "halted", project: "aurora" };
    items.find((i) => i.id === "i-a1")!.tracking = { loomId: "loom-earlier" };
    const res = await toolHandler(makeServer(), "weave_batch")({ itemIds: ["i-a1"] });
    expect(isError(res)).toBe(false);
    expect(jsonOf(res).tracking).toEqual(["i-a1"]);
    expect(items.find((i) => i.id === "i-a1")!.tracking).toMatchObject({ loomId: "loom-w1" });
  });

  test("a ref to a loom that no longer EXISTS is re-weavable too — a dangling id is a tombstone", async () => {
    // AD-8's weak reference, dangling: the loom was deleted from the god-view.
    // Deleting it from `looms` is exactly what getLoom returning null means, and
    // the row must not be stranded by someone else's cleanup.
    delete looms["loom-earlier"];
    items.find((i) => i.id === "i-a1")!.tracking = { loomId: "loom-earlier" };
    const res = await toolHandler(makeServer(), "weave_batch")({ itemIds: ["i-a1"] });
    expect(isError(res)).toBe(false);
    expect(items.find((i) => i.id === "i-a1")!.tracking).toMatchObject({ loomId: "loom-w1" });
  });

  test("a ref to a loom that LANDED is still refused — `done` is not dead, it is waiting on you", async () => {
    // The discrimination that makes the two tests above safe: `done` is terminal
    // and is deliberately NOT stale. That loom landed; CAP-11 says the row leaves
    // when the human accepts it, so re-weaving would erase the thing they are
    // being asked to accept.
    looms["loom-earlier"] = { id: "loom-earlier", state: "done", project: "aurora" };
    items.find((i) => i.id === "i-a1")!.tracking = { loomId: "loom-earlier" };
    const res = await toolHandler(makeServer(), "weave_batch")({ itemIds: ["i-a1"] });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("lands and you accept");
    expect(draftLoomCalls).toEqual([]);
    expect(items.find((i) => i.id === "i-a1")!.tracking).toEqual({ loomId: "loom-earlier" });
  });


  test("a failure inside the handoff becomes an actionable errResult and stamps nothing", async () => {
    createDraftLoomThrows = 'Unknown project "aurora" — not in the registry.';
    const res = await toolHandler(makeServer(), "weave_batch")({ itemIds: ["i-a1"] });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("not in the registry");
    expect(items.find((i) => i.id === "i-a1")!.tracking).toBeUndefined();
  });

  test("the tool's own description tells the model it is a PROPOSAL and that nothing is accepted", async () => {
    // The description is the only place the model learns the shape of the gate.
    const t = registry(makeServer())["weave_batch"] as { description?: string };
    const description = t.description ?? "";
    expect(description).toContain("PROPOSE");
    expect(description).toContain("approve");
    expect(description).toContain("DRAFT");
    expect(description).toContain("STAY");
    // The equal-weight alternative CAP-11 requires on both handoffs.
    expect(description).toContain("session instead");
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

  test("VACUITY GUARD 2 — the LOOM readers are doubled too, because an omission here falls through to the real store", async () => {
    // MEASURED, NOT ASSUMED: bun's mock.module MERGES. A key the factory does not
    // define keeps the real module's export, so an un-stubbed reader is a silent
    // read of the operator's state root rather than a loud TypeError. That is how
    // `staleTracking`'s getLoom escaped this suite's "reaches no state root"
    // claim and, finding no "loom-earlier" under the real ~/.telar, read a LIVE
    // tracking ref as dead and let a re-weave through.
    //
    // Identity, never a call — same rule as the guard above. Both halves of the
    // pair are pinned: isTerminalWorkUnitState is pure, but a real one beside a
    // stubbed getLoom would still be a state-shaped coupling this suite cannot
    // see.
    const core = await import("@telar/core");
    for (const name of ["getLoom", "isTerminalWorkUnitState"] as const) {
      expect(typeof realCoreSnapshot[name]).toBe("function");
      expect(core[name]).not.toBe(realCoreSnapshot[name]);
    }
  });
});
