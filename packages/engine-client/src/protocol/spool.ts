/**
 * engine protocol v2 — Spool: the item store behind SPEC-organization-workspace.
 *
 * Ported from `packages/core/src/workspace/schema.ts`. The spec calls this
 * module "the organization workspace"; `workspace` was already taken twice in
 * this protocol — `SessionWorkspace`/`WorkspaceFile`/`WorkspaceListing` in
 * `./entities.ts` mean the session's WORKING TREE, and `./items.ts`'s `Item` is
 * a timeline row — so the module is Spool here. `docs/spool-port.md` holds the
 * translation table and the full reasoning. The spec's prose is unchanged and
 * still says "workspace" throughout.
 *
 * WHY THE PERSISTED SHAPES ARE PROTOCOL SHAPES, which is a deviation from the
 * donor. `NFR-X-5` put persisted schemas in `@telar/core` and forbade `apps/web`
 * from redefining them; here neither app may import core at all, and the engine
 * already treats the protocol as its persistence schema — `state.ts` imports
 * `Session as SessionSchema`, `Task as TaskSchema` and parses documents off disk
 * with them. One definition site was the point of NFR-X-5 and this is where it
 * now is. The engine's `spool/store.ts` reads and writes with these; the web
 * renders from them.
 *
 * `z.looseObject`, NOT `z.object`, on every shape a packet nests (SpoolItem,
 * SpoolDeadline, SpoolSubtask, SpoolTimelineEvent, SpoolLoomRef). Do not "tidy"
 * any of these to `z.object`: a strict NESTED shape silently DESTROYS an unknown
 * key on the next update, which a strict top-level item would not, and that
 * asymmetry is worse than being strict everywhere. `SpoolLane` is deliberately
 * the one shape here that stays `z.object` — it is not part of a packet.
 */
import { z } from "zod";

// ── the nested shapes ───────────────────────────────────────────────────────

/**
 * `item-model.md` § Deadline. `label` is coarse human text ("Fri", "Sep 2") and
 * is NEVER a date to compare — the module forbids clocks and scheduling, and
 * nothing in this tree performs a comparison on it anywhere.
 */
export const SpoolDeadlineKind = z.enum(["external", "self"]);
export type SpoolDeadlineKind = z.infer<typeof SpoolDeadlineKind>;

export const SpoolDeadline = z.looseObject({
  label: z.string(),
  kind: SpoolDeadlineKind,
  /** Self-deadlines only: how often this slid (CAP-7's witness). A witness,
   *  never an alarm — nothing here schedules on it. */
  slips: z.number().optional(),
});
export type SpoolDeadline = z.infer<typeof SpoolDeadline>;

/**
 * Sub-tasks per `item-model.md`'s Item table are `{title, done}[]`; `id` is a
 * disclosed addition, forced because `promotedFrom` (below) names a PARENT ITEM
 * and a title is not a stable address.
 */
export const SpoolSubtask = z.looseObject({
  id: z.string(),
  title: z.string(),
  done: z.boolean().optional(),
});
export type SpoolSubtask = z.infer<typeof SpoolSubtask>;

/**
 * `item-model.md`'s Packet table gives `actor ∈ you | expert | bed`. `session`
 * is a disclosed widening by one member — a tolerant reader absorbs it, and a
 * renderer meeting an unknown actor shows a neutral icon rather than throwing.
 */
export const SpoolActor = z.enum(["you", "expert", "bed", "session"]);
export type SpoolActor = z.infer<typeof SpoolActor>;

/**
 * `item-model.md`'s Packet table: `{at, actor, text, proposal?}`. `at` is a
 * display label, same class as `SpoolItem.captured` below — never a comparable
 * stamp. `proposal: true` marks agent output awaiting a human look, which is
 * the prepare-never-commit law made visible.
 */
export const SpoolTimelineEvent = z.looseObject({
  at: z.string(),
  actor: SpoolActor,
  text: z.string(),
  proposal: z.boolean().optional(),
});
export type SpoolTimelineEvent = z.infer<typeof SpoolTimelineEvent>;

