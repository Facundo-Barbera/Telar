/**
 * The `spool` toolkit — what it does, and much more importantly what it cannot.
 *
 * MOST OF THIS FILE ASSERTS AN ABSENCE, because the toolkit's contract is mostly
 * absences and a comment claiming a negative is worth nothing. A tool that
 * accepted work, deleted an item, promoted a sub-task or spelled a verdict would
 * each be one line to add and invisible to every other test in the repo.
 */
import { describe, expect, test } from "bun:test";
import { assertTelarToolNames, parseToolName, qualifyTelarTool, type SpoolItem, type SpoolSnapshot } from "@telar/engine-client";
import { spoolTools, type SpoolCapability } from "../src/spool/tools";

type Registered = {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
};

function build(capability: Partial<SpoolCapability> & { project?: string } = {}) {
  const registered: Registered[] = [];
  const factory = (
    name: string,
    description: string,
    shape: Record<string, unknown>,
    run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>,
  ) => {
    registered.push({ name, description, shape, run });
    return { name };
  };
  const full: SpoolCapability = {
    ...(capability.project ? { project: capability.project } : {}),
    snapshot: capability.snapshot ?? (async () => emptySnapshot()),
    item: capability.item ?? (async () => null),
    create: capability.create ?? (async () => item({ id: "i-new", title: "new" })),
    update: capability.update ?? (async () => item({ id: "i-1", title: "updated" })),
    consult: capability.consult ?? (async () => ({ ok: false as const, reason: "no expert in this fixture" })),
    map: capability.map ?? (async () => ({ subjects: [], floating: [] })),
    openThread: capability.openThread ?? (async () => thread({ id: "t-1" })),
    setWaiting: capability.setWaiting ?? (async () => thread({ id: "t-1" })),
    settle: capability.settle ?? (async () => thread({ id: "t-1", settled: { at: "Tue", answer: "answered" } })),
    answer: capability.answer ?? (async () => item({ id: "i-1", title: "answered" })),
    focus: capability.focus ?? (async () => ({ pickup: { current: [], moved: [], waiting: [] }, days: [] })),
    setFocus:
      capability.setFocus ??
      (async (input) => ({ id: "f-1", subject: input.subject, label: "Tue", day: "Tuesday", at: 0, schemaVersion: 1 })),
    endFocus:
      capability.endFocus ??
      (async () => ({ id: "f-1", subject: "aurora", label: "Tue", day: "Tuesday", at: 0, schemaVersion: 1 })),
    look: capability.look ?? (async (subjectKey) => ({ subject: subjectKey, fresh: false, note: "no terrain in this fixture" })),
    setTerrain:
      capability.setTerrain ??
      (async (subjectKey, terrain) => ({
        key: subjectKey,
        name: subjectKey,
        permits: "draft" as const,
        ...(terrain ? { terrain } : {}),
        created: "Tue",
        schemaVersion: 1,
      })),
    setIdentity:
      capability.setIdentity ??
      (async (subjectKey, patch) => ({
        key: subjectKey,
        name: subjectKey,
        permits: "draft" as const,
        ...(patch.area ? { area: patch.area } : {}),
        ...(patch.color ? { color: patch.color } : {}),
        created: "Tue",
        schemaVersion: 1,
      })),
    setAperture: capability.setAperture ?? (async (view) => ({ view, schemaVersion: 1 })),
    setAreaPermits:
      capability.setAreaPermits ??
      (async (name, ceiling) => ({ name, ...(ceiling ? { ceiling } : {}), created: "Tue", schemaVersion: 1 })),
    notes: capability.notes ?? (async () => []),
    createNote:
      capability.createNote ??
      (async (input) => ({
        id: "n-new",
        ...(input.subjectKey ? { subjectKey: input.subjectKey } : {}),
        title: input.title,
        body: input.body,
        tags: input.tags ?? [],
        created: { label: "Tue", at: 0 },
        updated: { label: "Tue", at: 0 },
        author: input.author ?? "session",
        schemaVersion: 1,
      })),
    updateNote:
      capability.updateNote ??
      (async (id, patch) => ({
        id,
        title: patch.title ?? "kept",
        body: patch.body ?? "kept",
        tags: patch.tags ?? [],
        created: { label: "Tue", at: 0 },
        updated: { label: "Tue", at: 1 },
        author: "session" as const,
        schemaVersion: 1,
      })),
    search: capability.search ?? (async () => []),
  };
  spoolTools(factory, full);
  return {
    registered,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const found = registered.find((r) => r.name === name);
      if (!found) throw new Error(`no tool named ${name}`);
      return found.run(args);
    },
    text: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await registered.find((r) => r.name === name)!.run(args);
      return String((result.content[0] as { text: string }).text);
    },
  };
}

const item = (over: Partial<SpoolItem> & { id: string; title: string }): SpoolItem => ({
  provenance: "session",
  captured: "Tue 16:42",
  schemaVersion: 1,
  ...over,
});

const thread = (over: Partial<import("@telar/engine-client").SpoolThread> & { id: string }) => ({
  subject: "aurora",
  question: "Does it work?",
  items: ["i-1"],
  facts: [],
  created: "Tue 16:42",
  schemaVersion: 1,
  ...over,
});

const emptySnapshot = (): SpoolSnapshot => ({
  lanes: [],
  rows: [],
  subjects: [],
  desk: [],
  unreadable: [],
  totalItems: 0,
  agentsAdded: 0,
});

const snapshotOf = (over: Partial<SpoolSnapshot>): SpoolSnapshot => ({ ...emptySnapshot(), ...over });

