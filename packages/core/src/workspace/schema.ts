// The workspace store's persisted shapes (SPEC-organization-workspace's
// item-model.md, AD-6/AD-7/NFR-X-5). Full design reasoning — why these
// schemas live here rather than in schemas.ts or beside the MCP server, the
// rank/lanes.yaml contradiction and how it is resolved, and the
// z.looseObject tolerance argument — lives in
// docs/workspace-item-schema-design.md; keep this file to point-of-use notes
// only.
//
// `z.looseObject`, NOT `z.object`, on every shape a packet.yaml nests
// (Item, Deadline, Subtask, TimelineEvent, LoomRef). Do not "tidy" any of
// these to z.object: a strict nested shape silently DESTROYS an unknown key
// on the next updateItem, which a strict top-level Item would not — see the
// doc for why that asymmetry is worse than being strict everywhere.
// WorkspaceLane is deliberately the one shape here that stays z.object: it
// is not part of a packet.
import { z } from "zod";

// ── the nested shapes ────────────────────────────────────────────────────────

// item-model.md § Deadline. `label` is coarse human text ("Fri", "Sep 2") and
// is NEVER a date to compare — NFR-OW-11 forbids clocks and scheduling, and
// this store performs no comparison on it anywhere.
export const DeadlineKind = z.enum(["external", "self"]);
export type DeadlineKind = z.infer<typeof DeadlineKind>;

export const Deadline = z.looseObject({
  label: z.string(),
  kind: DeadlineKind,
  // Self-deadlines only: how often this slid (CAP-7's witness). A witness,
  // never an alarm — nothing here schedules on it.
  slips: z.number().optional(),
});
export type Deadline = z.infer<typeof Deadline>;

// Sub-tasks per item-model.md's Item table are `{title, done}[]`; `id` is a
// disclosed addition, forced because `promotedFrom` (below) names a PARENT
// ITEM and a title is not a stable address.
export const Subtask = z.looseObject({
  id: z.string(),
  title: z.string(),
  done: z.boolean().optional(),
});
export type Subtask = z.infer<typeof Subtask>;

// item-model.md's Packet table gives `actor ∈ you | expert | bed`. `session`
// is a disclosed widening by one member (5.4's per-project session agent) —
// AD-7's tolerant readers absorb it; a renderer meeting an unknown actor
// shows a neutral icon rather than throwing.
export const PacketActor = z.enum(["you", "expert", "bed", "session"]);
export type PacketActor = z.infer<typeof PacketActor>;

