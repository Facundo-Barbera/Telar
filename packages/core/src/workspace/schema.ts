// The workspace store's persisted shapes (SPEC-organization-workspace's
// item-model.md, AD-6/AD-7/NFR-X-5).
//
// WHY THEY LIVE IN CORE AND NOT BESIDE THE MCP SERVER. NFR-X-5: "zod schemas
// for persisted entities are owned by @telar/core and never redefined in
// apps/web." apps/web/lib/workspace-mcp.ts therefore declares NO entity schema
// at all — its tool() input shapes are ARGUMENT schemas (what a caller may
// pass), structurally unrelated to Item (what is on disk). INV-11 arm 5 asserts
// that separation as source text.
//
// WHY THEY LIVE IN workspace/schema.ts AND NOT IN schemas.ts. schemas.ts is the
// general persisted-entity home, but two documented exceptions already exist for
// the same reason this one does — verification-strategy.ts ("lives here, NOT in
// schemas.ts, per the M11 contract") and ultra/wake.ts's UltraWakeRecord: a
// subtree with its own owning module keeps its shapes beside that module, so the
// owner and the shape move together. AD-5 gives workspace/ exactly one owning
// module; this directory is it.
//
// ── THE ONE CONTRADICTION IN THE SHAPE CONTRACT, AND HOW IT IS RESOLVED ──────
// item-model.md's Storage section says a packet.yaml "owns the item and knows
// nothing about its rank"; its Item table three sections later lists `rank` as
// an item field. Both cannot ship. `rank` IS NOT A FIELD HERE: lanes.yaml owns
// membership and order, and rank is a read-time projection (store.ts's rankOf,
// 1-based). The deciding argument is item-model.md's own stated benefit —
// "Reordering rewrites one small file" is FALSE if rank is persisted per item,
// because reordering a ten-item lane would then rewrite ten packet.yaml files.
//
// ── TOLERANCE IS z.looseObject, NOT z.object, AND THAT IS LOAD-BEARING ───────
// AD-7 wants readers that "absorb unknown and missing fields". Missing fields
// are handled by .default()/.optional() — ultra/wake.ts's UltraWakeRecord is the
// model for that half. UNKNOWN fields are NOT: that header states plainly that
// "zod strips unknown keys rather than rejecting them", and stripping is the
// opposite of absorbing. A packet.yaml written by a NEWER Telar, read by this
// one and rewritten by updateItem, would silently LOSE every field this version
// does not know — destroying exactly the unrecoverable human input the
// schemaVersion field below exists to protect. Measured against the installed
// zod (4.4.3): z.object({a}).parse({a,unknown}) drops `unknown`;
// z.looseObject({a}).parse({a,unknown}) keeps it. This is the repo's first
// loose schema; grep for passthrough(/catchall(/looseObject across
// packages/core/src, apps/web/lib and apps/web/app returned zero before it.
//
// IT IS APPLIED AT EVERY LEVEL OF THE PACKET, NOT ONLY THE TOP, and the
// difference is observable rather than theoretical: with a loose `Item` over
// strict nested shapes, a key hand-added under `deadline:` is DESTROYED by the
// next updateItem while a top-level one survives — so "unknown fields survive a
// round-trip" would be true one level deep and false everywhere else, which is
// the worst of the three possible states because it looks like the good one.
// Every shape a packet.yaml nests (Deadline, Subtask, TimelineEvent, LoomRef) is
// therefore loose too. WorkspaceLane below is deliberately NOT: it is the one
// shape here that is not part of a packet.
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
  // Self-deadlines only: how often this slid. Durable, which is what makes
  // CAP-7's witness possible ("you told yourself Friday, and it has slid
  // twice"). A witness, never an alarm — nothing here schedules on it.
  slips: z.number().optional(),
});
export type Deadline = z.infer<typeof Deadline>;

// item-model.md's Item table writes sub-tasks as `{title, done}[]` and the
// design-source fixtures (apps/web/lib/demo-gallery/workspace/fixtures.ts's
// WsItem.subtasks) agree. `id` IS A DISCLOSED ADDITION and it is forced twice:
// `promotedFrom` names a PARENT ITEM, so a promoted sub-task must be
// addressable, and a title is not an address — a rename or a duplicate title
// breaks the reference. Story 5.1 adds the field and writes no sub-task; 5.2
// owns sub-task mutation and the human owns promotion (NFR-OW-15).
export const Subtask = z.looseObject({
  id: z.string(),
  title: z.string(),
  done: z.boolean().optional(),
});
export type Subtask = z.infer<typeof Subtask>;

