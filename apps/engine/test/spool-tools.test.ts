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
  test("five tools, each declaring its capability in its name", () => {
    const { registered } = build();
    expect(registered.map((r) => r.name)).toEqual([
      "spool_list_items",
      "spool_list_lanes",
      "spool_create_item",
      "spool_update_item",
      "spool_consult_expert",
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
    for (const forbidden of ["verdict", "status", "state", "done", "accepted", "promotedFrom", "tracking", "raw", "rawSource", "timeline", "subtasks", "project"]) {
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