// ── WHAT IS DELIBERATELY ABSENT: EVERYTHING LOOM ────────────────────────────
//
// The contract gives an item two more fields than are declared below, and both
// name a loom:
//
//   · `tracking` — a weak reference to the loom an item was woven into, written
//     at weave time by the store's `trackLoom`, and rendered on the queue as the
//     mark that says a row is out at a loom without saying it is done.
//   · `verdict` — the expert's triage, whose entire content is the question
//     "should this be executed as a session or as a loom?", plus the durable
//     `verdictOverride` flag that makes a human's answer stick against a later
//     expert pass.
//
// LOOMS ARE NOT BUILT IN THIS APP. They exist only in the frozen legacy tree,
// and nothing in the engine can weave, land or accept one. A `tracking` field
// with no writer is dead weight; a verdict offering a destination that does not
// exist is worse — it is a question the user cannot answer correctly, rendered
// as though they could.
//
// So they are out until looms are. Issue #93 tracks that work and lists these
// as the exact re-attachment points. Restoring them is additive: both are optional
// fields, so a packet written by a future build that carries them still parses
// here (`z.looseObject` keeps unknown keys and no write path destroys them),
// and a packet written today needs no migration to gain them.

/**
 * A time-commitment mined out of a capture (the enrichment pass, feeding CAP-8's
 * gap detection). The spec pins where this comes from: "Mining time-commitments
 * from captures is expert work during the enrichment pass, not a separate parser
 * — the expert already reads every capture." So there is no commitment parser
 * anywhere in the tree; there is this shape, and the expert fills it.
 *
 * IT HANGS OFF THE ITEM, NOT OFF A SECOND STORE, for the same reason the desk is
 * a boolean on the item: the commitment was spoken INSIDE a capture, and the
 * capture is a packet. A floating capture keeps its commitments with no project
 * to file them under, which is a resting state `item-model.md` already blesses.
 *
 * `when` IS A COARSE HUMAN LABEL AND NOT A DATE — "Thursday", "next week",
 * "after the demo". Nothing in this store parses, compares or sorts it. Gap
 * detection asks the HUMAN whether the moment passed (the briefing is pull-based
 * and answers when arrived at); it does not compute the answer from a clock.
 *
 * `text` IS THE COMMITMENT IN THE CAPTURE'S OWN WORDS. Same law as `raw`: the
 * user must be able to check the expert did not invent a promise they never
 * made, so the quote is stored beside the expert's reading of it.
 */
export const SpoolExpectation = z.looseObject({
  id: z.string(),
  text: z.string(),
  when: z.string(),
  /** Which packet's capture it was mined from. Redundant with the item it is
   *  stored on today, and kept anyway: the briefing reads a flat list of every
   *  commitment in the store, and a line that cannot say which item it came from
   *  is a line nobody can act on. */
  itemId: z.string(),
  /** Display label of when the expert mined it, same class as `captured`. */
  mined: z.string(),
});
export type SpoolExpectation = z.infer<typeof SpoolExpectation>;

// ── experts/<project>/digest.json ───────────────────────────────────────────

/**
 * The version this build WRITES. Unlike a packet, a digest IS re-derivable — it
 * is the expert's own compression of a project, and a later pass rewrites it —
 * so there is no digest migration and an unreadable digest degrades to "no
 * digest" (a cold expert with nothing to rehydrate from) rather than to a throw.
 * The field is recorded so a future build can tell what wrote it.
 */
export const SPOOL_DIGEST_SCHEMA_VERSION = 1;

/**
 * One term the project says in shorthand, and what it means in full. This is the
 * field CAP-9's "decompress shorthand a generic agent cannot" cashes out as: a
 * generic model reading "the SEP path" learns nothing; an expert rehydrated from
 * a digest that spells it out does.
 */
export const SpoolDigestTerm = z.looseObject({
  term: z.string(),
  means: z.string(),
});
export type SpoolDigestTerm = z.infer<typeof SpoolDigestTerm>;

/**
 * THE PROJECT'S DURABLE STATE DIGEST — CAP-9's rehydration source and the spec's
 * "experts write, master reads" made into a file.
 *
 * EVERY FIELD IS PROSE OR A LIST OF PROSE, deliberately. This is a memory for a
 * model to read, not a record for code to branch on: nothing in this tree
 * switches on any field below, and a digest that grew a `status` or a
 * `nextAction` would be a second, agent-writable planner sitting beside the item
 * store — precisely the line "agents may not commit" draws.
 */