// item-model.md's Packet table gives `actor ∈ you | expert | bed`. `session` is
// a DISCLOSED WIDENING BY ONE MEMBER: a project session's agent is none of the
// three, and reusing `expert` would falsely attribute the work to the
// per-project expert — 5.4's entity, whose "reasoning recorded as a timeline
// event" is CAP-9's own success clause. AD-7's tolerant readers absorb the new
// member; a renderer meeting an unknown actor shows a neutral icon rather than
// throwing.
export const PacketActor = z.enum(["you", "expert", "bed", "session"]);
export type PacketActor = z.infer<typeof PacketActor>;

// item-model.md's Packet table: `{at, actor, text, proposal?}`. `at` is a
// display label of the same class as Item.captured below — the fixtures'
// PacketEvent.at is a plain string ("Tue 16:42"), never a comparable stamp.
// `proposal: true` marks agent output awaiting a human look, which is the
// prepare-never-commit law (NFR-OW-2) made visible.
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
// choice, does not perform it." Named ItemVerdict rather than `Verdict` because
// packages/core/src/schemas.ts already exports `Verdict` and this barrel would
// then carry two (the same class of collision that forces WorkspaceLane below).
export const ItemVerdict = z.enum(["session", "loom"]);
export type ItemVerdict = z.infer<typeof ItemVerdict>;

// ── lanes.yaml ───────────────────────────────────────────────────────────────

// NAMED WorkspaceLane, NOT Lane, AND THAT IS A COMPILER CONSTRAINT RATHER THAN
// A STYLE CHOICE. packages/core/src/run-server.ts exports `type Lane`, and
// packages/core/src/index.ts carries `export * from "./run-server"`. A second
// star-exported `Lane` is `error TS2308: Module "./x" has already exported a
// member named 'Lane'` — the barrel would not compile at all.
//
// `items` IS AN ORDERED ARRAY OF ITEM IDS, NOT EMBEDDED ITEMS, and this is
// where the store deliberately disagrees with the design-source fixtures.
// fixtures.ts's WsLane.items is WsItem[] — that is the RENDERED shape, the
// join a surface receives after queueSlice runs. Storing it that way would put
// every item's content in a file whose stated benefit is being small, and would
// give membership two sources of truth.
//
// NO `version` FIELD, AND THE ABSENCE IS THE ASSERTION. AD-7 puts a schema
// version and a real migrate-on-read ONLY on stores holding unrecoverable human
// input, naming workspace/packets/<id>/packet.yaml "above all". lanes.yaml
// holds structure, which is re-derivable from the packets themselves; the
// asymmetry between this schema and Item below is AD-7's rule made structural,
// and workspace-store.test.ts asserts it in BOTH directions.
export const WorkspaceLane = z.object({
  // User-defined. Lanes are DATA, never an enum (NFR-OW-10) — the user splits,
  // renames and retires them as life demands, and no tool in this story does
  // any of those things.
  key: z.string(),
  label: z.string(),
  // Coarse and shifting ("work hours", "evenings", "whenever") — a description
  // of when this lane's work tends to happen, never a schedule.
  window: z.string(),
  // Structural provenance: "split from Office — you accepted Mon". A lane
  // created by an accepted master proposal says so, permanently.
  note: z.string().optional(),
  // The ordered stack. Position in THIS array is the item's rank (1-based, via
  // store.ts's rankOf). Reordering rewrites this one small file and touches no
  // packet.yaml — which is the whole reason rank is not persisted per item.
  items: z.array(z.string()).default([]),
});
export type WorkspaceLane = z.infer<typeof WorkspaceLane>;

// ── packets/<item-id>/packet.yaml ────────────────────────────────────────────

// The version this build WRITES. migratePacket (store.ts) refuses to read
// anything above it rather than guessing, because a packet.yaml holds `raw`
// verbatim and has no source to be rebuilt from.
export const ITEM_SCHEMA_VERSION = 1;

