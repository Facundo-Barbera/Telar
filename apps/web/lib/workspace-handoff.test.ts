// The handoff layer (story 5.5, CAP-11) — what the loom is handed, and where
// this module STOPS.
//
// TWO CLAIMS ARE UNDER TEST, and they pull in opposite directions:
//   1. The loom really is handed the packets' own words — "premise = `fixed` +
//      `acceptance`, context = attachments; nothing is re-authored"
//      (item-model.md). So the composition is asserted on CONTENT, not on
//      shape: the exact brief text, the exact criteria, the attachment names.
//   2. The module stops at the detach boundary: "never write loom state and
//      never done a loom from here" (stories.yaml). So the double below
//      installs the forbidden neighbours — startLoomFromBundle, acceptItem,
//      deleteItem — and every one of them fails the test if it is ever called.
//      An absence proved by grep is a claim about today's source; an absence
//      proved by a throwing double survives the next edit.
//
// HARNESS: workspace-mcp.test.ts's, same ritual and same reason —
// mock.module("@telar/core") is process-global, so the real namespace is
// snapshotted before the mock is installed and restored in afterAll, and the
// last test in the file is a vacuity guard that fails loudly if the stub is not
// live. THIS SUITE REACHES NO STATE ROOT (the store's own disk behaviour,
// including trackLoom's, is packages/core/test/workspace-store.test.ts's).
//
// bun provides "bun:test" at runtime; @types/bun isn't a dep of this Next app.
// @ts-expect-error no @types/bun in this workspace
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realCore from "@telar/core";

const realCoreSnapshot = { ...realCore };

// ── the doubles (reset in beforeEach) ───────────────────────────────────────
type FakeItem = Record<string, unknown> & { id: string; title: string };

let items: FakeItem[] = [];
let attachmentsById: Record<string, string[]> = {};
// How many times the packet directory was read, per id — the "one read per
// member" property has to be counted to be proved.
let attachmentReads: Record<string, number> = {};
// The looms the module can SEE. `staleTracking` reads this and nothing else: an
// id that is absent is a loom deleted from the god-view.
let looms: Record<string, { id: string; state: string; project: string }> = {};
// What the trackLoom double reports back for ids it refuses to mark — the
// partial-stamp case, which is otherwise unreachable from this layer.
let trackMissing: string[] = [];
let trackAlready: Array<{ id: string; loomId: string }> = [];
// ONE ORDERED LOG for every write the module performs. Order is the property
// under test in "the effect half": the thing that can fail is made first and
// the packets are stamped last, so a crash in the gap leaves an untracked draft
// rather than rows tracking a loom that does not exist.
let calls: string[] = [];
let createDraftLoomThrows: string | null = null;
let trackLoomThrows: string | null = null;
const bundleWrites: Array<{ id: string; relPath: string; contents: string }> = [];
const draftInputs: Array<{ project: string; title: string; account?: string }> = [];
const trackCalls: Array<{
  ids: string[];
  ref: Record<string, unknown>;
  opts?: { replacing?: readonly string[] };
}> = [];

// The neighbours this module is forbidden to touch. Called = failed.
const forbidden = (name: string) => () => {
  calls.push(`FORBIDDEN:${name}`);
  throw new Error(`workspace-handoff called ${name} — it must stop at the detach boundary`);
};

