# The workspace store's persisted shapes

`packages/core/src/workspace/schema.ts` holds the zod schemas for the
workspace store's persisted entities (SPEC-organization-workspace's
`item-model.md`, AD-6/AD-7/NFR-X-5). This document holds the reasoning
behind their shape; the source file holds only the point-of-use notes a
reader needs while editing a field.

## Why these schemas live in core, and not beside the MCP server

NFR-X-5: "zod schemas for persisted entities are owned by `@telar/core` and
never redefined in `apps/web`." `apps/web/lib/workspace-mcp.ts` therefore
declares NO entity schema at all — its `tool()` input shapes are ARGUMENT
schemas (what a caller may pass), structurally unrelated to `Item` (what is
on disk). INV-11 arm 5 asserts that separation as source text.

## Why they live in `workspace/schema.ts`, and not in `schemas.ts`

`schemas.ts` is the general persisted-entity home, but two documented
exceptions already exist for the same reason this one does —
`verification-strategy.ts` ("lives here, NOT in `schemas.ts`, per the M11
contract") and `ultra/wake.ts`'s `UltraWakeRecord`: a subtree with its own
owning module keeps its shapes beside that module, so the owner and the
shape move together. AD-5 gives `workspace/` exactly one owning module; this
directory is it.

## The one contradiction in the shape contract, and how it is resolved

`item-model.md`'s Storage section says a `packet.yaml` "owns the item and
knows nothing about its rank"; its Item table three sections later lists
`rank` as an item field. Both cannot ship. `rank` IS NOT A FIELD HERE:
`lanes.yaml` owns membership and order, and rank is a read-time projection
(`store.ts`'s `rankOf`, 1-based). The deciding argument is `item-model.md`'s
own stated benefit — "Reordering rewrites one small file" is FALSE if rank
is persisted per item, because reordering a ten-item lane would then rewrite
ten `packet.yaml` files.

## Tolerance is `z.looseObject`, not `z.object`, and that is load-bearing

AD-7 wants readers that "absorb unknown and missing fields". Missing fields
are handled by `.default()`/`.optional()` — `ultra/wake.ts`'s
`UltraWakeRecord` is the model for that half. UNKNOWN fields are NOT: that
header states plainly that "zod strips unknown keys rather than rejecting
them", and stripping is the opposite of absorbing. A `packet.yaml` written
by a NEWER Telar, read by this one and rewritten by `updateItem`, would
silently LOSE every field this version does not know — destroying exactly
the unrecoverable human input the `schemaVersion` field exists to protect.

Measured against the installed zod (4.4.3): `z.object({a}).parse({a,unknown})`
drops `unknown`; `z.looseObject({a}).parse({a,unknown})` keeps it. This is
the repo's first loose schema; grep for `passthrough(`/`catchall(`/`looseObject`
across `packages/core/src`, `apps/web/lib` and `apps/web/app` returned zero
before it.

It is applied at EVERY level of the packet, not only the top, and the
difference is observable rather than theoretical: with a loose `Item` over
strict nested shapes, a key hand-added under `deadline:` is DESTROYED by the
next `updateItem` while a top-level one survives — so "unknown fields
survive a round-trip" would be true one level deep and false everywhere
else, which is the worst of the three possible states because it looks like
the good one. Every shape a `packet.yaml` nests (`Deadline`, `Subtask`,
`TimelineEvent`, `LoomRef`) is therefore loose too. `WorkspaceLane` is
deliberately NOT: it is the one shape here that is not part of a packet.

## The nested shapes

- **`Deadline.slips`** — self-deadlines only: how often this slid. Durable,
  which is what makes CAP-7's witness possible ("you told yourself Friday,
  and it has slid twice"). A witness, never an alarm.
- **`Subtask.id`** — `item-model.md`'s Item table writes sub-tasks as
  `{title, done}[]` and the design-source fixtures
  (`apps/web/lib/demo-gallery/workspace/fixtures.ts`'s `WsItem.subtasks`)
  agree. `id` is a disclosed addition, forced twice: `promotedFrom` names a
  PARENT ITEM, so a promoted sub-task must be addressable, and a title is
  not an address — a rename or a duplicate title breaks the reference.
  Story 5.1 adds the field and writes no sub-task; 5.2 owns sub-task
  mutation and the human owns promotion (NFR-OW-15).
- **`PacketActor` — `"session"`** — `item-model.md`'s Packet table gives
  `actor ∈ you | expert | bed`. `session` is a disclosed widening by one
  member: a project session's agent is none of the three, and reusing
  `expert` would falsely attribute the work to the per-project expert —
  5.4's entity, whose "reasoning recorded as a timeline event" is CAP-9's
  own success clause. AD-7's tolerant readers absorb the new member; a
  renderer meeting an unknown actor shows a neutral icon rather than
  throwing.
- **`TimelineEvent`** — `item-model.md`'s Packet table: `{at, actor, text,
  proposal?}`. `at` is a display label of the same class as `Item.captured`
  — the fixtures' `PacketEvent.at` is a plain string ("Tue 16:42"), never a
  comparable stamp. `proposal: true` marks agent output awaiting a human
  look, which is the prepare-never-commit law (NFR-OW-2) made visible.
- **`LoomRef`** — AD-8/NFR-X-7: cross-tree references are WEAK: an id plus
  enough label to render without a lookup, so a dangling ref renders as a
  tombstone and never throws. Set at weave; no tool in this story writes
  it (story 5.5 owns the handoff), and it is absent from `ItemPatch` so no
  tool can.
- **`ItemVerdict`** — expert triage, `item-model.md`'s Item table:
  "Advisory — informs the handoff choice, does not perform it." Named
  `ItemVerdict` rather than `Verdict` because `packages/core/src/schemas.ts`
  already exports `Verdict` and this barrel would then carry two (the same
  class of collision that forces `WorkspaceLane`, below).

## `WorkspaceLane`

Named `WorkspaceLane`, not `Lane`, as a COMPILER CONSTRAINT rather than a
style choice: `packages/core/src/run-server.ts` exports `type Lane`, and
`packages/core/src/index.ts` carries `export * from "./run-server"`. A
second star-exported `Lane` is `error TS2308` — the barrel would not compile
at all.

`items` is an ORDERED ARRAY OF ITEM IDS, not embedded items, and this is
where the store deliberately disagrees with the design-source fixtures.
`fixtures.ts`'s `WsLane.items` is `WsItem[]` — that is the RENDERED shape,
the join a surface receives after `queueSlice` runs. Storing it that way
would put every item's content in a file whose stated benefit is being
small, and would give membership two sources of truth.

No `version` field, and the absence is the assertion. AD-7 puts a schema
version and a real migrate-on-read ONLY on stores holding unrecoverable
human input, naming `workspace/packets/<id>/packet.yaml` "above all".
`lanes.yaml` holds structure, which is re-derivable from the packets
themselves; the asymmetry between this schema and `Item` is AD-7's rule
made structural, and `workspace-store.test.ts` asserts it in BOTH
directions.

## `Item`

`ITEM_SCHEMA_VERSION` is the version this build WRITES. `migratePacket`
(`store.ts`) refuses to read anything above it rather than guessing,
because a `packet.yaml` holds `raw` verbatim and has no source to be
rebuilt from.

ONE SHAPE FOR ALL ITEMS (AC2). A bare one-line todo and a fully ripened work
packet are the SAME schema — `item-model.md`: "A packet is not a different
entity; it is an item that grew attachments." So there is no second reader,
no second writer, and no migration when an item ripens. The flat union of
`item-model.md`'s Item table and its Packet table is what makes that true; a
nested `packet` record would have re-introduced the two-shape split by the
back door.

`packet` (the `{files, mockups}` tally) is NOT persisted here. It is derived
at read time from the directory listing by `store.ts`'s `attachmentTally`,
which is what keeps "an item growing attachments needs no migration" true
BY CONSTRUCTION rather than by discipline: dropping a file beside
`packet.yaml` changes the tally and rewrites nothing.

No `status`, `state`, `done` or `accepted` field exists on this type, and
the absence is the Human-Accept Moat expressed in the schema rather than in
a comment about the schema (AD-1/AD-10, AC8 proof 1). There is nothing in
`item-model.md` to transition, and no tool input shape carries such a key
either; `workspace-mcp.test.ts` asserts both halves.

### Field-by-field

- **`id`** — minted, NEVER derived from position (`store.ts`'s `newItemId`).
  An id derived from a lane index or a count breaks the moment the stack is
  reordered — the one operation this store exists to make cheap.
- **`provenance`** — how it got in ("note", "pasted transcript", "chat",
  "mirror sync", "loom event", "session"). NFR-OW-12: a free-form label, not
  an enum — there is deliberately no channel type to switch on, so
  narrowing this to a union would violate the constraint rather than
  tighten the schema.
- **`captured`** — when it entered, as a display label ("Tue 16:42"),
  matching the fixtures' `WsItem.captured` exactly. NFR-OW-11: never a
  scheduling input. Nothing in this module or in `store.ts` ever parses,
  compares or sorts on it — order is stack position, always.
- **`schemaVersion`** — AD-7's version field, on this store and not on
  `lanes.yaml`. Absent normalises to 1 inside `migratePacket` BEFORE any
  comparison, which is the common case for a hand-authored `packet.yaml` —
  a file AD-6 explicitly invites a human to edit.
- **`lane`** — a disclosed addition, the RECOVERY HINT of the reconcile
  rule. `lanes.yaml` is authoritative for membership and order; this is
  consulted ONLY when the id appears in no stack at all (the torn-write
  case). Optional, because a hand-authored `packet.yaml` may legitimately
  omit it — such an item is unfiled, which is a resting state and not an
  error.
- **`desk`** — a disclosed addition, "on the workspace desk".
  `item-model.md` calls the Desk item "a projection of an item the agents
  just touched, not a separate store", so a boolean ON the item honours
  that where a second store would not. Needed separately from queue
  membership because CAP-3 requires dismissal to be separately mutable.
  Cleared by `updateItem({desk: false})`.
- **`unplaced`** — from `item-model.md`'s Desk-item block: "the master
  could not file it and is asking". Persisted on the item so `deskSlice`
  can emit it from item fields alone, and so 5.4's receipt has a home.
  Renders as a question, not a failure.
- **`project`** — absent = floating, and floating is a valid resting state
  rather than an error (`item-model.md`). A project-scoped slice EXCLUDES a
  floating item; it never treats one as a failure.
- **`mirrored`** — foreign issue ref, e.g. "#214". Present = Telar holds a
  view only and the foreign tracker stays source of truth.
- **`subtasks`** — the conservation valve (NFR-OW-3): decomposition lives
  INSIDE the item, so breaking work down never grows the queue count.
  `queueSlice` returns items, never items-plus-subtasks, and its test
  asserts the count is unchanged when sub-tasks are added.
- **`promotedFrom`** — parent item id, when this item began as a sub-task.
  NFR-OW-15: "Agents have no promotion path, proposed or otherwise." The
  field exists because the shape contract requires it; no tool input shape
  can write it, which is the executable half (it is absent from
  `ItemPatch`, and AC8 proof 3 asserts that against the pinned type rather
  than against whatever a handler happens to accept today).
- **`tracking`** — set at weave (story 5.5). No tool in this story writes
  it.
- **The Packet table fields (`raw`, `rawSource`, `fixed`, `acceptance`,
  `timeline`)** — the ripening history CAP-6 describes. `raw`/`rawSource`
  are NEVER OVERWRITTEN BY ANY WRITE PATH (AC9, NFR-OW-19).
  `item-model.md`: "Keeping `raw` beside `fixed` is load-bearing: it is
  what lets the user check the expert did not drift from what they meant."
  This is the property `schemaVersion` exists to protect, and `ItemPatch`
  cannot express a change to either field. `fixed` is the expert-written
  brief that replaced the shorthand (5.4's to write); `acceptance` is the
  criteria the work must meet — this plus `fixed` is the loom's premise.