describe("the registered surface", () => {
  test("twenty-one tools, each declaring its capability in its name", () => {
    const { registered } = build();
    expect(registered.map((r) => r.name)).toEqual([
      "spool_list_items",
      "spool_list_lanes",
      "spool_create_item",
      "spool_update_item",
      "spool_consult_expert",
      "spool_list_threads",
      "spool_open_question",
      "spool_mark_waiting",
      "spool_answer_question",
      "spool_settle_thread",
      "spool_set_focus",
      "spool_end_focus",
      "spool_look",
      "spool_pin",
      "spool_set_aperture",
      "spool_set_area_permits",
      "spool_set_terrain",
      "spool_set_subject_identity",
      "spool_shelf",
      "spool_write_note",
      "spool_search",
    ]);
    // The naming standard the whole protocol assumes: a Telar tool is
    // `mcp__telar__<capability>_<verb>`, so a client can tell one of ours from a
    // user-configured server's.
    expect(() => assertTelarToolNames(registered.map((r) => r.name))).not.toThrow();
    expect(parseToolName(qualifyTelarTool("spool_list_items")).capability).toBe("spool");
  });

  test("NO ACCEPT PATH, NO DELETE, NO PROMOTION, NO LANE STRUCTURE, NO VERDICT", () => {
    const { registered } = build();
    const names = registered.map((r) => r.name).join(" ");
    for (const forbidden of [
      // Nothing here transitions work. Filing is prepare, never commit.
      "accept",
      "complete",
      "done",
      "start",
      "finish",
      // The checkbox is the HUMAN's (docs/spool-loops.md §9): close and reopen
      // exist only on the daemon's dedicated routes, never on this wall.
      "close",
      "reopen",
      // "No deletion path."
      "delete",
      "remove",
      "archive",
      // "Agents have no promotion path, proposed or otherwise."
      "promote",
      // Lane structure is reserved to the human.
      "create_lane",
      "rename_lane",
      "retire_lane",
      "split",
      // Gone with looms, and must not come back as a tool: the verdict's
      // writers are an expert pass and a human's click, and a weave is a
      // handoff, which is a human's decision.
      "verdict",
      "weave",
      "loom",
    ]) {
      expect(names, `a tool named for "${forbidden}" exists`).not.toContain(forbidden);
    }
    // …and no ARGUMENT can spell one either, which is the half a name check
    // would miss: `spool_update_item({verdict})` would be a third writer with no
    // override gate in front of it.
    const shapes = registered.flatMap((r) => Object.keys(r.shape));
    // `closed` is in this list because it EXISTS on the item now — the human's
    // own checkbox — which makes "no input can spell it" the load-bearing half
    // of the amended moat: agent-declared doneness stays impossible.
    for (const forbidden of ["verdict", "status", "state", "done", "accepted", "closed", "promotedFrom", "tracking", "raw", "rawSource", "timeline", "subtasks", "project"]) {
      expect(shapes, `an input named "${forbidden}" exists`).not.toContain(forbidden);
    }
  });

  test("NO PATH-SHAPED INPUT KEY, because a guardrail resolves those against the session root", () => {
    // `path`, `file_path` and `notebook_path` are what a permission layer treats
    // as filesystem input on EVERY tool call. An opaque item id under one of
    // those names would be resolved against a repo and matched against protected
    // paths — meaningless, and it would deny by accident.
    const shapes = build().registered.flatMap((r) => Object.keys(r.shape));
    for (const forbidden of ["path", "file_path", "notebook_path", "lane"]) {
      expect(shapes).not.toContain(forbidden);
    }
    expect(shapes).toContain("laneKey");
    expect(shapes).toContain("itemId");
  });

  test("the read tools take NO arguments at all", () => {
    const { registered } = build();
    expect(registered.find((r) => r.name === "spool_list_items")!.shape).toEqual({});
    expect(registered.find((r) => r.name === "spool_list_lanes")!.shape).toEqual({});
  });
});

describe("scope", () => {
  const aurora = item({ id: "i-a", title: "aurora work", project: "aurora" });
  const other = item({ id: "i-b", title: "someone else's", project: "borealis" });
  const floating = item({ id: "i-c", title: "unplaced fragment" });
  const snapshot = snapshotOf({
    lanes: [{ key: "office", label: "Office", window: "work hours", items: ["i-a", "i-b", "i-c"] }],
    rows: [
      { lane: "office", rank: 1, item: aurora },
      { lane: "office", rank: 2, item: other },
      { lane: "office", rank: 3, item: floating },
    ],
    totalItems: 3,
  });

  test("a project session sees ITS project's items and nothing else — floating included in nothing else", () => {
    // Floating means "not yet placed anywhere". Handing a project session every
    // unplaced fragment in the user's life is the cross-project leak the scope
    // predicate exists to stop.
    const tools = build({ project: "aurora", snapshot: async () => snapshot });
    return tools.text("spool_list_items").then((out) => {
      const parsed = JSON.parse(out);
      expect(parsed.scope).toBe("aurora");
      expect(parsed.items.map((i: { id: string }) => i.id)).toEqual(["i-a"]);
      expect(out).not.toContain("borealis");
      expect(out).not.toContain("unplaced fragment");
    });
  });

  test("the project-less master has no scope and sees every project, floating included", async () => {
    const tools = build({ snapshot: async () => snapshot });
    const parsed = JSON.parse(await tools.text("spool_list_items"));
    expect(parsed.scope).toBe("all projects");
    expect(parsed.items.map((i: { id: string }) => i.id)).toEqual(["i-a", "i-b", "i-c"]);
    // An item with no project renders the word rather than an absent key, so a
    // model cannot read "unfiled" as "the field was dropped".
    expect(parsed.items[2].project).toBe("floating");
  });

  test("a lane's count is what THIS session can see in it, not the stored total", async () => {
    const tools = build({ project: "aurora", snapshot: async () => snapshot });
    const parsed = JSON.parse(await tools.text("spool_list_lanes"));
    expect(parsed.lanes).toEqual([{ key: "office", label: "Office", window: "work hours", items: 1 }]);
  });

  test("an unreadable packet is a COUNT when scoped and a diagnosis when not", async () => {
    // An unreadable packet has no readable `project` by construction, so it
    // cannot be filtered — and its reason text names item ids and lane keys.
    const unreadable = [{ id: "i-broken", reason: "packet.json in lane \"borealis-only\" could not be read" }];
    const scoped = JSON.parse(await build({ project: "aurora", snapshot: async () => snapshotOf({ unreadable }) }).text("spool_list_items"));
    expect(scoped.unreadable).toBe(1);

    const master = JSON.parse(await build({ snapshot: async () => snapshotOf({ unreadable }) }).text("spool_list_items"));
    expect(master.unreadable).toEqual(unreadable);
  });
});

