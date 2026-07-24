# UI Contract — Organization Workspace

Companion to `SPEC.md`. The four surfaces, frozen. Prototyped live under `apps/web/lib/demo-gallery/workspace/**` (entries `workspace-home`, `workspace-queue`, `workspace-packet`, `workspace-in-session`) — **design source-of-truth prototypes, not production code**. What is contractual is below; the prototypes' fixture state (pre-checked rows, one-shot toggles, hardcoded timestamps) is not.

The quiet-color law from `project-context.md` binds throughout: hue lives on the icon only, chips stay neutral outlines. Tone law binds: state and data only, no suggestion-text or doctrine captions.

## Shell

Workspace is **one top-level destination with two tabs** — Chat (front door) and Queue (the drawer behind it). The queue does not pretend to be its own destination.

## 1 · Master chat (`workspace-home`)

Anatomy: left app nav · centre transcript + composer · right **Desk** rail.

- The master chat **is a session** — user turns wear the production message bubble idiom, built on the shared `Conversation` shell.
- **Header** carries a bed-mode summary chip when a run happened: window, action count, and `0 started` — the prepare-never-commit law stated on screen.
- **Briefing** renders as labelled bands: *While you were away* · *Where you stopped* · *Today* (per-lane counts + suggested first move).
- **Gap card** (CAP-8): the expectation that went uncaptured and capture chips (paste transcript / mark no-notes / dump now). **v1 deviation from the mockup:** the expectation is a commitment *mined from a capture* ("you said you'd sync Thursday"), not a calendar event — there is no external calendar in v1, so the mockup's "was on your calendar yesterday 15:00" phrasing is out of scope. The card's shape stands; its source changes.
- **Witness card** (CAP-7): flag icon, the slipped self-deadline stated with its slip history, and chips (keep / move / drop). A question, never an alarm.
- **Receipt** (CAP-2): one line per filed item — mono destination chip + gist — then unplaceable ones as an amber question quoting the fragment verbatim. Closes with the tally (`5 in → 4 filed, 1 question`) and where they landed.
- **External reads** render as a tool pill (mono, wrench, done-check), same idiom as any agent surface.
- **Composer** invites all three modes: ask, dump, or paste anything. No Ultra chip here — ultra's mutating tools dereference a project, which the master lacks.
- The surface states its own contract in the footer: pull-based, it never notifies.

## 2 · Desk rail

- Fixed-width right rail, same pattern as a session surface's sidebar. Header shows count.
- Card: title, optional project tag (mono), optional hint line. `unplaced` cards are **dashed** with an amber question icon.
- A card the conversation just touched is border-highlighted **in place** — talking about an item edits it without moving it.
- Dismiss (✕) appears on hover and **drains to the queue**. The rail's footer states this: *dismissing a card sends it here — nothing is deleted*.

## 3 · Queue (`workspace-queue`)

The app's proven list idiom: search-first toolbar, lane filter chips, collapsible groups, dense rows.

- **What's-next card** pinned above the list: the single suggested move with its reason and a rough size, plus `Open` / `Not this`.
- **Lane filter chips** with counts, ending in a dashed `+ lane` — lanes are the user's to split, rename, retire.
- **Group header** (sticky): lane label, count, structural provenance note when the lane was split, and its coarse window right-aligned.
- **Row**, left to right: checkbox · rank · sub-task disclosure · title · `done/total` when sub-tasks exist · packet tallies (paperclip = files, template = mockups) · provenance tag · deadline chip · verdict chip · project chip (or `floating`, plus mirrored ref).
- **Sub-task rows** expand under the parent, indented, inside the same group — never as queue entries.
- **Footer line** states the conservation law with live numbers: total items, *agents added 0*, and that sub-tasks never grow the count.
- **Batch bar** (sticky, on selection): count · the master's one-line reason the selection coheres · `Weave as one loom` / `Sessions, one each` / `Clear`. On weave it becomes the **detach receipt** in place — mono, one line, naming premise + context and that it detached from the workspace.
- **Tracking rows:** after a weave the member rows **stay in the queue**, marked as tracking the loom. They leave only when it lands and the human accepts — never at weave time.

### Chip grammar (shared, `shared.tsx`)

| Chip | Rendering rule |
| --- | --- |
| Deadline | External = solid outline; **self = dashed**, suffixed `· self`, and `· slid ×N` when it has slipped |
| Verdict | `→ session` / `→ loom`, tinted fill |
| Project | Mono project name; mirrored adds a dot-icon + foreign ref; **absent = `floating`** |
| Provenance | Free-form label in a quiet mono outline — no icon set, no channel typing |

These chips are identical wherever an item appears. That sameness is the point: a task seen from a session must be recognizably the same task.

## 4 · Packet detail (`workspace-packet`)

Two columns: the substance left, the ripening history and handoff right.

- **Header:** lane + rank breadcrumb, title, then project / deadline / verdict chips.
- **Born as:** the raw fragment verbatim in mono, with its source and time — followed by a transition line naming who fixed it and when, then the fixed brief with acceptance criteria beneath a rule.
- **Gathered along the way:** attachment cards; agent-drafted ones are **dashed** and wear a `proposal` badge.
- **Ripening:** vertical timeline, one node per event — actor icon (you / expert / bed mode), timestamp, `· proposal` suffix on agent output awaiting a look.
- **Its turn came:** `Plan loom from this packet` (primary) · `Start a session instead` (equal weight, outlined) · `Not now — back to the stack`. Closes with *everything above was prepared by agents — nothing runs until you click*.
- On handoff the block becomes the **detach receipt**: premise = fixed brief + acceptance, context = N attachments, detached — plus the note that the packet stays as the loom's origin receipt and preparation runs on the loom's own graph.

## 5 · In-session access (`workspace-in-session`)

A normal project session with workspace tools aboard — the proof that tasks are a Telar-wide substrate.

- Tool calls render as the same mono tool pill (`workspace.tasks · list project:aurora`).
- The answer renders **compact task rows using the same chips as the queue** — same task, recognizably.
- Creating an item from a session confirms: rank and lane, any ordering note, `Provenance: this session`, that it is on the workspace desk, and that the master will carry it into the next briefing.
- The tool pills are real in v1 — the workspace MCP server ships with the module (see `brownfield.md`), so this surface is not deferred behind a later toolset.
- Footer states the substrate claim: every surface reads and writes the same tasks.

## Cross-surface invariants

1. **One chip grammar** — deadline, verdict, project, provenance render identically on every surface.
2. **The detach receipt is one line, one grammar** — identical from birth session, batch weave, or packet handoff.
3. **Approval-gated advance renders as `ApprovalCard`** — mono header, proposal text, Approve/Hold — for `weave_batch`, lane splits, and any agent move-forward.
4. **Dismiss drains, never deletes** — stated in the UI wherever the action exists.
5. **No clock anywhere.** Timestamps are labels. Nothing counts down, nothing fires.
6. **Agent honesty on screen** — bed-mode runs report `0 started`; the queue reports `agents added 0`; proposals are visibly dashed.
