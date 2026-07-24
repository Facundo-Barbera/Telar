# Item Model — Organization Workspace

Companion to `SPEC.md`. The entity shapes the workspace's surfaces agree on. Frozen from the design-source-of-truth fixtures (`apps/web/lib/demo-gallery/workspace/fixtures.ts`); field *meanings* are contractual, TypeScript syntax here is descriptive.

## Storage

```
TELAR_HOME/workspace/
  home/                         # master session cwd — dedicated, empty; holds no store files
  lanes.yaml                    # lane definitions + ordered [item-id] stacks
  packets/
    <item-id>/
      packet.yaml               # every item — one-liner or rich, same shape
      <attachment files>        # siblings, only when the item grew some
```

- **Structure and content are separate.** `lanes.yaml` owns lane definitions and ordering; a `packet.yaml` owns the item and knows nothing about its rank. Reordering rewrites one small file; editing an item rewrites one small file.
- **One shape for all items.** A bare todo is a `packet.yaml` with no attachments — there is no migration when an item grows, and no second code path for "rich" items.
- **All writes are atomic** — `.tmp` → `fs.renameSync`, per core's `manifest.ts` idiom (`project-context.md`).
- **Nothing outside reaches in.** Reads and writes go through the in-process workspace MCP server; sessions do not get filesystem access to this tree.

## Item

The queue's unit. A packet is not a different entity — it is an item that grew attachments.

| Field | Meaning | Contractual notes |
| --- | --- | --- |
| `id` | Stable identifier | — |
| `rank` | Position within its lane's ordered stack | Order is stack position, never a time |
| `title` | The one-liner | Always present, even for rich packets |
| `project` | Owning project | **Absent = floating.** Floating is a valid resting state, not an error |
| `mirrored` | Foreign issue ref (e.g. `#214`) | Present = Telar holds a view only; the foreign tracker stays source of truth |
| `provenance` | How it got in (`note`, `pasted transcript`, `chat`, `mirror sync`, `loom event`, `session`) | **Free-form label, not an enum.** No channel type to switch on |
| `captured` | When it entered | Display label; not a scheduling input |
| `deadline` | See *Deadline* below | Optional. Data on the item, never a schedule entry |
| `packet` | Attachment tallies (`files`, `mockups`) | Presence = rich packet; absence = plain todo |
| `verdict` | Expert triage: `session` \| `loom` | Advisory — informs the handoff choice, does not perform it. A human override is durable and is not re-flipped by a later expert pass |
| `subtasks` | `{title, done}[]` **inside** the item | The conservation valve: decomposition never grows the queue count |
| `promotedFrom` | Parent item id, when this item began as a sub-task | Set only by a human promotion; there is no agent path that writes it |
| `tracking` | Loom ref, when the item was handed to a woven loom (one loom carries the whole batch) | Set at weave; the row stays in the queue until the loom lands **and** the human accepts |

## Deadline

```
kind: "external" | "self"
label: string    // "Fri", "Sep 2" — coarse, human
slips?: number   // self-deadlines only: how often this slid
```

- **External** deadlines come from outside and are not negotiable by Telar.
- **Self** deadlines are the user's own commitment to themselves; they carry `slips`.
- `slips` is what makes CAP-7's witness possible — the master can say *"you told yourself Friday, and it has slid twice"* because the count is durable. It is a witness, never an alarm.

## Lane

```
key: string      // user-defined
label: string
window: string   // "work hours", "evenings, shifts with the term", "whenever"
note?: string    // structural provenance: "split from Office — you accepted Mon"
items: Item[]    // ordered stack
```

- **Lanes are data, never an enum.** The user splits, renames, and retires them as life demands.
- `window` is coarse and shifting — a description of when this lane's work tends to happen, never a schedule.
- `note` records structural provenance. A lane created by an accepted master proposal says so, permanently.

## Desk item

The right rail's card. A projection of an item the agents just touched, not a separate store.

```
id, title
tag?      // project, mono
hint?     // tiny second line: "Fri · external", "moved to Fri · updated just now"
unplaced? // the master could not file it and is asking
```

- `unplaced` renders as a question, not a failure — it is the receipt's "1 question" made persistent.
- Dismiss drains to the queue. **There is no delete.**

## Packet

An item's expanded form. Carries the ripening history CAP-6 describes.

| Field | Meaning |
| --- | --- |
| `raw` + `rawSource` | The original fragment, verbatim, and where it came from — **never overwritten** |
| `fixed` | The expert-written brief that replaced the shorthand |
| `acceptance[]` | Criteria the work must meet — this plus `fixed` is the loom's *premise* |
| attachments | Files gathered along the way; agent-drafted ones marked `proposal` |
| `timeline[]` | `{at, actor, text, proposal?}` where actor ∈ `you` \| `expert` \| `bed` |

- Keeping `raw` beside `fixed` is load-bearing: it is what lets the user check the expert did not drift from what they meant.
- The expert's verdict reasoning is a timeline event, not a hidden field — the user can see *why* it said loom before overriding it.
- `proposal: true` marks agent output awaiting a human look — the prepare-never-commit law made visible.
- At handoff the packet *is* the briefing: premise = `fixed` + `acceptance`, context = attachments. Nothing is re-authored.