describe("creating", () => {
  test("the project is supplied SERVER-SIDE and cannot be named by the caller", async () => {
    let received: { project?: string; title: string } | null = null;
    const tools = build({
      project: "aurora",
      create: async (input) => {
        received = input;
        return item({ id: "i-new", title: input.title, project: input.project, lane: "unfiled", desk: true });
      },
    });
    // Even asked for another project explicitly, there is no argument to carry
    // it — the shape has no `project` key at all.
    await tools.call("spool_create_item", { title: "ship it", project: "borealis" });
    expect(received!.project).toBe("aurora");
    expect(received!.title).toBe("ship it");
  });

  test("filing says it started nothing", async () => {
    const out = await build({ create: async () => item({ id: "i-new", title: "x", desk: true, lane: "unfiled" }) }).text(
      "spool_create_item",
      { title: "x" },
    );
    expect(out).toContain("Filed, not started");
    expect(JSON.parse(out).onDesk).toBe(true);
  });

  test("an unknown lane files the task anyway, creates NO lane, and says so", async () => {
    const tools = build({
      create: async () => item({ id: "i-new", title: "x", lane: "unfiled", unplaced: true, desk: true }),
      snapshot: async () => snapshotOf({ lanes: [{ key: "unfiled", label: "Unfiled", window: "whenever", items: [] }] }),
    });
    const parsed = JSON.parse(await tools.text("spool_create_item", { title: "x", laneKey: "not-a-lane" }));
    expect(parsed.unplaced).toBe(true);
    expect(parsed.note).toContain('There is no lane "not-a-lane"');
    expect(parsed.note).toContain("lanes are the user's to make");
  });

  test("a refused write is an actionable sentence, not a silent success", async () => {
    const tools = build({
      create: async () => {
        throw new Error("a spool item needs a title");
      },
    });
    const result = await tools.call("spool_create_item", { title: "x" });
    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toContain("needs a title");
  });
});

describe("updating", () => {
  const mine = item({ id: "i-a", title: "mine", project: "aurora" });

  test("an OUT-OF-SCOPE id answers byte-identically to one that does not exist", async () => {
    // Otherwise the surface becomes an oracle for whether another project holds
    // a given id.
    const theirs = item({ id: "i-b", title: "theirs", project: "borealis" });
    let wrote = false;
    const tools = build({
      project: "aurora",
      item: async (id) => (id === "i-b" ? { item: theirs, attachments: [], tally: { files: 0, mockups: 0 } } : null),
      update: async () => {
        wrote = true;
        return theirs;
      },
    });
    const said = async (id: string) => {
      const result = await tools.call("spool_update_item", { itemId: id, title: "clobber" });
      // The id is echoed back, and echoing the caller's OWN argument tells them
      // nothing they did not already know. What must not differ is everything
      // else — so it is normalised out and the rest compared whole.
      return { ...result, content: [{ type: "text", text: String((result.content[0] as { text: string }).text).replaceAll(id, "<id>") }] };
    };
    expect(await said("i-b")).toEqual(await said("i-zzz"));
    expect(String(((await tools.call("spool_update_item", { itemId: "i-b", title: "x" })).content[0] as { text: string }).text)).toContain(
      "No spool item found",
    );
    // AND THE ORDER IS THE GUARANTEE: the scope check ran BEFORE the write, so
    // nothing was written and only the confirmation withheld.
    expect(wrote).toBe(false);
  });

  test("an empty patch is refused rather than reported as a change", async () => {
    const result = await build({ project: "aurora" }).call("spool_update_item", { itemId: "i-a" });
    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toContain("Nothing to change");
  });

  test("a lane that does not exist does NOT move the task, and the model is told", async () => {
    // Without this the surface reported success and said nothing, so a model
    // announced a move that had in fact been refused.
    const tools = build({
      project: "aurora",
      item: async () => ({ item: mine, attachments: [], tally: { files: 0, mockups: 0 } }),
      update: async () => mine,
      snapshot: async () => snapshotOf({ lanes: [{ key: "office", label: "Office", window: "work hours", items: [] }] }),
    });
    const parsed = JSON.parse(await tools.text("spool_update_item", { itemId: "i-a", laneKey: "nope" }));
    expect(parsed.note).toContain('There is no lane "nope"');
    expect(parsed.note).toContain("did not move");
  });

  test("dismissing from the desk drains to the queue and is described as such", async () => {
    const tools = build();
    const dismiss = tools.registered.find((r) => r.name === "spool_update_item")!;
    expect(dismiss.description).toContain("drains the task to the queue");
    expect(dismiss.description).toContain("deletes nothing");
  });

  test("the description tells the model what it may NOT do, not only what it may", async () => {
    const { registered } = build();
    const update = registered.find((r) => r.name === "spool_update_item")!.description;
    expect(update).toContain("cannot rewrite the user's original words");
    expect(update).toContain("cannot promote a sub-task");
    const lanes = registered.find((r) => r.name === "spool_list_lanes")!.description;
    expect(lanes).toContain("only the human applies it");
  });
});