export const SpoolExpertDigest = z.looseObject({
  /** The owning project slug. Also the directory name — the store guards it
   *  exactly as it guards an item id. */
  project: z.string(),
  schemaVersion: z.number().default(SPOOL_DIGEST_SCHEMA_VERSION),
  /** Display label of the last pass that wrote it, same class as `captured`. */
  updated: z.string(),
  /** "Where this project is, in a paragraph" — the sit-down overview's "where
   *  each project was left" band reads this and nothing else. */
  summary: z.string().default(""),
  /** How this project works: its own methodology, which for a MIRRORED project
   *  is the foreign tracker's methodology translated ("foreign structures stay
   *  foreign… the expert doubles as translator of that project's
   *  methodology"). */
  methodology: z.string().default(""),
  glossary: z.array(SpoolDigestTerm).default([]),
  /** Free-form durable notes the expert wants its next cold self to have. */
  notes: z.array(z.string()).default([]),
});
export type SpoolExpertDigest = z.infer<typeof SpoolExpertDigest>;

// ── lanes.json ──────────────────────────────────────────────────────────────

/**
 * `items` is an ORDERED ARRAY OF ITEM IDS, not embedded items — deliberately
 * disagreeing with the design-source fixtures, whose lane `items` is the
 * RENDERED join. Storing embedded items would give membership two sources of
 * truth.
 *
 * NO `schemaVersion` FIELD, and the absence is the assertion: a schema version
 * plus migrate-on-read is for stores holding unrecoverable human input, and this
 * file is re-derivable structure. `SpoolItem` below carries one; the asymmetry
 * is deliberate and is asserted in both directions.
 */
export const SpoolLane = z.object({
  /** User-defined. Lanes are DATA, never an enum. */
  key: z.string(),
  label: z.string(),
  /** Coarse and shifting ("work hours", "evenings", "whenever") — never a
   *  schedule. */
  window: z.string(),
  /** Structural provenance: "split from Office — you accepted Mon". A lane
   *  created by an accepted master proposal says so, permanently. */
  note: z.string().optional(),
  /** The ordered stack. Position in THIS array is the item's rank (1-based, via
   *  the store's `rankOf`) — rank is deliberately not persisted per item, or
   *  "reordering rewrites one small file" would be false. */
  items: z.array(z.string()).default([]),
});
export type SpoolLane = z.infer<typeof SpoolLane>;

// ── packets/<item-id>/packet.json ───────────────────────────────────────────

/**
 * The version this build WRITES. The store's `migratePacket` refuses to read
 * anything above it rather than guessing, because a packet holds `raw` verbatim
 * and has no source to be rebuilt from.
 */
export const SPOOL_ITEM_SCHEMA_VERSION = 1;

/**
 * ONE SHAPE FOR ALL ITEMS: a bare one-line todo and a fully ripened work packet
 * are the SAME schema — "a packet is not a different entity; it is an item that
 * grew attachments" (`item-model.md`). So there is no second reader, writer or
 * migration when an item ripens; a nested `packet` record would re-introduce the
 * two-shape split by the back door.
 *
 * THE `{files, mockups}` TALLY IS NOT PERSISTED HERE — it is derived at read
 * time by the store's `attachmentTally`, which is what keeps "growing
 * attachments needs no migration" true by construction.
 *
 * NO status, state, done OR accepted FIELD EXISTS ON THIS TYPE. The absence is
 * the human-accept moat expressed in the schema, and the tool surface asserts
 * that no tool input shape carries one either.
 */
