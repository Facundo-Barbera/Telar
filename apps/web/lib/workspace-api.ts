// The Workspace surface's business-logic layer (story 5.2, CAP-4/CAP-5/CAP-6).
//
// Route handlers under app/api/workspace/** stay thin — the same "delegate
// straight to a tested function" shape apps/web/app/api/looms/route.ts already
// uses for startLoom/listLooms — and every function here either delegates
// straight through to one @telar/core/workspace primitive, or composes more
// than one of them for a shape the store itself has no reason to own (a
// "queue view" that joins every lane's rows is a RENDERING concern, not a
// storage one; splitLaneIntoNew has no state once it is done, so it is not a
// fourth lane-structure primitive — it is createLane followed by two
// reorderLane calls).
//
// NONE OF THIS IS REACHABLE FROM AN MCP TOOL. Story 5.2 left
// apps/web/lib/workspace-mcp.ts's four tools (list_items, list_lanes,
// create_item, update_item) untouched; story 5.8 added a fifth, consult_expert,
// whose ENTIRE input is an item id — see that file's own header and INV-11's
// pinned inventory. Lane structure, sub-task promotion and the human's verdict
// override are human-only (NFR-OW-10, NFR-OW-15, CAP-9) by construction:
// nothing in the tool-facing surface names any function this file exports.
import {
  addSubtask,
  agentsAddedCount,
  attachmentTally,
  createItem,
  createLane,
  deskSlice,
  getWorkspaceItem,
  listItems,
  promoteSubtask,
  queueSlice,
  readLanes,
  readPacketAttachments,
  renameLane,
  reorderLane,
  retireLane,
  setItemVerdict,
  setSubtaskDone,
  updateItem,
  type DeskCard,
  type Item,
  type ItemPatch,
  type ItemVerdict,
  type NewItem,
  type WorkspaceLane,
} from "@telar/core";

// ── the queue surface (CAP-4) ─────────────────────────────────────────────────

export type QueueLaneView = {
  key: string;
  label: string;
  window: string;
  note?: string;
  rows: Array<{ rank: number; item: Item }>;
};

export type QueueView = {
  lanes: QueueLaneView[];
  desk: DeskCard[];
  // The queue footer's conservation line: "N items — every one traces to
  // something you fed in or a mirror · agents added M · sub-tasks live inside
  // items, the count never grows from breakdown". `totalItems` is the row
  // count queueSlice returns (NFR-OW-3: never items-plus-subtasks); items with
  // no stack at all (arm 3, "lane gone", or a brand-new unplaced capture) are
  // NOT in `totalItems` — they surface on the desk instead, which is exactly
  // what deskSlice's `unplaced` hint is for.
  totalItems: number;
  agentsAdded: number;
};

// One read of the store, reshaped into "every lane, in order, with its own
// rows already attached" — the join queueSlice deliberately does NOT do
// (queueSlice returns a flat row list so its own conservation-count test stays
// a one-line length assertion; grouping by lane is a rendering concern this
// layer owns instead).
export function getQueueView(): QueueView {
  const lanes = readLanes();
  const { items } = listItems();
  const rows = queueSlice(lanes, items);
  const byLane = new Map<string, QueueLaneView>(
    lanes.map((l) => [
      l.key,
      { key: l.key, label: l.label, window: l.window, ...(l.note ? { note: l.note } : {}), rows: [] },
    ]),
  );
  for (const row of rows) {
    byLane.get(row.lane)?.rows.push({ rank: row.rank, item: row.item });
  }
  return {
    lanes: lanes.map((l) => byLane.get(l.key)!),
    desk: deskSlice(items),
    totalItems: rows.length,
    agentsAdded: agentsAddedCount(items),
  };
}

// ── the packet surface (CAP-6) ────────────────────────────────────────────────

export type PacketView = {
  item: Item;
  // Where it currently sits, per the RECONCILED projection (queueSlice), never
  // the packet's own `lane` recovery hint — the same authority D9 gives
  // lanes.yaml everywhere else in this store. Both null when the item is
  // unfiled.
  lane: string | null;
  rank: number | null;
  attachments: { files: number; mockups: number };
};