// ONE SHAPE FOR ALL ITEMS (AC2). A bare one-line todo and a fully ripened work
// packet are the SAME schema — item-model.md: "A packet is not a different
// entity; it is an item that grew attachments." So there is no second reader,
// no second writer, and no migration when an item ripens. The flat union of
// item-model.md's Item table and its Packet table is what makes that true;
// a nested `packet` record would have re-introduced the two-shape split by
// the back door.
//
// `packet` (the {files, mockups} tally) IS NOT PERSISTED HERE. It is derived at
// read time from the directory listing by store.ts's attachmentTally, which is
// what keeps "an item growing attachments needs no migration" true BY
// CONSTRUCTION rather than by discipline: dropping a file beside packet.yaml
// changes the tally and rewrites nothing.
//
// NO status, state, done OR accepted FIELD EXISTS ON THIS TYPE, and the absence
// is the Human-Accept Moat expressed in the schema rather than in a comment
// about the schema (AD-1/AD-10, AC8 proof 1). There is nothing in
// item-model.md to transition, and no tool input shape carries such a key
// either; workspace-mcp.test.ts asserts both halves.
export const Item = z.looseObject({
  // Minted, NEVER derived from position (store.ts's newItemId). An id derived
  // from a lane index or a count breaks the moment the stack is reordered —
  // the one operation this store exists to make cheap.
  id: z.string(),
  // Always present, even for a rich packet.
  title: z.string(),
  // How it got in ("note", "pasted transcript", "chat", "mirror sync", "loom
  // event", "session"). NFR-OW-12: a FREE-FORM LABEL, NOT AN ENUM — there is
  // deliberately no channel type to switch on, so narrowing this to a union
  // would violate the constraint rather than tighten the schema.
  provenance: z.string(),
  // When it entered, as a DISPLAY LABEL ("Tue 16:42"), matching the fixtures'
  // WsItem.captured exactly. NFR-OW-11: never a scheduling input. Nothing in
  // this module or in store.ts ever parses, compares or sorts on it — order is
  // stack position, always.
  captured: z.string(),
  // AD-7's version field, on this store and not on lanes.yaml. Absent
  // normalises to 1 inside migratePacket BEFORE any comparison, which is the
  // common case for a hand-authored packet.yaml — a file AD-6 explicitly
  // invites a human to edit.
  schemaVersion: z.number().default(ITEM_SCHEMA_VERSION),
  // DISCLOSED ADDITION — the RECOVERY HINT of the reconcile rule. lanes.yaml is
  // authoritative for membership and order; this is consulted ONLY when the id
  // appears in no stack at all (the torn-write case). Optional, because a
  // hand-authored packet.yaml may legitimately omit it — such an item is
  // unfiled, which is a resting state and not an error.
  lane: z.string().optional(),
  // DISCLOSED ADDITION — "on the workspace desk". item-model.md calls the Desk
  // item "a projection of an item the agents just touched, not a separate
  // store", so a boolean ON the item honours that where a second store would
  // not. Needed separately from queue membership because CAP-3 requires
  // dismissal to be separately mutable. Cleared by updateItem({desk: false}).
  desk: z.boolean().optional(),
  // From item-model.md's Desk-item block: "the master could not file it and is
  // asking". Persisted on the item so deskSlice can emit it from item fields
  // alone, and so 5.4's receipt has a home. Renders as a question, not a
  // failure.
  unplaced: z.boolean().optional(),
  // ABSENT = FLOATING, and floating is a valid resting state rather than an
  // error (item-model.md). A project-scoped slice EXCLUDES a floating item; it
  // never treats one as a failure.
  project: z.string().optional(),
  // Foreign issue ref, e.g. "#214". Present = Telar holds a view only and the
  // foreign tracker stays source of truth.
  mirrored: z.string().optional(),
  deadline: Deadline.optional(),
  verdict: ItemVerdict.optional(),
  // The conservation valve (NFR-OW-3): decomposition lives INSIDE the item, so
  // breaking work down never grows the queue count. queueSlice returns items,
  // never items-plus-subtasks, and its test asserts the count is unchanged when
  // sub-tasks are added.
  subtasks: z.array(Subtask).optional(),
  // Parent item id, when this item began as a sub-task. NFR-OW-15: "Agents have
  // no promotion path, proposed or otherwise." The field exists because the
  // shape contract requires it; NO TOOL INPUT SHAPE CAN WRITE IT, which is the
  // executable half (it is absent from ItemPatch, and AC8 proof 3 asserts that
  // against the pinned type rather than against whatever a handler happens to
  // accept today).
  promotedFrom: z.string().optional(),
  // Set at weave (story 5.5). No tool in this story writes it.
  tracking: LoomRef.optional(),
  // ── the Packet table: the ripening history CAP-6 describes ──
  // NEVER OVERWRITTEN BY ANY WRITE PATH (AC9, NFR-OW-19). item-model.md:
  // "Keeping `raw` beside `fixed` is load-bearing: it is what lets the user
  // check the expert did not drift from what they meant." This is the property
  // the schemaVersion field above exists to protect, and ItemPatch cannot
  // express a change to either field.
  raw: z.string().optional(),
  rawSource: z.string().optional(),
  // The expert-written brief that replaced the shorthand. 5.4's to write.
  fixed: z.string().optional(),
  // Criteria the work must meet — this plus `fixed` is the loom's premise.
  acceptance: z.array(z.string()).optional(),
  timeline: z.array(TimelineEvent).optional(),
});
export type Item = z.infer<typeof Item>;
