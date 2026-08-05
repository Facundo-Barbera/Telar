// story 5.2's app-level composition layer. The underlying store primitives
// (createItem, queueSlice, reorderLane, promoteSubtask, …) already have their
// own exhaustive proof in packages/core/test/workspace-store.test.ts — this
// file proves the COMPOSITION this layer adds (getQueueView's join,
// getPacketView's lane/rank projection, splitLaneIntoNew's two-call sequence)
// and smoke-tests every pass-through so a typo in the wiring cannot hide.
//
// @ts-expect-error no @types/bun in this workspace
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "telar-workspace-api-"));
process.env.TELAR_HOME = TMP;

const {
  addItemSubtask,
  createWorkspaceItem,
  createWorkspaceLane,
  getPacketView,
  getQueueView,
  moveItemToLane,
  promoteItemSubtask,
  renameWorkspaceLane,
  reorderQueueLane,
  retireWorkspaceLane,
  splitLaneIntoNew,
  toggleItemSubtask,
  updateWorkspaceItem,
} = await import("./workspace-api");

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("getQueueView", () => {
  test("a truly fresh workspace (nothing has ever written to it) has no lanes, no desk cards, and zero counts", () => {
    // Neither readLanes nor listItems creates the store on a read — only
    // ensureWorkspace (called by createItem/createLane) seeds the "unfiled"
    // row — so a view taken before anything is ever written sees an empty
    // store exactly as it is on disk, not a lazily-materialised default.
    const view = getQueueView();
    expect(view.lanes).toEqual([]);
    expect(view.desk).toEqual([]);
    expect(view.totalItems).toBe(0);
    expect(view.agentsAdded).toBe(0);
  });

  test("rows are grouped per lane, in lane order, ranked within their own lane, and desk cards are attached separately", () => {
    const office = createWorkspaceLane({ label: "Office", window: "work hours" });
    const free = createWorkspaceLane({ label: "Free", window: "whenever" });
    const a = createWorkspaceItem({ title: "a", lane: office.key });
    const b = createWorkspaceItem({ title: "b", lane: office.key });
    const c = createWorkspaceItem({ title: "c", lane: free.key });

    const view = getQueueView();
    const officeView = view.lanes.find((l) => l.key === office.key)!;
    const freeView = view.lanes.find((l) => l.key === free.key)!;
    expect(officeView.rows.map((r) => [r.rank, r.item.id])).toEqual([
      [1, a.id],
      [2, b.id],
    ]);
    expect(freeView.rows.map((r) => [r.rank, r.item.id])).toEqual([[1, c.id]]);
    // Every item just filed sits on the desk too (AC5's "places it on the desk").
    expect(view.desk.map((d) => d.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(view.totalItems).toBe(3);
    expect(view.agentsAdded).toBe(3); // create_item stamps provenance: "session"
  });

  test("totalItems is queueSlice's row count, and does NOT grow when a sub-task is added — NFR-OW-3", () => {
    const item = createWorkspaceItem({ title: "decompose me" });
    const before = getQueueView().totalItems;
    addItemSubtask(item.id, "a step");
    expect(getQueueView().totalItems).toBe(before);
  });
});

describe("getPacketView", () => {
  test("returns null for an id that does not resolve", () => {
    expect(getPacketView("i-does-not-exist")).toBeNull();
  });

  test("reports the RECONCILED lane and rank, never the packet's own stale hint", () => {
    const office = createWorkspaceLane({ label: "Office", window: "work hours" });
    const item = createWorkspaceItem({ title: "x", lane: office.key });
    const view = getPacketView(item.id)!;
    expect(view.item.id).toBe(item.id);
    expect(view.lane).toBe(office.key);
    expect(view.rank).toBe(1);
    expect(view.attachments).toEqual({ files: 0, mockups: 0 });

    // Hand-move it out from under its own packet.lane hint — the reconciled
    // view must follow lanes.yaml, exactly like AD-6's cross-lane move.
    const free = createWorkspaceLane({ label: "Free", window: "whenever" });
    reorderQueueLane(free.key, [item.id]);
    const after = getPacketView(item.id)!;
    expect(after.lane).toBe(free.key);
    expect(after.item.lane).toBe(office.key); // the stale hint, harmlessly
  });

  test("an unfiled item's lane and rank are both null", () => {
    const item = createWorkspaceItem({ title: "orphaned" });
    const view = getPacketView(item.id)!;
    expect(view.lane).not.toBeNull();
    // Empty the row, then retire it — with the row gone entirely, the item's
    // own packet.lane hint names a lane absent from lanes.yaml (arm 3, "lane
    // gone"), which is the genuinely unfiled resting state. Emptying alone
    // would instead re-adopt it into that same still-existing row (arm 1).
    reorderQueueLane(view.lane!, []);
    expect(retireWorkspaceLane(view.lane!)).toEqual({ ok: true });
    const after = getPacketView(item.id)!;
    expect(after.lane).toBeNull();
    expect(after.rank).toBeNull();
  });
});

describe("moveItemToLane / updateWorkspaceItem — thin pass-throughs", () => {
  test("moveItemToLane changes which stack the item is reconciled into", () => {
    const office = createWorkspaceLane({ label: "Office", window: "work hours" });
    const item = createWorkspaceItem({ title: "x" });
    const moved = moveItemToLane(item.id, office.key);
    expect(moved!.lane).toBe(office.key);
    expect(getPacketView(item.id)!.lane).toBe(office.key);
  });

  test("updateWorkspaceItem forwards an arbitrary patchable field", () => {
    const item = createWorkspaceItem({ title: "x" });
    const patched = updateWorkspaceItem(item.id, { title: "renamed" });
    expect(patched!.title).toBe("renamed");
  });
});

describe("createWorkspaceLane / renameWorkspaceLane / retireWorkspaceLane — thin pass-throughs", () => {
  test("create, rename (label only) and retire (once empty) round-trip", () => {
    const made = createWorkspaceLane({ label: "Evenings", window: "after 6" });
    expect(made.key).toBe("evenings");
    const renamed = renameWorkspaceLane(made.key, "Nights");
    expect(renamed).toEqual({ ...made, label: "Nights" });
    expect(retireWorkspaceLane(made.key)).toEqual({ ok: true });
  });
});

describe("splitLaneIntoNew", () => {
  test("moves the chosen ids into a brand-new lane and leaves the rest, in order, behind", () => {
    const office = createWorkspaceLane({ label: "Office", window: "work hours" });
    const a = createWorkspaceItem({ title: "a", lane: office.key });
    const b = createWorkspaceItem({ title: "b", lane: office.key });
    const c = createWorkspaceItem({ title: "c", lane: office.key });

    const { source, created } = splitLaneIntoNew(
      office.key,
      { label: "Errands", window: "on the way" },
      [b.id],
    );
    expect(created.key).toBe("errands");
    expect(created.items).toEqual([b.id]);
    expect(source.items).toEqual([a.id, c.id]); // b removed, a/c order preserved
  });
});

describe("addItemSubtask / toggleItemSubtask / promoteItemSubtask — thin pass-throughs", () => {
  test("add, toggle and promote round-trip through the app layer exactly as the store itself proves", () => {
    const office = createWorkspaceLane({ label: "Office", window: "work hours" });
    const parent = createWorkspaceItem({ title: "parent", lane: office.key });
    const withSub = addItemSubtask(parent.id, "a step")!;
    const sub = withSub.subtasks![0]!;

    const toggled = toggleItemSubtask(parent.id, sub.id, true)!;
    expect(toggled.subtasks![0]!.done).toBe(true);

    const { parent: nextParent, promoted } = promoteItemSubtask(parent.id, sub.id)!;
    expect(nextParent.subtasks).toEqual([]);
    expect(promoted.promotedFrom).toBe(parent.id);
    expect(promoted.title).toBe("a step");
  });
});
