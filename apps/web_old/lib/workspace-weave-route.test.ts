// The weave endpoint (story 5.5 / CAP-11) — app/api/workspace/weave/route.ts.
//
// WHY THE FILE LIVES HERE and not beside the route: nothing under app/ carries a
// test in this repo (95 of them, all under lib/ and components/), and Next's own
// file conventions own that directory. The route is imported by path below, so
// moving it breaks this file loudly rather than silently orphaning it.
//
// WHAT IS ACTUALLY UNDER TEST is the thin layer the route ADDS — the verb, the
// body validation, and the 400/500 split — because everything it delegates to is
// already proved in workspace-handoff.test.ts. The split is not cosmetic: a
// HandoffRefused is the human being told their selection is floating or spans two
// projects, and the batch bar prints that sentence; a 500 is this server failing
// and must not read the same.
//
// HARNESS: workspace-handoff.test.ts's, for the same reason — mock.module is
// process-global, so the real namespace is snapshotted and restored, and the last
// test is a vacuity guard. NO STATE ROOT IS TOUCHED.
// @ts-expect-error no @types/bun in this workspace
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realCore from "@telar/core";

const realCoreSnapshot = { ...realCore };

type FakeItem = Record<string, unknown> & { id: string; title: string };

let items: FakeItem[] = [];
let looms: Record<string, { id: string; state: string; project: string }> = {};
let trackLoomThrows: Error | null = null;
const draftLoomCalls: Record<string, unknown>[] = [];

mock.module("@telar/core", () => ({
  getWorkspaceItem: (id: string) => items.find((i) => i.id === id) ?? null,
  readPacketAttachments: () => [],
  attachmentTally: () => ({ files: 0, mockups: 0 }),
  // Read-only, and the ONE loom lookup the handoff layer performs: is an
  // existing tracking ref dead? Everything here is live-or-absent, which is the
  // ordinary case this suite is about.
  getLoom: (id: string) => looms[id] ?? null,
  isTerminalWorkUnitState: (s: string) =>
    s === "done" || s === "halted" || s === "failed" || s === "skipped",
  createDraftLoom: (input: Record<string, unknown>) => {
    draftLoomCalls.push(input);
    return { id: "loom-w1", draft: true, state: "queued" };
  },
  writeBundleFile: () => {},
  updateDraftObjectiveFromBundle: () => {},
  trackLoom: (ids: string[], ref: Record<string, unknown>) => {
    if (trackLoomThrows) throw trackLoomThrows;
    const tracked: FakeItem[] = [];
    for (const id of ids) {
      const item = items.find((i) => i.id === id);
      if (!item) continue;
      item.tracking = ref;
      tracked.push(item);
    }
    return { tracked, missing: [], alreadyTracking: [] };
  },
}));

afterAll(() => {
  mock.module("@telar/core", () => realCoreSnapshot);
});

const route = (await import("../app/api/workspace/weave/route")) as unknown as {
  POST: (req: Request) => Promise<Response>;
  GET?: unknown;
  dynamic: string;
};