export const SpoolItem = z.looseObject({
  /** Minted, NEVER derived from position — an id derived from a lane index
   *  breaks the moment the stack reorders. */
  id: z.string(),
  /** Always present, even for a rich packet. */
  title: z.string(),
  /** How it got in ("note", "pasted transcript", "chat", "mirror sync", "loom
   *  event", "session"). A FREE-FORM LABEL, NOT AN ENUM. */
  provenance: z.string(),
  /** When it entered, as a DISPLAY LABEL ("Tue 16:42"). Never a scheduling
   *  input — nothing here parses, compares or sorts on it; order is stack
   *  position, always. */
  captured: z.string(),
  /** The version field, on this store and not on lanes.json. Absent normalises
   *  to 1 inside `migratePacket` BEFORE any comparison — the common case for a
   *  hand-authored packet. */
  schemaVersion: z.number().default(SPOOL_ITEM_SCHEMA_VERSION),
  /** DISCLOSED ADDITION — the RECOVERY HINT of the reconcile rule. lanes.json is
   *  authoritative for membership and order; this is consulted only when the id
   *  appears in no stack (the torn-write case). Optional: absent means unfiled,
   *  a resting state, not an error. */
  lane: z.string().optional(),
  /** DISCLOSED ADDITION — "on the spool desk". A boolean on the item rather than
   *  a second store, per `item-model.md`'s Desk-item description. Cleared by
   *  `updateItem({desk: false})`. */
  desk: z.boolean().optional(),
  /** From `item-model.md`'s Desk-item block: "the master could not file it and
   *  is asking". Renders as a question, not a failure. */
  unplaced: z.boolean().optional(),
  /** ABSENT = FLOATING, and floating is a valid resting state — a project-scoped
   *  slice excludes it rather than treating it as a failure. */
  project: z.string().optional(),
  /** Foreign issue ref, e.g. "#214". Present = Telar holds a view only and the
   *  foreign tracker stays source of truth. */
  mirrored: z.string().optional(),
  deadline: SpoolDeadline.optional(),
  // `verdict` and `verdictOverride` belong here — see the absence note above.
  /** The conservation valve: decomposition lives INSIDE the item, so breaking
   *  work down never grows the queue count. */
  subtasks: z.array(SpoolSubtask).optional(),
  /** Parent item id, when this item began as a sub-task. "Agents have no
   *  promotion path, proposed or otherwise" — the field exists because the shape
   *  contract requires it, and it is absent from the patch type so no tool can
   *  write it. */
  promotedFrom: z.string().optional(),
  // `tracking` belongs here — see the absence note above.
  // ── the Packet table: the ripening history CAP-6 describes ──
  /** NEVER OVERWRITTEN BY ANY WRITE PATH — "keeping raw beside fixed is
   *  load-bearing: it lets the user check the expert did not drift from what
   *  they meant." The patch type cannot express a change to either field. */
  raw: z.string().optional(),
  rawSource: z.string().optional(),
  /** The expert-written brief that replaced the shorthand. */
  fixed: z.string().optional(),
  /** Criteria the work must meet — this plus `fixed` is the loom's premise. */
  acceptance: z.array(z.string()).optional(),
  /** Time-commitments the expert mined out of THIS item's capture. Written only
   *  by `applyExpertPass`; absent from the patch type like every other ripening
   *  field. */
  commitments: z.array(SpoolExpectation).optional(),
  timeline: z.array(SpoolTimelineEvent).optional(),
});
export type SpoolItem = z.infer<typeof SpoolItem>;

// ── the read-time projections ───────────────────────────────────────────────
//
// These are not persisted. They are what the store's pure projections return
// and what the surfaces render, and they live here so the queue, the desk rail
// and an in-session tool answer agree about their shape by construction.

/**
 * Why the reason is a string and not an enum: it is human-facing diagnosis
 * surfaced through a tool's own result text, and the set of ways a hand-edited
 * store file can be wrong is not enumerable.
 *
 * `id` IS AN ADDRESS, NOT ALWAYS AN ITEM ID. The channel also carries the lane
 * rows the tolerant reader had to skip, addressed by the row's own `key` when it
 * still has a readable one and by `lanes.json[<index>]` when it does not.
 */
export const SpoolUnreadable = z.object({ id: z.string(), reason: z.string() });
export type SpoolUnreadable = z.infer<typeof SpoolUnreadable>;

/** One rendered queue row: which lane, what rank in it, and the item. */
export const SpoolQueueRow = z.object({ lane: z.string(), rank: z.number(), item: SpoolItem });
export type SpoolQueueRow = z.infer<typeof SpoolQueueRow>;

/**
 * One row of the SUBJECT view — the same item, seen from the other axis.
 *
 * WHY IT IS NOT `SpoolQueueRow`: there, `lane` and `rank` are REQUIRED, because a
 * queue row exists only where a stack holds the id. The subject view shows every
 * readable item, including the unfiled one the reconcile rule leaves in no lane
 * (arm 3), and reusing the queue's shape would force that row to name a lane it
 * is not in. Absent here means "in no stack" — a resting state, not an error, and
 * a renderer that meets it draws no lane chip rather than a wrong one.
 *
 * BOTH FIELDS RIDE ALONG SO THE SURFACE NEEDS NO SECOND JOIN. Grouping by subject
 * does not stop a row wanting to say which lane it sits in; a row carrying only
 * the item would send the client back to `lanes` to find out, which is exactly
 * the "rows that disagree with the lane list" fault the one-call snapshot exists
 * to prevent.
 */