mock.module("@telar/core", () => ({
  getWorkspaceItem: (id: string) => items.find((i) => i.id === id) ?? null,
  readPacketAttachments: (id: string) => {
    attachmentReads[id] = (attachmentReads[id] ?? 0) + 1;
    return attachmentsById[id] ?? [];
  },
  attachmentTally: (names: string[]) => ({ files: names.length, mockups: 0 }),
  // Reads only — the boundary allows this module to LOOK at a loom (to tell a
  // dead tracking ref from a live one) and never to write one.
  getLoom: (id: string) => looms[id] ?? null,
  isTerminalWorkUnitState: (s: string) =>
    s === "done" || s === "halted" || s === "failed" || s === "skipped",
  createDraftLoom: (input: Record<string, unknown>) => {
    calls.push(`createDraftLoom:${input.project}`);
    // `objective` is asserted separately (it is the premise, byte for byte);
    // what is recorded here is the identity trio, with `account` kept ABSENT
    // rather than undefined so its omission is provable.
    draftInputs.push({
      project: input.project as string,
      title: input.title as string,
      ...("account" in input ? { account: input.account as string } : {}),
    });
    if (createDraftLoomThrows) throw new Error(createDraftLoomThrows);
    return { id: "loom-w1", draft: true, state: "queued" };
  },
  writeBundleFile: (id: string, relPath: string, contents: string) => {
    calls.push(`writeBundleFile:${relPath}`);
    bundleWrites.push({ id, relPath, contents });
  },
  updateDraftObjectiveFromBundle: (id: string) => {
    calls.push(`updateDraftObjectiveFromBundle:${id}`);
  },
  trackLoom: (
    ids: string[],
    ref: Record<string, unknown>,
    opts?: { replacing?: readonly string[] },
  ) => {
    calls.push(`trackLoom:${ids.join(",")}`);
    trackCalls.push({ ids, ref, ...(opts ? { opts } : {}) });
    if (trackLoomThrows) throw new Error(trackLoomThrows);
    const refused = new Set([...trackMissing, ...trackAlready.map((a) => a.id)]);
    const tracked: FakeItem[] = [];
    for (const id of ids) {
      const item = items.find((i) => i.id === id);
      if (!item || refused.has(id)) continue;
      item.tracking = ref;
      tracked.push(item);
    }
    return { tracked, missing: [...trackMissing], alreadyTracking: [...trackAlready] };
  },
  // ── the boundary, installed as tripwires ────────────────────────────────
  startLoomFromBundle: forbidden("startLoomFromBundle"),
  updateLoom: forbidden("updateLoom"),
  acceptItem: forbidden("acceptItem"),
  deleteItem: forbidden("deleteItem"),
  updateItem: forbidden("updateItem"),
}));

afterAll(() => {
  mock.module("@telar/core", () => realCoreSnapshot);
});

const { HandoffRefused, planWeave, weaveItems } = await import("./workspace-handoff");

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HandoffRefused);
    return (e as Error).message;
  }
  throw new Error("expected a HandoffRefused, got a success");
};

beforeEach(() => {
  items = [
    {
      id: "i-a1",
      title: "Exports: CSV",
      project: "aurora",
      lane: "aurora",
      provenance: "note",
      captured: "Tue 16:42",
      schemaVersion: 1,
      raw: "csv export is broken for big accounts",
      fixed: "Stream the CSV export so accounts over 50k rows stop timing out.",
      acceptance: ["a 200k-row account exports", "memory stays flat"],
      subtasks: [
        { title: "find the timeout", done: true },
        { title: "stream it", done: false },
      ],
      deadline: { label: "Friday", kind: "soft" },
    },
    {
      id: "i-a2",
      title: "Exports: PDF",
      project: "aurora",
      lane: "aurora",
      provenance: "note",
      captured: "Wed 10:10",
      schemaVersion: 1,
      raw: "someone asked for pdf too",
    },
    {
      id: "i-o1",
      title: "Office thing",
      project: "office",
      lane: "office",
      provenance: "note",
      captured: "Wed 09:00",
      schemaVersion: 1,
    },
    {
      id: "i-f1",
      title: "A floating note",
      lane: "unfiled",
      provenance: "note",
      captured: "Wed 11:02",
      schemaVersion: 1,
    },
  ];
  attachmentsById = { "i-a1": ["timings.csv", "flame.png"], "i-a2": [] };
  attachmentReads = {};
  // The one loom the fixtures point at when they need a LIVE tracking ref.
  looms = { "loom-earlier": { id: "loom-earlier", state: "ready", project: "aurora" } };
  calls = [];
  bundleWrites.length = 0;
  draftInputs.length = 0;
  trackCalls.length = 0;
  trackMissing = [];
  trackAlready = [];
  createDraftLoomThrows = null;
  trackLoomThrows = null;
});

