# UX — The Six Surfaces and the Shared Design Language

Companion to `SPEC.md` (CAP-1, CAP-5, CAP-17, CAP-23, CAP-24).

Each surface was prototyped live as demo-gallery entries under `apps/web/lib/demo-gallery/**`, registered in `registry.ts` under groups `ux-birth` … `ux-workspace`. **These prototypes are design source of truth, not production code** — production still runs the current dashboard and `session-view.tsx`. Walk them at `/demo-gallery`.

## UX 0 · Birth of a loom — `birth/`, entry `birth-dial`

The front door. One real session (production bubble idiom, `WorkingIndicator`, composer) is where every ask starts.

- Below the simple-task boundary the agent just does it inline ("Do it here") — no loom, no graph; a screenshot closes it.
- Above it, "Spin off" leaves exactly two things in the chat: a **detach marker** and a one-line mono **receipt** (`premise + context · detached`). No graph preview, no progress narration, no loom door inside the session.
- One design plays at every weight (one stitch / few stitches / tapestry); size shows only in how much the loom's own graph does, never in a different UI.

## UX 1 · Home — `home/`, entry `home-current`

A **graft onto the existing production dashboard**, not a replacement: same KPI hero, two-column command deck, rails and panel grammar.

- **Needs you** moves to top-left and splits into a compressed **delivery-shelf row** (claim, proof tally, risk flag, Accept/Boomerang) and the **parked question verbatim** (answering resumes the loom).
- **Running now** rows gain an **act chip** (prepare / build / verify / repair / parked) and **evidence age**.
- Right column keeps Recent sessions (looms are born there) and adds a **Done-today receipt** and **Hot projects** carrying a map drift note.

Three from-scratch proposals (two-band triage, delivery inbox, map-as-home) were explored and superseded; their ideas live on inside the graft.

## UX 2 · Loom detail — `loom-detail/`, entries `loom-detail-walkable` + `loom-detail-walkable-scale`

The walkable cockpit: one design in two load variants sharing a component kit (`cockpit.tsx`: `ActTab`, `Room`, `ConductorCard`, `ThreadGroup`, `ContractGroups`, `LabRoom`).

- Persistent **Prepare / Execute / Judge** act tabs; **park** and **kill** verbs in the header.
- **Prepare** renders the same sealed DAG map as the gate room (UX 4), frozen as a receipt.
- **Execute** pins the conductor (holds-no-pen; beat-vs-flatline heartbeat) over dense thread rows. Drilling a thread opens the team view — compiled flow, per-node context manifests, builder lanes in worktrees, thread-altitude rungs, and per-agent transcripts in a right drawer with live streaming.
- **Judge** shows the contract lighting up as work completes.
- Header carries the **WINDOW** (live merged-so-far URL, on-demand borrow at scale), the **LAB** (service registry — scope, lease token, trust wall) and **CHATS** (steering thread always open, intake reopenable).
- The scale variant (11 threads, 3 workstream labels, one orchestrator) demonstrates the full live-escalation path: amber attention strip, pinned chats row, "N needs you" tab meta, ladder inner → mediation → you.

## UX 3 · Delivery card — `delivery/`, entry `delivery-final`

The accept surface, converged from three proposals (the dossier, the coffee inbox, see-it-in-work) that turned out to be **altitudes of one judgment, not rivals**.

- The **SHELF** is the fleet-scale skim: claim, proof strip, risk flags, release grade, verdict in place.
- Opening a card is **taste-first**: the live product on its frozen final-verify lane leads; a filmstrip flips between the live lane and ledger screenshots.
- **Below the glass, the courtroom scrolls**: reality manifest, cited narrative (the one uncited claim wears "unverified"), contract with per-assert citations, provenance-stamped evidence ledger, full attempt history with flaky flags, vision critic's advisory verdict.
- A shared **`VerdictBar`** — Accept declares the map note and queues silent landing; Boomerang opens the composer and send resumes — is **one verdict per delivery**, shared between shelf row and open card.

## UX 4 · Readiness gate — `prep-gate/`, entry `prep-gate-final`

"The gate room," merged from proposal A (war table, direct manipulation) and B (two-handed: chat left, graph right), leaning B.

- The preparation DAG is a **pan/zoom map center-stage**.
- Clicking a node **inverts the proportions**: a dominant left pane opens that node's conversation (history rail, "+ new chat", composer); the map shrinks right and zooms only itself.
- **The gate is a node like any other** — its session is the steering chat (chips fire real edits) and its pane carries the verdict controls: unprovables first, degraded-mode ack gates Accept, Modify wakes nodes, Deny → straight to dev.
- Waking a dormant node (e.g. the PRD) triggers an **approval-gated `advance_node`**; approving grows a new elbow edge into flow compile — an audited recompile.