describe("the summary a model reads", () => {
  test("carries the same chips the queue renders, so it is recognisably the same task", async () => {
    const rich = item({
      id: "i-a",
      title: "Rework onboarding",
      project: "aurora",
      mirrored: "#214",
      deadline: { label: "Fri", kind: "self", slips: 2 },
      subtasks: [
        { id: "st-1", title: "one", done: true },
        { id: "st-2", title: "two" },
      ],
      desk: true,
    });
    const tools = build({
      project: "aurora",
      snapshot: async () =>
        snapshotOf({
          lanes: [{ key: "office", label: "Office", window: "work hours", items: ["i-a"] }],
          rows: [{ lane: "office", rank: 3, item: rich }],
        }),
    });
    const [row] = JSON.parse(await tools.text("spool_list_items")).items;
    expect(row).toEqual({
      id: "i-a",
      title: "Rework onboarding",
      lane: "office",
      rank: 3,
      project: "aurora",
      mirrored: "#214",
      provenance: "session",
      captured: "Tue 16:42",
      deadline: { label: "Fri", kind: "self", slips: 2 },
      subtasks: { done: 1, total: 2 },
      onDesk: true,
    });
  });

  test("order is stack position, and nothing in the answer is a clock", async () => {
    const { registered } = build();
    const list = registered.find((r) => r.name === "spool_list_items")!.description;
    expect(list).toContain("Order is stack position");
    expect(list).toContain("no schedule");
  });
});

describe("spool_consult_expert", () => {
  const detail = (over: Partial<SpoolItem> & { id: string; title: string }) => ({
    item: item(over),
    attachments: [],
    tally: { files: 0, mockups: 0 },
  });

  const passed = {
    ok: true as const,
    project: "aurora",
    applied: {
      item: item({ id: "i-a", title: "Rework onboarding", project: "aurora", fixed: "A brief.", acceptance: ["one"] }),
      events: 2,
      commitments: 1,
      at: "Tue 16:50",
    },
    digest: { project: "aurora", schemaVersion: 1, updated: "Tue 16:50", summary: "", methodology: "", glossary: [], notes: [] },
    cold: true,
  };

  test("it takes an item id and nothing that could steer the pass", () => {
    // No prompt, no model, no instruction key. A caller-supplied instruction
    // would make the expert a generic agent wearing its name — the thing CAP-9
    // exists instead of.
    const { registered } = build();
    const shape = registered.find((r) => r.name === "spool_consult_expert")!.shape;
    expect(Object.keys(shape)).toEqual(["itemId"]);
  });

  test("its description says it costs money and must not be looped", async () => {
    // The one verb on this surface that spends. A model that does not know that
    // will retry it like a read.
    const { registered } = build();
    const description = registered.find((r) => r.name === "spool_consult_expert")!.description;
    expect(description).toContain("SPENDS MONEY");
    expect(description).toContain("do not loop it");
    expect(description).toContain("appends its notes a second time");
  });

  test("an out-of-scope item answers EXACTLY as a missing one does", async () => {
    // The anti-oracle rule, and it matters more here than on update: an
    // unchecked id would let a session bill the user for reading a stranger's
    // item. The two answers differ only by the id the caller passed.
    const mine = build({ project: "aurora", item: async () => null });
    const theirs = build({
      project: "aurora",
      item: async () => detail({ id: "i-b", title: "someone else's", project: "borealis" }),
    });

    expect(await mine.text("spool_consult_expert", { itemId: "i-b" })).toBe(
      await theirs.text("spool_consult_expert", { itemId: "i-b" }),
    );
  });

  test("an out-of-scope id never reaches the expert, so it cannot be billed", async () => {
    let called = false;
    const tools = build({
      project: "aurora",
      item: async () => detail({ id: "i-b", title: "theirs", project: "borealis" }),
      consult: async () => {
        called = true;
        return passed;
      },
    });
    await tools.call("spool_consult_expert", { itemId: "i-b" });

    expect(called).toBe(false);
  });

  test("a refusal comes back as an error carrying the store's own sentence", async () => {
    // Each refusal names the next move, which is something a model can relay or
    // act on — unlike a generic failure, which it would most likely retry.
    const tools = build({
      item: async () => detail({ id: "i-a", title: "a loose thought" }),
      consult: async () => ({ ok: false as const, reason: '"a loose thought" is floating — file it into a project first.' }),
    });
    const result = await tools.call("spool_consult_expert", { itemId: "i-a" });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toContain("floating");
  });

  test("a good pass reports what the expert produced and nothing it could not do", async () => {
    const tools = build({
      project: "aurora",
      item: async () => detail({ id: "i-a", title: "Rework onboarding", project: "aurora" }),
      consult: async () => passed,
    });
    const answer = JSON.parse(await tools.text("spool_consult_expert", { itemId: "i-a" }));

    expect(answer.fixed).toBe("A brief.");
    expect(answer.acceptance).toEqual(["one"]);
    expect(answer.minedCommitments).toBe(1);
    // NO STATUS, NO LANE, NO VERDICT, NO PROMOTION. The pass cannot produce one,
    // and the answer must not imply otherwise.
    for (const forbidden of ["status", "state", "lane", "verdict", "accepted", "done", "promoted"]) {
      expect(answer).not.toHaveProperty(forbidden);
    }
  });

  test("a first pass says so, rather than implying memory it did not have", async () => {
    const tools = build({
      project: "aurora",
      item: async () => detail({ id: "i-a", title: "x", project: "aurora" }),
      consult: async () => passed,
    });
    const answer = JSON.parse(await tools.text("spool_consult_expert", { itemId: "i-a" }));

    expect(answer.firstPass).toBe(true);
    expect(answer.note).toContain("First pass");
  });

  test("a pass with no checkout says it never read the project", async () => {
    // `cold` is about the digest, not the tree. Without this a model relaying
    // the pass would imply the expert read files it never saw.
    const tools = build({
      project: "aurora",
      item: async () => detail({ id: "i-a", title: "x", project: "aurora" }),
      consult: async () => passed,
    });
    const withTree = build({
      project: "aurora",
      item: async () => detail({ id: "i-a", title: "x", project: "aurora" }),
      consult: async () => ({ ...passed, cwd: "/repos/aurora" }),
    });

    expect(JSON.parse(await tools.text("spool_consult_expert", { itemId: "i-a" })).readTheProject).toBe(false);
    expect(JSON.parse(await withTree.text("spool_consult_expert", { itemId: "i-a" })).readTheProject).toBe(true);
  });

  test("a thrown consult is reported, not swallowed into a fake success", async () => {
    const tools = build({
      project: "aurora",
      item: async () => detail({ id: "i-a", title: "x", project: "aurora" }),
      consult: async () => {
        throw new Error("the engine is down");
      },
    });
    const result = await tools.call("spool_consult_expert", { itemId: "i-a" });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toContain("the engine is down");
  });
});

