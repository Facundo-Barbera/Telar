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
// throws. `label` is a SNAPSHOT of the loom's title at weave time and is what
// the queue's tracking chip says out loud; the loom's own title may drift from
// it afterwards (startLoomFromBundle re-derives one from objective.md), and the
// row deliberately keeps saying what it was handed to rather than following.
//
// SET AT WEAVE, and story 5.5's `weave_batch` / POST /api/workspace/weave are
// what write it — through store.ts's trackLoom, which is the only writer in the
// tree. It stays absent from ItemPatch, so updateItem still cannot reach it.
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

// A time-commitment mined out of a capture (story 5.8's enrichment pass,
// feeding CAP-8's gap detection). SPEC.md's assumption pins where this comes
// from: "Mining time-commitments from captures (CAP-8) is expert work during
// the enrichment pass, not a separate parser — the expert already reads every
// capture." So there is no commitment parser anywhere in the tree; there is
// this shape, and the expert fills it.
//
// IT HANGS OFF THE ITEM, NOT OFF A SECOND STORE, for the same reason the desk
// is a boolean on the item: the commitment was spoken INSIDE a capture, and the
// capture is a packet. A floating capture keeps its commitments with no project
// to file them under, which is the resting state item-model.md already blesses.
//
// `when` IS A COARSE HUMAN LABEL AND NOT A DATE — "Thursday", "next week",
// "after the demo". NFR-OW-11 forbids clocks and scheduling, and nothing in
// this store parses, compares or sorts it. Story 5.10's gap detection asks the
// HUMAN whether the moment passed (the briefing is pull-based and answers when
// arrived at); it does not compute the answer from a clock.
//
// `text` IS THE COMMITMENT IN THE CAPTURE'S OWN WORDS. Same law as `raw`: the
// user must be able to check the expert did not invent a promise they never
// made, so the quote is stored beside the expert's reading of it.
export const Expectation = z.looseObject({
  id: z.string(),
  text: z.string(),
  when: z.string(),
  // Which packet's capture it was mined from. Redundant with the item it is
  // stored on TODAY, and kept anyway: story 5.10 reads a flat list of every
  // commitment in the store (minedCommitments) and a line in a briefing that
  // cannot say which item it came from is a line nobody can act on.
  itemId: z.string(),
  // Display label of when the expert mined it, same class as Item.captured.
  mined: z.string(),
});
export type Expectation = z.infer<typeof Expectation>;

// ── experts/<project>/digest.yaml ────────────────────────────────────────────

// The version this build WRITES. Unlike a packet, a digest IS re-derivable —
// it is the expert's own compression of a project, and a later pass rewrites
// it — so `migrateDigest` does not exist and an unreadable digest degrades to
// "no digest" (a cold expert with nothing to rehydrate from) rather than to a
// throw. The field is recorded so a future build can tell what wrote it.
export const DIGEST_SCHEMA_VERSION = 1;

// One term the project says in shorthand, and what it means in full. This is
// the field CAP-9's "decompress shorthand a generic agent cannot" cashes out
// as: a generic model reading "the SEP path" learns nothing; an expert
// rehydrated from a digest that spells it out does.
export const DigestTerm = z.looseObject({
  term: z.string(),
  means: z.string(),
});
export type DigestTerm = z.infer<typeof DigestTerm>;

// THE PROJECT'S DURABLE STATE DIGEST — CAP-9's rehydration source and the
// SPEC's "Experts write, master reads" made into a file.
//
// EVERY FIELD IS PROSE OR A LIST OF PROSE, deliberately. This is a memory for
// a model to read, not a record for code to branch on: nothing in this tree
// switches on any field below, and a digest that grew a `status` or a
// `nextAction` would be a second, agent-writable planner sitting beside the
// item store — precisely the "agents may not commit" line NFR-OW-2 draws.
//
// z.looseObject for the same reason every packet-nested shape is: a build that
// cannot read a key must not destroy it on the next write.
export const ExpertDigest = z.looseObject({
  // The owning project slug. Also the directory name — see store.ts's
  // expertDigestFile, which guards it exactly as an item id is guarded.
  project: z.string(),
  schemaVersion: z.number().default(DIGEST_SCHEMA_VERSION),
  // Display label of the last pass that wrote it, same class as Item.captured.
  updated: z.string(),
  // "Where this project is, in a paragraph" — the sit-down overview's "where
  // each project was left" band reads this and nothing else.
  summary: z.string().default(""),
  // How this project works: its own methodology, which for a MIRRORED project
  // is the foreign tracker's methodology translated ("foreign structures stay
  // foreign… the expert doubles as translator of that project's methodology").
  methodology: z.string().default(""),
  glossary: z.array(DigestTerm).default([]),
  // Free-form durable notes the expert wants its next cold self to have.
  notes: z.array(z.string()).default([]),
});
export type ExpertDigest = z.infer<typeof ExpertDigest>;

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
  // DISCLOSED ADDITION (story 5.8) — the durable half of "the verdict is
  // advisory". item-model.md: "A human override is durable and is not
  // re-flipped by a later expert pass." A verdict alone cannot express that:
  // `verdict: "session"` written by an expert and `verdict: "session"` chosen
  // by the human are the same two bytes, so the next pass has no way to tell
  // which one it is looking at and every pass would re-decide.
  //
  // TRUE MEANS A HUMAN CHOSE IT, and only setItemVerdict (store.ts) writes it —
  // absent from ItemPatch, so no tool and no route can forge one. applyExpertPass
  // reads it and leaves `verdict` alone when it is set, recording what it WOULD
  // have said on the timeline instead. There is no un-set path for the same
  // reason there is no un-track path: a human unmakes it by choosing again.
  verdictOverride: z.boolean().optional(),
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
  // Time-commitments the expert mined out of THIS item's capture (CAP-8's
  // source, story 5.10's input). Written only by applyExpertPass; absent from
  // ItemPatch like every other ripening field.
  commitments: z.array(Expectation).optional(),
  timeline: z.array(TimelineEvent).optional(),
});
export type Item = z.infer<typeof Item>;