const post = (body: unknown, raw?: string) =>
  route.POST(
    new Request("http://telar.local/api/workspace/weave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
  );

beforeEach(() => {
  items = [
    {
      id: "i-a1",
      title: "Exports: CSV",
      project: "aurora",
      provenance: "note",
      captured: "Tue 16:42",
      schemaVersion: 1,
      fixed: "Stream the CSV export.",
      acceptance: ["a 200k-row account exports"],
    },
    {
      id: "i-a2",
      title: "Exports: XLSX",
      project: "aurora",
      provenance: "note",
      captured: "Tue 16:44",
      schemaVersion: 1,
      fixed: "And the spreadsheet one.",
    },
    {
      id: "i-f1",
      title: "A floating note",
      provenance: "note",
      captured: "Wed 11:02",
      schemaVersion: 1,
    },
  ];
  looms = { "loom-earlier": { id: "loom-earlier", state: "running", project: "aurora" } };
  draftLoomCalls.length = 0;
  trackLoomThrows = null;
});

describe("POST /api/workspace/weave — the effect, and the only verb", () => {
  test("weaves the posted selection and returns the receipt the surfaces render", async () => {
    const res = await post({ itemIds: ["i-a1"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.loomId).toBe("loom-w1");
    expect(body.url).toBe("/looms/loom-w1");
    expect(body.tracked).toEqual(["i-a1"]);
    // The receipt comes back as DATA, not as a rendered line: the ONE renderer
    // (components/common/detach-receipt.tsx) draws it, so the route never
    // spells the sentence itself.
    expect(body.receipt).toEqual({
      loomId: "loom-w1",
      premise: "the fixed brief + acceptance criteria",
      context: "no attachments",
      origin: "the workspace",
      note: expect.stringContaining("leaves when the loom lands and you accept"),
    });
    // THE ROW STAYS, wearing its mark (CAP-11).
    expect(items.find((i) => i.id === "i-a1")!.tracking).toEqual({
      loomId: "loom-w1",
      label: "Exports: CSV",
    });
  });

  test("THERE IS NO GET — the proposal is the ApprovalCard or the human's own click", () => {
    // A preview endpoint with no reader is a second definition of the plan. See
    // the route's header: the agent path proposes through weave_batch (whose
    // input the shared ApprovalCard renders before the tool runs) and the human
    // path IS the approval.
    expect(route.GET).toBeUndefined();
    expect(route.dynamic).toBe("force-dynamic");
  });

  test("a refusal is a 400 carrying the handoff's own sentence, verbatim", async () => {
    // The message is the product — the batch bar prints exactly this, including
    // the equal alternative CAP-11 requires ("start a session instead").
    const res = await post({ itemIds: ["i-f1"] });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain('"A floating note"');
    expect(error).toContain("start a session instead");
    expect(draftLoomCalls).toEqual([]);
  });

  test("a genuine server failure is a 500 — the two must not read the same to a surface", async () => {
    trackLoomThrows = new Error("packet i-a1 is not where lanes.yaml says it is");
    const res = await post({ itemIds: ["i-a1"] });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("not where lanes.yaml says it is");
  });

  test("a body that is not a list of ids is refused before anything is planned", async () => {
    for (const body of [{}, { itemIds: "i-a1" }, { itemIds: [1, 2] }, { itemIds: null }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("itemIds must be an array of");
    }
    // Unparseable JSON takes the same door rather than throwing out of the handler.
    const broken = await post(undefined, "{not json");
    expect(broken.status).toBe(400);
    expect(draftLoomCalls).toEqual([]);
  });

  test("the list is BOUNDED, at both scales, and the refusal names both bounds", async () => {
    // A weave reads one packet directory per id and writes all of them into one
    // objective.md, so an unbounded array is 2N disk reads and a bundle file
    // nothing can read; a megabyte-long "id" is not a typo. Both refusals land
    // before planWeave runs, so nothing is read and no draft is made.
    const tooMany = await post({ itemIds: Array.from({ length: 101 }, (_, n) => `i-${n}`) });
    expect(tooMany.status).toBe(400);
    const msg = (await tooMany.json()).error;
    expect(msg).toContain("at most 100");
    expect(msg).toContain("at most 200 characters");

    const tooLong = await post({ itemIds: ["a".repeat(201)] });
    expect(tooLong.status).toBe(400);
    expect(draftLoomCalls).toEqual([]);

    // The bounds are ceilings, not fenceposts: exactly at the limit still works
    // — proved on the id length, since 100 real items would need 100 fixtures.
    items.push({
      id: "b".repeat(200),
      title: "Long id",
      project: "aurora",
      provenance: "note",
      captured: "Wed 12:00",
      schemaVersion: 1,
    });
    expect((await post({ itemIds: ["b".repeat(200)] })).status).toBe(200);
  });

  test("no identity is read from the body — this route stamps no provenance because it commits nothing", async () => {
    // AD-1/AD-10: the human's click is the provenance stamp, and it is recorded
    // where the commit happens (§M.6, the loom side), not here. A `by` in the
    // body is ignored rather than trusted, and `account` is not a field this
    // route forwards either.
    await post({ itemIds: ["i-a1"], by: "someone-else", account: "not-mine", project: "office" });
    expect(draftLoomCalls.length).toBe(1);
    expect(Object.keys(draftLoomCalls[0]!).sort()).toEqual(["objective", "project", "title"]);
    expect(draftLoomCalls[0]!.project).toBe("aurora"); // from the ITEM, not the body
  });

  test("title and reason ride along only when they carry something", async () => {
    // Whitespace is not a title. Passing `"  "` through would name the loom with
    // a blank instead of falling back to the packet's own title, and the fallback
    // is the whole reason both fields are optional.
    //
    // TWO DIFFERENT ROWS on purpose: re-posting i-a1 would be REFUSED, because
    // the first call marked it as tracking loom-w1 and a tracked row is never
    // re-pointed (proved in workspace-handoff.test.ts). That refusal is correct
    // and load-bearing; it is just not what this test is about.
    await post({ itemIds: ["i-a1"], title: "  ", reason: "   " });
    expect(draftLoomCalls[0]!.title).toBe("Exports: CSV");
    await post({ itemIds: ["i-a2"], title: "Exports series", reason: "one shape, two formats" });
    expect(draftLoomCalls[1]!.title).toBe("Exports series");
    expect(draftLoomCalls[1]!.objective).toContain("one shape, two formats");
  });
});

describe("the harness itself", () => {
  test("VACUITY GUARD — the @telar/core stub really is installed", async () => {
    const core = (await import("@telar/core")) as unknown as Record<string, unknown>;
    expect((core.getWorkspaceItem as (id: string) => unknown)("i-a1")).toBe(
      items.find((i) => i.id === "i-a1")!,
    );
    expect((core.getWorkspaceItem as (id: string) => unknown)("i-nope")).toBeNull();
  });
});