/**
 * The two loop-1 verbs — recording a terrain the USER stated, and glancing at
 * one. The properties that matter: scope stays a fact for a scoped session
 * (no `subjectKey` argument exists for it), a clear and a set are distinct
 * requests, and there is deliberately NO acknowledge tool — "noted" is the
 * human's verb.
 */
/**
 * The pin through the wall. The property that matters most is not what the
 * tool does but WHEN the model is allowed to reach for it — the description
 * carries the provenance law (§12: relay, never invent), and the store's own
 * date gate is the only implementation of "strict day".
 */
describe("the pin through the wall — the user's date, relayed and never resolved", () => {
  const mine = item({ id: "i-a", title: "mine", project: "aurora" });
  const withItem = (over: Partial<SpoolCapability> = {}) =>
    build({
      project: "aurora",
      item: async (id) => (id === "i-a" ? { item: mine, attachments: [], tally: { files: 0, mockups: 0 } } : null),
      ...over,
    });

  test("its description carries the law: only a date the user stated, never one the model resolved", () => {
    const pin = build().registered.find((r) => r.name === "spool_pin")!.description;
    expect(pin).toContain("ONLY when the user names the date");
    expect(pin).toContain("NEVER resolve");
    expect(pin).toContain("ask which day they mean");
    expect(pin).toContain("removes the pin and nothing else");
  });

  test("set writes {day} and clear writes null — both through the SAME update path as everything else", async () => {
    const written: unknown[] = [];
    const tools = withItem({
      update: async (_id, patch) => {
        written.push(patch);
        return item({ id: "i-a", title: "mine", ...(patch.pinned ? { pinned: patch.pinned } : {}) });
      },
    });

    const set = JSON.parse(await tools.text("spool_pin", { itemId: "i-a", day: "2026-08-19" }));
    expect(set.pinned).toEqual({ day: "2026-08-19" });
    expect(set.note).toContain("the user's own date");
    expect(set.note).toContain("Nothing was scheduled");

    const cleared = JSON.parse(await tools.text("spool_pin", { itemId: "i-a", clear: true }));
    expect(cleared.pinned).toBeUndefined();
    expect(cleared.note).toContain("only the day mark is gone");

    expect(written).toEqual([{ pinned: { day: "2026-08-19" } }, { pinned: null }]);
  });

  test("no day and no clear, or both at once, is refused before anything is written", async () => {
    let wrote = false;
    const tools = withItem({
      update: async () => {
        wrote = true;
        return mine;
      },
    });
    const neither = await tools.call("spool_pin", { itemId: "i-a" });
    expect(neither.isError).toBe(true);
    expect(String((neither.content[0] as { text: string }).text)).toContain("YYYY-MM-DD");
    const both = await tools.call("spool_pin", { itemId: "i-a", day: "2026-08-19", clear: true });
    expect(both.isError).toBe(true);
    expect(String((both.content[0] as { text: string }).text)).toContain("opposite moves");
    expect(wrote).toBe(false);
  });

  test("a bad date comes back as the STORE's sentence — the tool adds no second date parser", async () => {
    const tools = withItem({
      update: async () => {
        // What the real capability does: the store's gate throws its sentence
        // and the client surfaces it. The tool must RELAY it, not pre-empt it.
        throw new Error('A pin is the user\'s own day, written out: `pinned: {day: "YYYY-MM-DD"}` …');
      },
    });
    const result = await tools.call("spool_pin", { itemId: "i-a", day: "Friday" });
    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toContain("the user's own day");
  });

  test("an OUT-OF-SCOPE id answers byte-identically to one that does not exist, and nothing is written", async () => {
    const theirs = item({ id: "i-b", title: "theirs", project: "borealis" });
    let wrote = false;
    const tools = build({
      project: "aurora",
      item: async (id) => (id === "i-b" ? { item: theirs, attachments: [], tally: { files: 0, mockups: 0 } } : null),
      update: async () => {
        wrote = true;
        return theirs;
      },
    });
    const said = async (id: string) => {
      const result = await tools.call("spool_pin", { itemId: id, day: "2026-08-19" });
      return { ...result, content: [{ type: "text", text: String((result.content[0] as { text: string }).text).replaceAll(id, "<id>") }] };
    };
    expect(await said("i-b")).toEqual(await said("i-zzz"));
    expect(wrote).toBe(false);
  });
});