// ── planWeave — the proposal, which must exist BEFORE anything does ─────────

describe("planWeave — a full preview, and not one byte written", () => {
  test("the premise is the packet's OWN words: fixed, then its acceptance criteria", () => {
    const plan = planWeave(["i-a1"]);
    expect(plan.premise).toContain("Stream the CSV export so accounts over 50k rows stop timing out.");
    expect(plan.premise).toContain("- a 200k-row account exports");
    expect(plan.premise).toContain("- memory stays flat");
    // `fixed` WINS OVER `raw` when the expert has written one, and the raw
    // capture is not smuggled in beside it — "nothing is re-authored" cuts both
    // ways (item-model.md).
    expect(plan.premise).not.toContain("csv export is broken for big accounts");
    // The ONE sentence this module authors about the work is a boundary
    // statement, not a brief: the loom must not treat the queue as writable.
    expect(plan.premise).toContain("Nothing in the workspace is yours to change.");
    expect(plan.premise).toContain("they leave it when this loom lands and the human accepts");
  });

  test("a bare capture is handed over AS a bare capture — the premise never invents a brief", () => {
    const plan = planWeave(["i-a2"]);
    expect(plan.premise).toContain("someone asked for pdf too");
    expect(plan.members).toEqual({ items: 1, fixed: 0, acceptance: 0, attachments: 0 });
    // …and the receipt the human reads says exactly that (detach-receipt.ts).
    expect(weaveItems(["i-a2"]).receipt.premise).toBe("the title and the raw capture");
  });

  test("an item with neither brief nor capture says so rather than shipping an empty premise", () => {
    const plan = planWeave(["i-o1"]);
    expect(plan.premise).toContain("(no brief was written — the title is all there is)");
    expect(plan.premise).toContain("Office thing");
  });

  test("the context names every attachment and says the bytes did NOT come along", () => {
    const plan = planWeave(["i-a1"]);
    expect(plan.context).toContain("workspace item: `i-a1`");
    expect(plan.context).toContain("project: aurora");
    expect(plan.context).toContain("deadline: Friday (soft)");
    expect(plan.context).toContain("- [x] find the timeout");
    expect(plan.context).toContain("- [ ] stream it");
    expect(plan.context).toContain("Attachments the packet carries (2):");
    expect(plan.context).toContain("- timings.csv");
    expect(plan.context).toContain("- flame.png");
    expect(plan.context).toContain("These files are NOT in this bundle");
    // An attachment-less packet says so instead of rendering an empty list.
    expect(planWeave(["i-a2"]).context).toContain("No attachments.");
  });

  test("NO WORKSPACE PATH IS EVER HANDED OVER — INV-11b, asserted on the bytes", () => {
    // AD-5 / INV-11b: TELAR_HOME/workspace sits outside every session's working
    // root and a loom mounts no workspace MCP server, so an absolute packet path
    // in the bundle is a pointer the loom cannot follow — under Codex's
    // path-based sandbox it is unreadable, under Claude it is the isolation leak
    // the invariant forbids. An earlier pass wrote exactly that path, which is
    // why this is asserted on the composed text and not left to review.
    const plan = planWeave(["i-a1", "i-a2"]);
    for (const text of [plan.premise, plan.context]) {
      expect(text).not.toContain("/workspace/packets/");
      expect(text).not.toMatch(/(^|\s)\/[^\s]*packets?\//);
    }
  });

  test("ONE directory read per member — the tally and the manifest cannot disagree", () => {
    // Two consumers (the receipt's attachment count, context.md's list) fed from
    // one read. Reading twice was 2N reads for an N-item batch and, if a file
    // landed in the gap, a receipt that counted one thing while the bundle named
    // another.
    planWeave(["i-a1", "i-a2"]);
    expect(attachmentReads).toEqual({ "i-a1": 1, "i-a2": 1 });
  });

  test("a batch is ONE plan with every member in it, and the tallies are the batch's", () => {
    const plan = planWeave(["i-a1", "i-a2"], { reason: "both are the exports series" });
    expect(plan.project).toBe("aurora");
    expect(plan.items.map((i) => i.id)).toEqual(["i-a1", "i-a2"]);
    expect(plan.premise).toContain("Exports: CSV");
    expect(plan.premise).toContain("Exports: PDF");
    // The master's one-line rationale rides along; a human's own selection has
    // none and the plan then carries no `reason` at all rather than an empty one.
    expect(plan.premise).toContain("both are the exports series");
    expect(plan.reason).toBe("both are the exports series");
    expect(planWeave(["i-a1"], { reason: "   " }).reason).toBeUndefined();
    expect(plan.members).toEqual({ items: 2, fixed: 1, acceptance: 1, attachments: 2 });
    // The default title names the batch honestly; an explicit one wins.
    expect(plan.title).toBe("Exports: CSV + 1 more");
    expect(planWeave(["i-a1"]).title).toBe("Exports: CSV");
    expect(planWeave(["i-a1", "i-a2"], { title: "Exports series" }).title).toBe("Exports series");
  });

  test("PLANNING WRITES NOTHING — the human reads the whole proposal before it exists", () => {
    // ui-contract.md's "proposal → explicit human approval → effect". The card
    // renders this plan; if planning had already created the draft, the
    // approval would be a formality over an accomplished fact.
    planWeave(["i-a1", "i-a2"], { reason: "x" });
    expect(calls).toEqual([]);
    expect(items.find((i) => i.id === "i-a1")!.tracking).toBeUndefined();
  });

  test("duplicate ids collapse — a selection is a set, and the loom is not handed the same packet twice", () => {
    const plan = planWeave(["i-a1", "i-a1", " i-a1 "]);
    expect(plan.items.map((i) => i.id)).toEqual(["i-a1"]);
    expect(plan.members.items).toBe(1);
  });
});

// ── the refusals, which ARE the product (they land on the approval card) ────

describe("planWeave refusals — each one names what happened and the way out", () => {
  test("an empty selection", () => {
    expect(refusal(() => planWeave([]))).toContain("Nothing was selected");
    expect(refusal(() => planWeave(["", "  "]))).toContain("Nothing was selected");
  });

  test("a missing id names the id and states that nothing was woven", () => {
    const msg = refusal(() => planWeave(["i-a1", "i-nope"]));
    expect(msg).toContain('"i-nope"');
    expect(msg).toContain("Nothing was woven.");
    // ALL-OR-NOTHING: the reachable member is not woven alone behind the
    // human's back — the selection they approved is the selection or none.
    expect(calls).toEqual([]);
  });

  test("a floating item is refused with the equal alternative named, not with a scolding", () => {
    // item-model.md: "absent = floating, and floating is a valid resting state".
    // The refusal is about the LOOM (no repo to weave in), so it points at the
    // handoff that does work for a floating item.
    const msg = refusal(() => planWeave(["i-f1"]));
    expect(msg).toContain('"A floating note"');
    expect(msg).toContain("no project, so there is no repo for a loom to weave in");
    expect(msg).toContain("File it to a project first, or start a session instead.");
  });

  test("a mixed selection is refused with both projects named", () => {
    const msg = refusal(() => planWeave(["i-a1", "i-o1"]));
    expect(msg).toContain("spans 2 projects");
    expect(msg).toContain("aurora");
    expect(msg).toContain("office");
    expect(msg).toContain("start a session for each");
  });

  test("an item already tracking a loom is refused, and the refusal states WHEN it will leave", () => {
    // CAP-11: rows "leave only when it lands AND the human accepts". A second
    // weave would leave the queue tracking only the newer loom, so it is a
    // refusal rather than a re-point (store.ts's trackLoom refuses it too — this
    // is the layer that turns that into a sentence).
    items.find((i) => i.id === "i-a1")!.tracking = { loomId: "loom-earlier", label: "Exports: CSV" };
    const msg = refusal(() => planWeave(["i-a1", "i-a2"]));
    expect(msg).toContain('"Exports: CSV"');
    expect(msg).toContain("loom-earlier");
    expect(msg).toContain("A row leaves the queue when its loom lands and you accept");
    expect(msg).toContain("not re-woven");
    // …and it names the way out, which is the loom side's own cancel.
    expect(msg).toContain("Cancel that loom");
    expect(calls).toEqual([]);
  });

  test("a row tracking a loom that LANDED is still refused — done is not dead", () => {
    // The row leaves when the human ACCEPTS, and that acceptance is the whole
    // of CAP-11's sentence. Re-weaving it here would take the accept decision
    // away from them by making the mark point somewhere else first.
    looms["loom-earlier"]!.state = "done";
    items.find((i) => i.id === "i-a1")!.tracking = { loomId: "loom-earlier", label: "Exports: CSV" };
    expect(refusal(() => planWeave(["i-a1"]))).toContain("loom-earlier");
  });

  test("a row tracking a CANCELLED loom is re-weavable, and only that row is `replacing`", () => {
    // A halted/failed loom can never land and can never be accepted, so its
    // members could otherwise leave the queue by NO path at all — the mark
    // would be a life sentence over an event that already ended badly.
    looms["loom-earlier"]!.state = "halted";
    items.find((i) => i.id === "i-a1")!.tracking = { loomId: "loom-earlier", label: "Exports: CSV" };
    const plan = planWeave(["i-a1", "i-a2"]);
    expect(plan.replacing).toEqual(["i-a1"]);
    // The untracked member is NOT in the exception list: `replacing` lifts
    // store.ts's re-point refusal, so it must name only the rows that earned it.
    expect(planWeave(["i-a2"]).replacing).toEqual([]);
  });

  test("a row tracking a loom that no longer EXISTS is re-weavable — AD-8's ref can dangle", () => {
    // Item.tracking is a weak reference by design (AD-8): the god-view can
    // delete a loom and the workspace store never hears about it.
    items.find((i) => i.id === "i-a1")!.tracking = { loomId: "loom-vanished", label: "Exports: CSV" };
    expect(planWeave(["i-a1"]).replacing).toEqual(["i-a1"]);
  });

  test("a LIVE loom among dead ones still refuses the whole selection", () => {
    // All-or-nothing again: the human approved one selection, and one member
    // that is genuinely out at a running loom is enough to refuse it.
    looms["loom-earlier"]!.state = "halted";
    looms["loom-live"] = { id: "loom-live", state: "running", project: "aurora" };
    items.find((i) => i.id === "i-a1")!.tracking = { loomId: "loom-earlier" };
    items.find((i) => i.id === "i-a2")!.tracking = { loomId: "loom-live" };
    const msg = refusal(() => planWeave(["i-a1", "i-a2"]));
    expect(msg).toContain("loom-live");
    expect(msg).not.toContain("loom-earlier");
    expect(calls).toEqual([]);
  });
});

// ── weaveItems — the effect half ────────────────────────────────────────────

describe("weaveItems — a DRAFT loom, then the stamps, in that order", () => {
  test("the whole write sequence, pinned in order", () => {
    // The plan is taken FIRST because the weave stamps the rows, and a stamped
    // row is (correctly) un-plannable a second time — the same property the
    // "already tracking" refusal above pins.
    const plan = planWeave(["i-a1", "i-a2"], { reason: "the exports series" });
    const out = weaveItems(["i-a1", "i-a2"], { reason: "the exports series", account: "facundo@personal" });
    expect(calls).toEqual([
      "createDraftLoom:aurora",
      "writeBundleFile:objective.md",
      "writeBundleFile:context.md",
      "updateDraftObjectiveFromBundle:loom-w1",
      "trackLoom:i-a1,i-a2",
    ]);
    // The bundle carries the plan verbatim — the loom reads the same premise
    // the human approved, not a re-rendering of it.
    expect(bundleWrites.find((w) => w.relPath === "objective.md")!.contents).toBe(plan.premise);
    expect(bundleWrites.find((w) => w.relPath === "context.md")!.contents).toBe(plan.context);
    expect(bundleWrites.every((w) => w.id === "loom-w1")).toBe(true);
    expect(out).toMatchObject({ loomId: "loom-w1", url: "/looms/loom-w1", project: "aurora", tracked: ["i-a1", "i-a2"] });
  });

  test("it creates a DRAFT and never starts one — the commit that spends is §M.6's, elsewhere", () => {
    weaveItems(["i-a1"]);
    // startLoomFromBundle is installed as a throwing tripwire; reaching it would
    // have failed this test at the call site. Asserted positively too, so the
    // test says what it means rather than relying on an absent failure.
    expect(calls.some((c) => c.startsWith("FORBIDDEN:"))).toBe(false);
    expect(calls).toContain("createDraftLoom:aurora");
  });

  test("the account the tool resolved is the account the loom is billed to", () => {
    // workspace-mcp.ts hands weave_batch the chat's own SERVER-resolved account
    // (never a model-supplied one), the same value loom-mcp's start_loom uses.
    // Dropping it on the floor silently billed every woven loom to the project
    // manifest's default instead.
    weaveItems(["i-a1"], { account: "facundo@personal" });
    expect(draftInputs).toEqual([
      { project: "aurora", title: "Exports: CSV", account: "facundo@personal" },
    ]);
    // The HTTP route passes none — it has no session identity to read and must
    // not invent one from a request body — and createDraftLoom then falls back
    // to the manifest's account, so the KEY IS ABSENT rather than undefined.
    draftInputs.length = 0;
    weaveItems(["i-a1"]);
    expect(draftInputs).toEqual([{ project: "aurora", title: "Exports: CSV" }]);
  });

  test("the rows are STAMPED, not moved: trackLoom gets every member and the loom's own label", () => {
    const out = weaveItems(["i-a1", "i-a2"], { title: "Exports series" });
    expect(trackCalls).toEqual([
      {
        ids: ["i-a1", "i-a2"],
        ref: { loomId: "loom-w1", label: "Exports series" },
        // The ordinary weave overwrites NOTHING: store.ts's re-point refusal
        // stays fully armed unless the plan proved a ref dead.
        opts: { replacing: [] },
      },
    ]);
    expect(out.tracked).toEqual(["i-a1", "i-a2"]);
    // Nothing in this module removes, accepts or completes anything — the
    // Human-Accept Moat holds by construction here, and the tripwires above
    // (acceptItem/deleteItem) are what keep it holding.
    expect(calls.filter((c) => c.startsWith("FORBIDDEN:"))).toEqual([]);
  });

  test("the receipt comes back composed, ready for the one renderer every surface uses", () => {
    const out = weaveItems(["i-a1", "i-a2"]);
    expect(out.receipt).toEqual({
      loomId: "loom-w1",
      premise: "2 items' briefs and raw captures + acceptance criteria",
      context: "2 attachments",
      origin: "the workspace",
      note: expect.stringContaining("all 2 rows stay in the queue tracking the loom"),
    });
  });

  test("an unregistered project becomes a refusal that names the project, and stamps nothing", () => {
    // createDraftLoom's getProject throws for a project the human later
    // un-registered — an item can outlive its project's registration.
    createDraftLoomThrows = 'Unknown project "aurora"';
    const msg = refusal(() => weaveItems(["i-a1"]));
    expect(msg).toContain('Could not plan a loom in "aurora"');
    expect(msg).toContain('Unknown project "aurora"');
    expect(calls).toEqual(["createDraftLoom:aurora"]);
    expect(items.find((i) => i.id === "i-a1")!.tracking).toBeUndefined();
  });

  test("a stamp that fails does NOT take the draft loom with it — the gap is the safe direction", () => {
    // The deliberate asymmetry: a crash after the loom exists leaves a draft
    // nobody tracks (visible, startable by a human, harmless). The other order
    // would leave rows pointing at a loom that was never created.
    trackLoomThrows = "packet i-a1 is not where lanes.yaml says it is";
    expect(() => weaveItems(["i-a1"])).toThrow("packet i-a1 is not where lanes.yaml says it is");
    expect(calls).toContain("createDraftLoom:aurora");
    expect(items.find((i) => i.id === "i-a1")!.tracking).toBeUndefined();
  });

  test("a PARTIAL stamp is a refusal that names both the loom and the rows it lost", () => {
    // trackLoom reports the ids it could not mark instead of throwing (the
    // packet vanished between plan and stamp, or another weave got there
    // first). Reading only `tracked` returned a receipt claiming "all N rows
    // stay in the queue tracking the loom" while some tracked another loom
    // entirely — the exact orphaning store.ts's re-point refusal exists to
    // prevent, re-created one layer up by ignoring its report.
    trackAlready = [{ id: "i-a2", loomId: "loom-other" }];
    const msg = refusal(() => weaveItems(["i-a1", "i-a2"]));
    expect(msg).toContain("Loom loom-w1 was planned with all 2 items");
    expect(msg).toContain("only 1 of them could be marked");
    expect(msg).toContain("i-a2 (already tracking loom-other)");
    // The draft is NOT unwound — deleting it would be this module writing loom
    // state — so the message hands the human its address and the one act that
    // frees the rows it did mark.
    expect(msg).toContain("/looms/loom-w1");
    expect(msg).toContain("cancelling frees the marked rows");
    expect(calls.filter((c) => c.startsWith("FORBIDDEN:"))).toEqual([]);
  });

  test("an unreadable packet is reported the same way, in its own words", () => {
    trackMissing = ["i-a1"];
    const msg = refusal(() => weaveItems(["i-a1", "i-a2"]));
    expect(msg).toContain("i-a1 (no readable packet)");
    expect(msg).toContain("only 1 of them could be marked");
  });

  test("re-weaving a dead loom's row passes `replacing` through — the ONE lifted refusal", () => {
    looms["loom-earlier"] = { id: "loom-earlier", state: "failed", project: "aurora" };
    items.find((i) => i.id === "i-a1")!.tracking = { loomId: "loom-earlier", label: "old" };
    const out = weaveItems(["i-a1", "i-a2"]);
    expect(trackCalls[0]!.opts).toEqual({ replacing: ["i-a1"] });
    expect(out.tracked).toEqual(["i-a1", "i-a2"]);
    // The re-point really happened: the row now marks the NEW loom.
    expect(items.find((i) => i.id === "i-a1")!.tracking).toEqual({
      loomId: "loom-w1",
      label: "Exports: CSV + 1 more",
    });
  });
});

// ── the vacuity guard ───────────────────────────────────────────────────────

describe("the harness itself", () => {
  test("VACUITY GUARD — the @telar/core stub really is installed", async () => {
    // If the mock silently stopped applying, every assertion above would be
    // testing the real store against a real state root, and most of them would
    // still pass by accident. This one would not.
    const core = (await import("@telar/core")) as unknown as Record<string, unknown>;
    looms["loom-probe"] = { id: "loom-probe", state: "ready", project: "aurora" };
    expect((core.getLoom as (id: string) => unknown)("loom-probe")).toEqual(looms["loom-probe"]!);
    expect((core.getLoom as (id: string) => unknown)("loom-probe-nope")).toBeNull();
    expect(core.startLoomFromBundle).toBeTypeOf("function");
    expect(() => (core.startLoomFromBundle as () => void)()).toThrow("detach boundary");
  });
});