export const SpoolSubjectRow = z.object({
  item: SpoolItem,
  lane: z.string().optional(),
  rank: z.number().optional(),
});
export type SpoolSubjectRow = z.infer<typeof SpoolSubjectRow>;

/**
 * THE PRIMARY GROUPING AXIS: what work is ABOUT, not when you would do it.
 *
 * A lane answers "when and where would I do this" — it is a GTD context, and the
 * spec's own examples are "Office / work hours" and "Evenings". Real work is not
 * divided that way. `ozom-ai/ozom-gv`'s four months are cut by milestone,
 * category and dependency (§6 of `docs/spool-definition.md`), so all 29 of its
 * open issues would land in one lane called Office and the lane axis would carry
 * no information at all. The subject therefore leads, and the lane rides on the
 * row as secondary structure.
 *
 * THIS DELETES NOTHING AND MIGRATES NOTHING. It is a second projection over the
 * same `lanes.json` and the same packets: no stored shape changes, no stack
 * moves, the reconcile rule is untouched, and `SpoolSnapshot.rows` still ships
 * beside it so the lane view keeps working.
 *
 * `project` ABSENT = FLOATING, and floating is a valid resting state
 * (`item-model.md`: "Absent = floating. Floating is a valid resting state, not an
 * error"). Those items get a group of their own rather than being hidden, and it
 * sorts last so the named subjects read first.
 */
export const SpoolSubjectGroup = z.object({
  /** The subject, EXACTLY as the items spell it — `SpoolItem.project` verbatim,
   *  never normalised, slugged or title-cased. §7.2 widens that field into a real
   *  subject record with a permitted-action level; a projection that had minted
   *  its own key would then have to be reconciled with the thing it was standing
   *  in for. */
  project: z.string().optional(),
  rows: z.array(SpoolSubjectRow),
});
export type SpoolSubjectGroup = z.infer<typeof SpoolSubjectGroup>;

/**
 * The right rail's card — "a projection of an item the agents just touched, not
 * a separate store".
 *
 * FIELDS, NOT SENTENCES. This projection once flattened project, mirrored ref
 * and deadline into one `hint` STRING, which made the Desk the only surface
 * where a self-deadline lost its `· self` / `· slid ×N` dashed chip and a
 * mirrored item lost its ref — breaking the cross-surface invariant that those
 * chips render identically everywhere, at the projection layer where no amount
 * of care in the rail could put it back. The card carries the same fields a
 * queue row's item does and the rail renders them with the same components.
 * `hint` survives for the one thing no chip says.
 */
export const SpoolDeskCard = z.object({
  id: z.string(),
  title: z.string(),
  project: z.string().optional(),
  mirrored: z.string().optional(),
  deadline: SpoolDeadline.optional(),
  hint: z.string().optional(),
  unplaced: z.boolean().optional(),
});
export type SpoolDeskCard = z.infer<typeof SpoolDeskCard>;

/** The `{files, mockups}` tally, derived from attachment names at read time. */
export const SpoolAttachmentTally = z.object({ files: z.number(), mockups: z.number() });
export type SpoolAttachmentTally = z.infer<typeof SpoolAttachmentTally>;

/**
 * Everything the queue surface renders, in ONE read.
 *
 * ONE CALL RATHER THAN FOUR, because the four are not independent: `rows` is a
 * join over `lanes` and the items, and `unreadable` is the diagnostic channel
 * for the faults that join DROPS. A client that fetched them separately could
 * render a queue whose rows disagree with its lane list, and — worse — could
 * show a shrunken queue with no sign that anything was wrong.
 *
 * NO PER-LANE COUNT FIELD. The count a human reads beside a lane header is the
 * number of rows rendered under it, which includes an adopted orphan the stored
 * stack has forgotten. Sending a second, stored count would be a number that
 * disagrees with what is on screen.
 *
 * BOTH AXES SHIP FROM ONE READ, for the same reason: `rows` and `subjects` are
 * two projections of the same items and the same stacks, and a client that
 * fetched them in two calls could show a subject group holding an item the queue
 * has already lost, with no sign that the two disagreed.
 */