describe("terrain and looks through the wall", () => {
  test("a scoped session names no subject; the master must — the standing scope rule", () => {
    const master = build();
    const scoped = build({ project: "aurora" });
    for (const name of ["spool_look", "spool_set_terrain", "spool_set_subject_identity"]) {
      expect(Object.keys(master.registered.find((r) => r.name === name)!.shape)).toContain("subjectKey");
      expect(Object.keys(scoped.registered.find((r) => r.name === name)!.shape)).not.toContain("subjectKey");
    }
  });

  test("a scoped session looks at ITS OWN subject without being able to say otherwise", async () => {
    const asked: string[] = [];
    const tools = build({
      project: "aurora",
      look: async (subjectKey) => {
        asked.push(subjectKey);
        return { subject: subjectKey, fresh: false, note: "no terrain" };
      },
    });
    await tools.call("spool_look", { subjectKey: "borealis" } as never);
    // The stray argument is ignored — scope is a fact, not an input.
    expect(asked).toEqual(["aurora"]);
  });

  test("set requires the repo the user stated; clear requires nothing but the word", async () => {
    const written: Array<unknown> = [];
    const tools = build({
      setTerrain: async (subjectKey, terrain) => {
        written.push(terrain);
        return { key: subjectKey, name: subjectKey, permits: "draft", ...(terrain ? { terrain } : {}), created: "Tue", schemaVersion: 1 };
      },
    });

    const empty = await tools.call("spool_set_terrain", { subjectKey: "ozom-gv" });
    expect(empty.isError).toBe(true);
    expect(written).toHaveLength(0);

    const set = JSON.parse(await tools.text("spool_set_terrain", { subjectKey: "ozom-gv", repo: "ozom-ai/ozom-gv", notes: "Hitos" }));
    expect(set.terrain).toEqual({ kind: "github-repo", repo: "ozom-ai/ozom-gv", notes: "Hitos" });
    expect(set.note).toContain("starts nothing");

    const cleared = JSON.parse(await tools.text("spool_set_terrain", { subjectKey: "ozom-gv", clear: true }));
    expect(cleared.terrain).toBeNull();
    expect(written).toEqual([{ kind: "github-repo", repo: "ozom-ai/ozom-gv", notes: "Hitos" }, null]);
  });

  test("a look relays only unacknowledged observations, with the look's own label", async () => {
    const tools = build({
      look: async () => ({
        subject: "ozom-gv",
        terrain: { kind: "github-repo", repo: "ozom-ai/ozom-gv" },
        fresh: true,
        look: {
          subject: "ozom-gv",
          schemaVersion: 1,
          lastLooked: "Sat 07:40",
          lastLookedAt: 1,
          world: { issues: [], pulls: [] },
          observations: [
            { id: "o-1", text: "PR #420 merged since your last look.", refs: [], seen: "Sat 07:40", seenAt: 1 },
            { id: "o-2", text: "already noted", refs: [], seen: "Fri", seenAt: 0, acknowledged: true },
          ],
        },
      }),
    });
    const parsed = JSON.parse(await tools.text("spool_look", { subjectKey: "ozom-gv" }));
    expect(parsed.looked).toBe("Sat 07:40");
    expect(parsed.observations.map((o: { id: string }) => o.id)).toEqual(["o-1"]);
  });

  test("no-terrain and a thrown look are both answers a model can relay", async () => {
    const noTerrain = build();
    const parsed = JSON.parse(await noTerrain.text("spool_look", { subjectKey: "school" }));
    expect(parsed.note).toContain("no terrain");

    const down = build({
      look: async () => {
        throw new Error("the engine is down");
      },
    });
    const result = await down.call("spool_look", { subjectKey: "ozom-gv" });
    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toContain("the engine is down");
  });

  test("there is NO acknowledge tool — noted is the human's verb", () => {
    const names = build().registered.map((r) => r.name).join(" ");
    expect(names).not.toContain("ack");
    expect(names).not.toContain("noted");
  });
});

/**
 * IDENTITY through the wall. What matters most is the description a model
 * reads — identity is the user's to state, never the model's to invent — and
 * that color carries no urgency anywhere in the surface.
 */
describe("identity through the wall — the user's area and color, relayed and never invented", () => {
  test("its description carries the law: the user states identity, and color is never urgency", () => {
    const description = build().registered.find((r) => r.name === "spool_set_subject_identity")!.description;
    expect(description).toContain("ONLY when the user states it");
    expect(description).toContain("NEVER invent an area");
    expect(description).toContain("never pick a color uninvited");
    expect(description).toContain("never how urgent");
  });

  test("set and clear write field-by-field patches through the one capability", async () => {
    const written: unknown[] = [];
    const tools = build({
      setIdentity: async (subjectKey, patch) => {
        written.push(patch);
        return {
          key: subjectKey,
          name: subjectKey,
          permits: "draft" as const,
          ...(patch.area ? { area: patch.area } : {}),
          ...(patch.color ? { color: patch.color } : {}),
          created: "Tue",
          schemaVersion: 1,
        };
      },
    });

    const set = JSON.parse(await tools.text("spool_set_subject_identity", { subjectKey: "casa", area: "Personal", color: "sea" }));
    expect(set.area).toBe("Personal");
    expect(set.color).toBe("sea");
    expect(set.note).toContain("nothing about its urgency");

    const clearedColor = JSON.parse(await tools.text("spool_set_subject_identity", { subjectKey: "casa", clearColor: true }));
    expect(clearedColor.color).toBeNull();

    expect(written).toEqual([{ area: "Personal", color: "sea" }, { color: null }]);
  });

  test("nothing stated, a set-and-clear collision, or a token off the closed set is refused before anything is written", async () => {
    let wrote = false;
    const tools = build({
      setIdentity: async () => {
        wrote = true;
        return { key: "casa", name: "casa", permits: "draft" as const, created: "Tue", schemaVersion: 1 };
      },
    });
    const nothing = await tools.call("spool_set_subject_identity", { subjectKey: "casa" });
    expect(nothing.isError).toBe(true);
    expect(String((nothing.content[0] as { text: string }).text)).toContain("Name what the user stated");

    const areaCollision = await tools.call("spool_set_subject_identity", { subjectKey: "casa", area: "Trabajo", clearArea: true });
    expect(areaCollision.isError).toBe(true);
    expect(String((areaCollision.content[0] as { text: string }).text)).toContain("opposite moves");

    const colorCollision = await tools.call("spool_set_subject_identity", { subjectKey: "casa", color: "sea", clearColor: true });
    expect(colorCollision.isError).toBe(true);

    const hex = await tools.call("spool_set_subject_identity", { subjectKey: "casa", color: "#ff0000" });
    expect(hex.isError).toBe(true);
    expect(String((hex.content[0] as { text: string }).text)).toContain('"plum"');

    expect(wrote).toBe(false);
  });

  test("a scoped session states identity for ITS OWN subject without being able to say otherwise", async () => {
    const asked: string[] = [];
    const tools = build({
      project: "aurora",
      setIdentity: async (subjectKey, patch) => {
        asked.push(subjectKey);
        return {
          key: subjectKey,
          name: subjectKey,
          permits: "draft" as const,
          ...(patch.area ? { area: patch.area } : {}),
          created: "Tue",
          schemaVersion: 1,
        };
      },
    });
    // The stray argument is ignored — scope is a fact, not an input.
    await tools.call("spool_set_subject_identity", { subjectKey: "borealis", area: "Trabajo" } as never);
    expect(asked).toEqual(["aurora"]);
  });
});