// item-model.md's Packet table: `{at, actor, text, proposal?}`. `at` is a
// display label, same class as Item.captured below — never a comparable
// stamp. `proposal: true` marks agent output awaiting a human look
// (NFR-OW-2).
export const TimelineEvent = z.looseObject({
  at: z.string(),
  actor: PacketActor,
  text: z.string(),
  proposal: z.boolean().optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

// AD-8/NFR-X-7 — cross-tree references are WEAK: an id plus enough label to
// render without a lookup, so a dangling ref renders as a tombstone and never
// throws. Set at weave; NO TOOL IN THIS STORY WRITES IT (story 5.5 owns the
// handoff), and it is absent from ItemPatch so no tool CAN.
export const LoomRef = z.looseObject({
  loomId: z.string(),
  label: z.string().optional(),
});
export type LoomRef = z.infer<typeof LoomRef>;

// Expert triage, item-model.md's Item table: "Advisory — informs the handoff
// choice, does not perform it." Named ItemVerdict rather than `Verdict`
// because schemas.ts already exports `Verdict` and a barrel export would
// collide (same reason WorkspaceLane below isn't named `Lane`).
export const ItemVerdict = z.enum(["session", "loom"]);
export type ItemVerdict = z.infer<typeof ItemVerdict>;

// ── lanes.yaml ───────────────────────────────────────────────────────────────

// Named WorkspaceLane, not Lane, as a COMPILER CONSTRAINT: run-server.ts
// already exports `type Lane`, star-exported from index.ts, and a second one
// is `error TS2308` — the barrel would not compile.
//
// `items` is an ORDERED ARRAY OF ITEM IDS, not embedded items — deliberately
// disagreeing with the design-source fixtures, whose WsLane.items is the
// RENDERED join. Storing embedded items would give membership two sources of
// truth.
//
// NO `version` FIELD, and the absence is the assertion: AD-7's schema
// version + migrate-on-read is for stores holding unrecoverable human input;
// lanes.yaml is re-derivable structure. workspace-store.test.ts asserts the
// asymmetry with Item below in both directions.
export const WorkspaceLane = z.object({
  // User-defined. Lanes are DATA, never an enum (NFR-OW-10).
  key: z.string(),
  label: z.string(),
  // Coarse and shifting ("work hours", "evenings", "whenever") — never a
  // schedule.
  window: z.string(),
  // Structural provenance: "split from Office — you accepted Mon". A lane
  // created by an accepted master proposal says so, permanently.
  note: z.string().optional(),
  // The ordered stack. Position in THIS array is the item's rank (1-based,
  // via store.ts's rankOf) — see docs/workspace-item-schema-design.md for why
  // rank is not persisted per item.
  items: z.array(z.string()).default([]),
});
export type WorkspaceLane = z.infer<typeof WorkspaceLane>;

// ── packets/<item-id>/packet.yaml ────────────────────────────────────────────

// The version this build WRITES. migratePacket (store.ts) refuses to read
// anything above it rather than guessing, because a packet.yaml holds `raw`
// verbatim and has no source to be rebuilt from.
export const ITEM_SCHEMA_VERSION = 1;

// ONE SHAPE FOR ALL ITEMS (AC2): a bare one-line todo and a fully ripened
// work packet are the SAME schema — "a packet is not a different entity; it
// is an item that grew attachments" (item-model.md). So there is no second
// reader, writer or migration when an item ripens; a nested `packet` record
// would re-introduce the two-shape split by the back door.
//
// `packet` (the {files, mockups} tally) IS NOT PERSISTED HERE — it is
// derived at read time by store.ts's attachmentTally, which is what keeps
// "growing attachments needs no migration" true by construction.
//
// NO status, state, done OR accepted FIELD EXISTS ON THIS TYPE. The absence
// is the Human-Accept Moat expressed in the schema (AD-1/AD-10, AC8 proof
// 1); workspace-mcp.test.ts asserts no tool input shape carries one either.
// Full reasoning for every field below: docs/workspace-item-schema-design.md
export const Item = z.looseObject({
  // Minted, NEVER derived from position (store.ts's newItemId) — an id
  // derived from a lane index breaks the moment the stack reorders.
  id: z.string(),
  // Always present, even for a rich packet.
  title: z.string(),
  // How it got in ("note", "pasted transcript", "chat", "mirror sync", "loom
  // event", "session"). NFR-OW-12: a FREE-FORM LABEL, NOT AN ENUM.
  provenance: z.string(),
  // When it entered, as a DISPLAY LABEL ("Tue 16:42"), matching the
  // fixtures' WsItem.captured. NFR-OW-11: never a scheduling input — nothing
  // here parses, compares or sorts on it; order is stack position, always.
  captured: z.string(),
  // AD-7's version field, on this store and not on lanes.yaml. Absent
  // normalises to 1 inside migratePacket BEFORE any comparison — the common
  // case for a hand-authored packet.yaml.
  schemaVersion: z.number().default(ITEM_SCHEMA_VERSION),
  // DISCLOSED ADDITION — the RECOVERY HINT of the reconcile rule. lanes.yaml
  // is authoritative for membership/order; consulted only when the id
  // appears in no stack (torn-write case). Optional: absent means unfiled, a
  // resting state, not an error.
  lane: z.string().optional(),
  // DISCLOSED ADDITION — "on the workspace desk". A boolean on the item
  // rather than a second store, per item-model.md's Desk-item description.
  // Cleared by updateItem({desk: false}).
  desk: z.boolean().optional(),
  // From item-model.md's Desk-item block: "the master could not file it and
  // is asking". Renders as a question, not a failure.
  unplaced: z.boolean().optional(),
  // ABSENT = FLOATING, and floating is a valid resting state (item-model.md)
  // — a project-scoped slice excludes it rather than treating it as a
  // failure.
  project: z.string().optional(),
  // Foreign issue ref, e.g. "#214". Present = Telar holds a view only and the
  // foreign tracker stays source of truth.
  mirrored: z.string().optional(),
  deadline: Deadline.optional(),
  verdict: ItemVerdict.optional(),
  // The conservation valve (NFR-OW-3): decomposition lives INSIDE the item,
  // so breaking work down never grows the queue count.
  subtasks: z.array(Subtask).optional(),
  // Parent item id, when this item began as a sub-task. NFR-OW-15: "Agents
  // have no promotion path, proposed or otherwise" — the field exists
  // because the shape contract requires it, but it is absent from ItemPatch
  // so no tool can write it (AC8 proof 3).
  promotedFrom: z.string().optional(),
  // Set at weave (story 5.5). No tool in this story writes it.
  tracking: LoomRef.optional(),
  // ── the Packet table: the ripening history CAP-6 describes ──
  // NEVER OVERWRITTEN BY ANY WRITE PATH (AC9, NFR-OW-19) — "keeping raw
  // beside fixed is load-bearing: it lets the user check the expert did not
  // drift from what they meant." ItemPatch cannot express a change to
  // either field.
  raw: z.string().optional(),
  rawSource: z.string().optional(),
  // The expert-written brief that replaced the shorthand. 5.4's to write.
  fixed: z.string().optional(),
  // Criteria the work must meet — this plus `fixed` is the loom's premise.
  acceptance: z.array(z.string()).optional(),
  timeline: z.array(TimelineEvent).optional(),
});
export type Item = z.infer<typeof Item>;