export const SpoolSnapshot = z.object({
  lanes: z.array(SpoolLane),
  rows: z.array(SpoolQueueRow),
  /** The same readable items grouped by SUBJECT — the primary axis, per
   *  `SpoolSubjectGroup`. Every readable item appears in exactly one group, so
   *  the rows here total `totalItems` while `rows` above totals only the FILED
   *  ones; the two counts differing is the unfiled remainder, not a fault. */
  subjects: z.array(SpoolSubjectGroup),
  desk: z.array(SpoolDeskCard),
  /** Everything the store could not make sense of — malformed packets AND the
   *  lane rows a tolerant read had to skip. The queue footer says this out
   *  loud; a client that drops it makes tolerance indistinguishable from loss. */
  unreadable: z.array(SpoolUnreadable),
  /** Every readable item, filed or not — so the footer can state the
   *  conservation law with a live number rather than a caption. */
  totalItems: z.number(),
  /** The other half of that law: how many of them an agent filed. */
  agentsAdded: z.number(),
});
export type SpoolSnapshot = z.infer<typeof SpoolSnapshot>;

/**
 * One item, with what only the store can say about it.
 *
 * `lane` AND `rank` COME FROM THE STACKS, never from the item's own `lane`
 * hint: that field is a recovery hint the reconcile rule consults only when an
 * id is in no stack, and rendering it as the item's location would show a
 * hand-edited move as not having happened. Both are absent for an unfiled item,
 * which is a resting state and not an error.
 */
export const SpoolItemDetail = z.object({
  item: SpoolItem,
  lane: z.string().optional(),
  rank: z.number().optional(),
  attachments: z.array(z.string()),
  tally: SpoolAttachmentTally,
});
export type SpoolItemDetail = z.infer<typeof SpoolItemDetail>;

// ── the expert pass ─────────────────────────────────────────────────────────

/**
 * What one consultation cost.
 *
 * PRESENT OR ABSENT, never zeroed. A provider that reported nothing is not the
 * same as a call that was free, and a caller totalling a night of passes has to
 * be able to tell the two apart.
 */
export const SpoolExpertUsage = z.looseObject({
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheCreate: z.number(),
  }),
  costUsd: z.number().optional(),
  turns: z.number().optional(),
});
export type SpoolExpertUsage = z.infer<typeof SpoolExpertUsage>;

/**
 * THE RESULT OF ASKING A PROJECT'S EXPERT TO READ ONE ITEM.
 *
 * A UNION WITH A REASON, NOT A THROW, and the whole surface depends on it: a
 * floating item, a project name the store cannot address, a project this machine
 * has not registered, a model that never answered — every one of those is an
 * ANSWER to "can the expert read this?" carrying a sentence that names the next
 * move. A client renders the sentence; it does not invent one from a status
 * code.
 *
 * NOTHING IN THE SUCCESS ARM CAN COMMIT. `applied` reports what the store wrote
 * — a brief, acceptance criteria, a timeline note, mined commitments — and
 * there is no field for a status, a lane, a start or an acceptance, because the
 * expert has no verb that could produce one.
 */
export const SpoolExpertOutcome = z.discriminatedUnion("ok", [
  z.looseObject({
    ok: z.literal(true),
    project: z.string(),
    applied: z.looseObject({
      item: SpoolItem,
      /** How many timeline events this pass appended. */
      events: z.number(),
      commitments: z.number(),
      /** The pass's own label, minted once by the store's clock, so the digest
       *  and this pass's timeline events agree. */
      at: z.string(),
    }),
    digest: SpoolExpertDigest,
    /** Whether the expert started from a digest or from nothing. Reported so a
     *  surface can say "first pass" honestly rather than implying memory it did
     *  not have. */
    cold: z.boolean(),
    /** The checkout the pass ran against, or absent when this machine has none.
     *  `cold` is about the digest, not the tree — without this a surface cannot
     *  say the expert judged the item without ever seeing the project. */
    cwd: z.string().optional(),
    usage: SpoolExpertUsage.optional(),
  }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type SpoolExpertOutcome = z.infer<typeof SpoolExpertOutcome>;