describe("the aperture through the wall — the user's own room, shown as they asked", () => {
  test("its description routes a SEE-request to the room, not to prose — and pins the see-vs-ask line", () => {
    const description = build().registered.find((r) => r.name === "spool_set_aperture")!.description;
    // A live drive showed the agent narrating "lo de hoy" as a summary while
    // the room stayed wide — good answer, wrong organ. The description now
    // says the room IS part of the reply, and to change it FIRST.
    expect(description).toContain("CHANGE THE ROOM");
    expect(description).toContain("call this FIRST");
    expect(description).toContain("Muéstrame lo de hoy");
    expect(description).toContain("a window they are standing next to");
    // …and keeps it honest: the trigger is asking to SEE, not any mention of a
    // day — a genuine question is still answered in words.
    expect(description).toContain("not any mention of a day");
    expect(description).toContain("¿qué se movió hoy?");
    expect(description).toContain("no view change");
    expect(description).toContain("no work starts");
    expect(description).toContain("spool_set_focus");
  });

  /**
   * EVERY session carries it, with the SAME one-argument shape — mirroring
   * `spool_set_focus`, which is likewise on every session's wall. The scope
   * rule ("the master names a subject; a scoped session's subject is a fact")
   * has nothing to bind here: the view names no subject, and the deeper,
   * subject-shaped aperture stays the focus verbs' job.
   */
  test("master and scoped sessions get the identical shape — a view names no subject, so there is nothing to scope", () => {
    for (const tools of [build(), build({ project: "aurora" })]) {
      expect(Object.keys(tools.registered.find((r) => r.name === "spool_set_aperture")!.shape)).toEqual(["view"]);
    }
  });

  test("a stated view lands on the one slot; a stray one refuses with the sentence and writes nothing", async () => {
    const written: string[] = [];
    const tools = build({
      setAperture: async (view) => {
        written.push(view);
        return { view, schemaVersion: 1 };
      },
    });
    const shown = JSON.parse(await tools.text("spool_set_aperture", { view: "today" }));
    expect(shown.view).toBe("today");
    // The note tells the model what this DID: changed what the user sees,
    // touched no work.
    expect(shown.note).toContain("Nothing about the work changed");

    const bad = await tools.call("spool_set_aperture", { view: "urgent" });
    expect(bad.isError).toBe(true);
    expect(String((bad.content[0] as { text: string }).text)).toContain("not a view the room has");
    expect(written).toEqual(["today"]);
  });
});

describe("area ceilings through the wall — stated by the user, clamping down, never assumed", () => {
  test("its description carries the provenance law and the clamp's direction", () => {
    const description = build().registered.find((r) => r.name === "spool_set_area_permits")!.description;
    expect(description).toContain("ONLY when the user states it");
    expect(description).toContain("Never set one uninvited");
    expect(description).toContain("never assume any area");
    expect(description).toContain("never raise");
  });

  /**
   * THE AREA IS NAMED BY EVERY SESSION — a deliberate reading of the scope rule
   * rather than a breach: terrain and identity resolve a scoped session's
   * SUBJECT as a fact about the session, but an area is not a fact about any
   * session — it spans subjects — so the name comes from the user's own words
   * everywhere, and the shape is identical on both walls.
   */
  test("master and scoped sessions get the identical shape — an area is not a fact about any session", () => {
    for (const tools of [build(), build({ project: "aurora" })]) {
      expect(Object.keys(tools.registered.find((r) => r.name === "spool_set_area_permits")!.shape)).toEqual([
        "area",
        "ceiling",
        "clear",
      ]);
    }
  });

  test("state and withdraw go through the one capability; every bad input refuses with a sentence and writes nothing", async () => {
    const written: Array<[string, string | null]> = [];
    const tools = build({
      setAreaPermits: async (name, ceiling) => {
        written.push([name, ceiling]);
        return { name, ...(ceiling ? { ceiling } : {}), created: "Tue", schemaVersion: 1 };
      },
    });

    const stated = JSON.parse(await tools.text("spool_set_area_permits", { area: "Personal", ceiling: "read" }));
    expect(stated).toMatchObject({ area: "Personal", ceiling: "read" });
    expect(stated.note).toContain("never raises");

    const withdrawn = JSON.parse(await tools.text("spool_set_area_permits", { area: "Personal", clear: true }));
    expect(withdrawn.ceiling).toBeNull();

    // The refusals: no area, no statement at all, both halves at once, and a
    // level outside the enum — each a sentence, none a write.
    const text = (r: { content: unknown[] }) => String((r.content[0] as { text: string }).text);
    const nameless = await tools.call("spool_set_area_permits", { ceiling: "read" });
    expect(nameless.isError).toBe(true);
    expect(text(nameless)).toContain("Name the area");
    const unstated = await tools.call("spool_set_area_permits", { area: "Personal" });
    expect(unstated.isError).toBe(true);
    expect(text(unstated)).toContain("clear: true");
    const both = await tools.call("spool_set_area_permits", { area: "Personal", ceiling: "read", clear: true });
    expect(both.isError).toBe(true);
    expect(text(both)).toContain("opposite moves");
    const level = await tools.call("spool_set_area_permits", { area: "Personal", ceiling: "urgent" });
    expect(level.isError).toBe(true);
    expect(text(level)).toContain("not a permit level");

    expect(written).toEqual([
      ["Personal", "read"],
      ["Personal", null],
    ]);
  });
});