export function getPacketView(id: string): PacketView | null {
  const item = getWorkspaceItem(id);
  if (!item) return null;
  const rows = queueSlice(readLanes(), listItems().items);
  const row = rows.find((r) => r.item.id === id);
  return {
    item,
    lane: row?.lane ?? null,
    rank: row?.rank ?? null,
    attachments: attachmentTally(readPacketAttachments(id)),
  };
}

// ── capture and edit ──────────────────────────────────────────────────────────

export function createWorkspaceItem(input: NewItem): Item {
  return createItem(input);
}

export function updateWorkspaceItem(id: string, patch: ItemPatch): Item | null {
  return updateItem(id, patch);
}

export function moveItemToLane(id: string, lane: string): Item | null {
  return updateItem(id, { lane });
}

// ── lane structure (CAP-4, NFR-OW-10 — human-only) ────────────────────────────

export function reorderQueueLane(key: string, orderedItemIds: string[]): WorkspaceLane {
  return reorderLane(key, orderedItemIds);
}

export function createWorkspaceLane(input: { label: string; window: string; note?: string }): WorkspaceLane {
  return createLane(input);
}

export function renameWorkspaceLane(key: string, label: string): WorkspaceLane | null {
  return renameLane(key, label);
}

export function retireWorkspaceLane(key: string): { ok: true } | { ok: false; reason: string } {
  return retireLane(key);
}

// Split part of one lane's stack into a brand-new one. Composed rather than a
// third store primitive: creating the lane and moving the chosen ids is the
// entire operation, and reorderLane already carries the "must resolve to a
// readable packet or nothing is written" guarantee for the move half. The
// SOURCE lane's remaining order is preserved (only the moved ids drop out).
export function splitLaneIntoNew(
  sourceKey: string,
  input: { label: string; window: string; note?: string },
  moveItemIds: string[],
): { source: WorkspaceLane; created: WorkspaceLane } {
  const before = readLanes().find((l) => l.key === sourceKey);
  const created = reorderLane(createLane(input).key, moveItemIds);
  const remaining = (before?.items ?? []).filter((id) => !moveItemIds.includes(id));
  const source = reorderLane(sourceKey, remaining);
  return { source, created };
}

// ── sub-tasks and promotion (CAP-5, NFR-OW-3/NFR-OW-15) ───────────────────────

export function addItemSubtask(id: string, title: string): Item | null {
  return addSubtask(id, title);
}

export function toggleItemSubtask(id: string, subtaskId: string, done: boolean): Item | null {
  return setSubtaskDone(id, subtaskId, done);
}

// THE ONE PLACE THIS LAYER TOUCHES PROMOTION, and it is only ever called from
// a route handler behind a human's own click — never from anything an agent's
// tool surface can reach. See store.ts's promoteSubtask for why the promoted
// item is deliberately not shaped like a create_item item.
export function promoteItemSubtask(
  id: string,
  subtaskId: string,
): { parent: Item; promoted: Item } | null {
  return promoteSubtask(id, subtaskId);
}

// ── the human's own verdict (CAP-9, story 5.8) ────────────────────────────────

// THE OTHER HALF OF "THE VERDICT IS ADVISORY", and the only door to it. An
// expert's verdict arrives through core's applyExpertPass (lib/workspace-expert.ts
// dispatches the pass); THIS is the human overruling it, and item-model.md says
// what that has to mean: "A human override is durable and is not re-flipped by a
// later expert pass." core's setItemVerdict is what makes it durable — it is the
// only writer of `verdictOverride`, `verdictOverride` is absent from ItemPatch,
// and updateItem THROWS rather than letting the generic patch verb walk one
// back.
//
// SAME SHAPE AS promoteItemSubtask ABOVE, AND FOR THE SAME REASON: it is reached
// only from a route handler behind a human's own click. Nothing on the MCP
// surface names this function — workspace-mcp.ts's consult_expert takes an item
// id and nothing else, so no tool can spell a verdict at all, let alone a
// durable one.
export function recordHumanVerdict(id: string, verdict: ItemVerdict): Item | null {
  return setItemVerdict(id, verdict);
}