## UX 5 · Workspace — `workspace/`, entries `workspace-home`, `workspace-queue`, `workspace-packet`, `workspace-in-session`

The project-less front door, designed in the organization-workspace session and integrated here. **Only the loom-birth seam is in scope for this spec** (see the kernel's non-goals); the surface is documented here because the seam lives inside it.

- Master chat is a real session (production bubble idiom); agent-created items land on a right-rail **Desk**; dismissing drains to the **queue** (never deletes).
- **Seam 1 — batch weave:** the queue's "Weave as one loom" batch action yields the UX 0 detach receipt in place, producing one loom that carries N tasks.
- **Seam 2 — packet handover:** a ripened work packet's "Plan loom from this packet" hands over premise (fixed brief + acceptance) plus context (attachments); **the packet stays behind as an origin receipt**.
- A fourth entry shows tasks as a Telar-wide substrate reachable from any session via workspace MCP.

## Doctrine locked by the UX session

- **Looms are born from sessions, and detach.** The session's entire role in a birth is handing over premise plus maybe some context — nothing more. The loom never sticks to that chat.
- **The decision graph always exists.** Not decoration, not an optional ceremony step: every element is an actual session that must happen or be explicitly skipped before the loom can start.
- **The graph is a true branching DAG that converges.** Not a linear checklist — nodes bloom, branches close back together, everything converges into the gate. Drift-spawned nodes and woken dormant nodes both grow new edges live.
- **ONE design for looms, at any size.** No small/medium/large split. Small work stays a plain session with no loom and no graph; the moment something becomes a loom it takes the full shape.
- **Agents advance graph nodes only via approval-gated tool calls.** `advance_node`, `weave_batch` and the ack-gated Accept are one protocol shape: proposal → explicit human approval → effect.
- **The graph is never shown inside the session's UI.** It belongs entirely to the loom's own pages. (This was corrected twice before landing.)
- **Ceremony scales, the walls never do.** The dial changes how much process is visible, never whether branch, evidence and human-accept hold. Even the one-stitch loom gets a worktree and a screenshot, and "Land it" **is** the accept moat.

## Shared design language

**Map/DAG rendering rules** — the gate room's kit, generalized and reused as the frozen Prepare receipt in the cockpit via `GateGraph(nodes, edges, gateState)`:

- grab-to-pan viewport (not a scroll container);
- scroll-wheel zoom anchored at the cursor;
- rounded 90°-elbow SVG edges;
- node sub-text that **never truncates** — a short one-line sub is always visible, and the **selected** node expands downward only, into the row gap, never overlapping a neighbor, while every other node dims to 65%;
- glide-to-node measures after a double `requestAnimationFrame` with an eased cubic-bezier, to kill flicker;
- a **"sealed"** gate state (muted lock) renders the same map as a frozen receipt.

**Detach receipt grammar** — one mono line, `premise + context · detached`, identical whether it fires from the birth session, the queue's batch weave, or a packet handover.

**`ApprovalCard` idiom** — mono header ("tool call — awaiting your approval"), the proposal text, Approve/Hold. One component, one protocol shape, every approval-gated advance.

**Tone law** — no suggestion-text or doctrine captions anywhere in the UI (never render "threads land serially, on green"). Surfaces show state and data only.

**Existing visual tokens to honor** — grayscale chrome, hue as state signal only, the single `Tone` vocabulary (`done | attention | danger | active | muted`) from `components/looms/status.tsx`, 3px state rails, tinted-outline badges.

## The `Conversation` component

The chat window was hand-rebuilt in all six lanes with the same anatomy (transcript + optional composer + optional right rail + inline tool activity) — proof it should be one component. Three layers: primitives (including two the demos proved out, `Marker` and `ApprovalCard`), the `Conversation` shell (item-kind registry, pluggable composer/rail/header slots, owns scrolling and streaming, owns no data fetching or session semantics), and per-surface owner adapters. Migration is a pure-render carve-out of `session-view.tsx` at the render seam.

Full plan: `conversation-component.md` (adopted companion).

## Fixtures

The prototypes share **one fictional day** across lanes so cross-lane coherence is judgeable: aurora payments-retry is the hero delivery on home and recurs across surfaces; novarix search-filters is born (UX 0), drafts at home (UX 1) and is gated (UX 4); ozom client-role-seeding anchors the UX 2 baseline; novarix P12 usage-based billing anchors the UX 2 scale variant and its live escalation.