describe("the shelf and the search on the wall", () => {
  const note = (over: Partial<import("@telar/engine-client").SpoolNote> & { id: string; title: string }) => ({
    body: "body",
    tags: [],
    created: { label: "Tue", at: 0 },
    updated: { label: "Tue", at: 0 },
    author: "you" as const,
    schemaVersion: 1,
    ...over,
  });
  const threeNotes = async () => [
    note({ id: "n-ozom", title: "ozom note", subjectKey: "ozom-gv" }),
    note({ id: "n-aurora", title: "aurora note", subjectKey: "aurora" }),
    note({ id: "n-floating", title: "floating note" }),
  ];

  test("spool_shelf: a scoped session sees ONLY its subject's notes — floating ones belong to the master, like items", async () => {
    const scoped = build({ project: "ozom-gv", notes: threeNotes });
    const listed = JSON.parse(await scoped.text("spool_shelf"));
    expect(listed.scope).toBe("ozom-gv");
    expect(listed.notes.map((n: { id: string }) => n.id)).toEqual(["n-ozom"]);

    // An out-of-scope noteId answers BYTE-IDENTICALLY to a missing one — the
    // oracle rule, on knowledge as on items.
    const foreign = await scoped.call("spool_shelf", { noteId: "n-aurora" });
    const missing = await scoped.call("spool_shelf", { noteId: "n-nothing-x" });
    expect(foreign.isError).toBe(true);
    expect(String((foreign.content[0] as { text: string }).text).replace("n-aurora", "n-nothing-x")).toBe(
      String((missing.content[0] as { text: string }).text),
    );

    // The master sees everything, and may narrow by subjectKey.
    const master = build({ notes: threeNotes });
    expect(JSON.parse(await master.text("spool_shelf")).notes.map((n: { id: string }) => n.id)).toEqual([
      "n-ozom",
      "n-aurora",
      "n-floating",
    ]);
    const narrowed = JSON.parse(await master.text("spool_shelf", { subjectKey: "aurora" }));
    expect(narrowed.notes.map((n: { id: string }) => n.id)).toEqual(["n-aurora"]);
    // Reading one gives the full body; the list never carries it.
    expect(listed.notes[0].body).toBeUndefined();
    expect(JSON.parse(await master.text("spool_shelf", { noteId: "n-ozom" })).body).toBe("body");
  });

  test("spool_write_note ALWAYS declares author 'session' in its own code — no tool shape can carry an author", async () => {
    const created: Array<Record<string, unknown>> = [];
    const tools = build({
      project: "ozom-gv",
      createNote: async (input) => {
        created.push(input as Record<string, unknown>);
        return note({ id: "n-new", title: input.title, subjectKey: input.subjectKey, author: input.author ?? "session" });
      },
    });
    // The shape carries NO author and — scoped — no subjectKey either: the
    // subject is a fact about the session, and authorship is the handler's own
    // declaration, exactly like spool_create_item's `source`.
    const shape = tools.registered.find((r) => r.name === "spool_write_note")!.shape;
    expect(Object.keys(shape)).toEqual(["noteId", "title", "body", "tags"]);

    const result = JSON.parse(await tools.text("spool_write_note", { title: "decision", body: "ship friday", tags: ["decision"] }));
    expect(created[0]!.author).toBe("session");
    expect(created[0]!.subjectKey).toBe("ozom-gv"); // server-supplied, never a model argument
    expect(result.author).toBe("session");
    expect(result.note).toContain("knowledge, not work");

    // A new note without both halves is refused with the next move.
    const half = await tools.call("spool_write_note", { title: "only a title" });
    expect(half.isError).toBe(true);

    // The master names the subject — the same premise repair as everywhere.
    const master = build({ createNote: async (input) => (created.push(input as Record<string, unknown>), note({ id: "n-2", title: input.title, subjectKey: input.subjectKey })) });
    await master.call("spool_write_note", { title: "t", body: "b", subjectKey: "aurora" });
    expect(created.at(-1)!.subjectKey).toBe("aurora");
  });

  test("spool_write_note edits stay in scope, and an empty patch is refused rather than a no-op", async () => {
    const patched: Array<[string, Record<string, unknown>]> = [];
    const tools = build({
      project: "ozom-gv",
      notes: threeNotes,
      updateNote: async (id, patch) => (patched.push([id, patch as Record<string, unknown>]), note({ id, title: patch.title ?? "kept", subjectKey: "ozom-gv", author: "session" })),
    });
    // Out-of-scope edit: byte-identical to not-found, and the capability is
    // never reached.
    const foreign = await tools.call("spool_write_note", { noteId: "n-aurora", title: "hijack" });
    expect(foreign.isError).toBe(true);
    expect(patched).toEqual([]);

    const empty = await tools.call("spool_write_note", { noteId: "n-ozom" });
    expect(empty.isError).toBe(true);

    const edited = JSON.parse(await tools.text("spool_write_note", { noteId: "n-ozom", tags: ["guard"] }));
    expect(patched).toEqual([["n-ozom", { tags: ["guard"] }]]);
    expect(edited.note).toContain("author does not change");
  });

  test("spool_search: a scoped session searches its own slice — the subject is never its argument — and the master names one", async () => {
    const asked: Array<[string, string | undefined]> = [];
    const search = async (query: string, subject?: string) => {
      asked.push([query, subject]);
      return [];
    };
    const scoped = build({ project: "ozom-gv", search });
    expect(Object.keys(scoped.registered.find((r) => r.name === "spool_search")!.shape)).toEqual(["query"]);
    const answer = JSON.parse(await scoped.text("spool_search", { query: "facturación" }));
    expect(asked).toEqual([["facturación", "ozom-gv"]]);
    expect(answer.scope).toBe("ozom-gv");
    expect(answer.note).toContain("lexical");

    const master = build({ search });
    await master.call("spool_search", { query: "paridad" });
    await master.call("spool_search", { query: "paridad", subjectKey: "aurora" });
    expect(asked.slice(1)).toEqual([
      ["paridad", undefined],
      ["paridad", "aurora"],
    ]);
    expect((await master.call("spool_search", { query: "  " })).isError).toBe(true);
  });
});
