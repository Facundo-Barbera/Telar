---
id: SPEC-organization-workspace
companions:
  - ui-contract.md
  - item-model.md
  - brownfield.md
  - ../../project-context.md
  - ../../brainstorming/brainstorm-loom-ux-ui-2026-07-23/conversation-component.md
sources:
  - ../../brainstorming/brainstorm-organization-workspace-2026-07-23/brainstorm-intent.md
  - ../../brainstorming/brainstorm-loom-ux-ui-2026-07-23/brainstorm-intent.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Organization Workspace

## Why

A vision to realize, forced by a pain that agent speed created. Work that took months now takes hours, so far more tasks are in flight, across more projects (work + school), with no order among them — and the real cost is no longer execution, it is **warm-up**: re-entering an untouched project routinely takes longer than the work itself. The bedrock need is calm, not speed — Facundo must be able to put a project down under pressure and pick it back up without anxiety. Notifications are a dead channel for him (he reacts instantly or never), so the system must be pull-based end to end. This module is the connective tissue between the real world, the product vision, and the dirtiness of multi-tasking: docs without order are just text in a repo, and Jira-style methods assume pre-agent pace. It is a **context bank**, not a todo app — snippets, notes, meetings, and agent activity are deposits; "where am I at" is the withdrawal. The calm mechanism is asymmetry: what stresses him ("everything I need to do") is already-known ground for the system.

## Capabilities

- **CAP-1** Project-less master chat
  - **intent:** User opens one project-less conversation — the module's front door — and asks where they stopped; it answers with the sit-down overview: what happened while they were away, where each project was left, what today holds, and a suggested first move.
  - **success:** With no project selected, a session runs and returns a briefing covering all four bands, sourced from durable on-disk state rather than conversation history. The surface never initiates contact — it answers only when arrived at.

- **CAP-2** Brain dump → receipt
  - **intent:** User dumps everything from multiple projects in one unstructured go; the master parses, splits, routes each fragment to a project or leaves it floating, and confirms back with a receipt that names what it could not place.
  - **success:** A dump of N fragments spanning ≥2 projects yields a receipt accounting for exactly N (`5 in → 4 filed, 1 question`), each filed line naming its destination, each unplaceable one asked about verbatim rather than guessed. Nothing is invented.

- **CAP-3** Desk rail
  - **intent:** Items the agents create land on a persistent right rail beside the chat, where the user can edit them by talking about them, without them moving; dismissing one drains it to the queue.
  - **success:** Referring to a desk item in conversation updates it in place (card stays put, marked as just-updated); dismissing removes it from the desk and it is findable in the queue. No path deletes an item.

- **CAP-4** Queue with dynamic lanes
  - **intent:** User sees every item as a dense grouped list, grouped by coarse context lanes each holding an ordered stack; lanes are theirs to split, rename, and retire as life changes, and the master may propose a split when a cluster crowds a lane.
  - **success:** Lanes render as user-defined data (never a fixed enum) with per-lane counts, coarse windows, and structural provenance on split lanes; a master-proposed split takes effect only after explicit human approval. Order is stack position — no clock, no schedule. Stack order and live conversational reprioritization ("what's next?") both work and stay in agreement — neither is the sole ordering mechanism.

- **CAP-5** Item spectrum with sub-tasks inside
  - **intent:** An item ranges from a one-line todo to a rich packet holding files; work discovered mid-item becomes a sub-task **inside** that item rather than a new queue entry, and only the human may promote one out to standing on its own.
  - **success:** Breaking an item into sub-tasks leaves the queue's item count unchanged and renders as `done/total` on the parent row. Richness is optional — a bare one-liner is a valid item. A human-promoted sub-task becomes a standalone item carrying its parent as provenance; no agent path exists to promote one.

- **CAP-6** Work packet ripening
  - **intent:** A raw captured fragment matures over days into an execution-ready briefing — an expert-written fixed brief with acceptance criteria, attachments gathered along the way, and a timeline attributing every change to the user, an expert, or bed mode.
  - **success:** A packet shows its original raw fragment and source alongside the fixed brief plus acceptance criteria; each timeline event carries actor and timestamp, and agent-generated ones awaiting a human look are marked as proposals. At execution time the packet *is* the briefing — nothing is re-authored for handoff.

- **CAP-7** Deadlines as data, with a self-deadline witness
  - **intent:** Deadlines are attributes of an item, not entries in a schedule, and distinguish externally-imposed from self-imposed; self-deadlines remember how often they slid, and the master raises slipped ones in the briefing as an honest reset-or-drop question.
  - **success:** External and self deadlines are visually and structurally distinct, self ones carrying a slip count; a self-deadline that has slid surfaces in the next briefing offering keep / move / drop. No alarm, no notification, no clock-driven trigger.

- **CAP-8** Expectation gap detection
  - **intent:** Time-commitments spoken inside captures ("we'll sync Thursday") are mined as expectations; when an expected moment passes with nothing captured from it, the master says so in the briefing and offers ways to fill the gap.
  - **success:** A mined commitment whose moment has passed with no linked capture produces a gap line in the next briefing naming the commitment and when it was expected, with capture options (paste transcript / mark no-notes / dump now). Gap detection reads expectations only — it never creates an item on its own.

- **CAP-9** Ephemeral per-project experts
  - **intent:** Each project has an expert agent that is spawned per call and rehydrated from that project's on-disk digest, so it can decompress shorthand a generic agent cannot, translate the project's own methodology, and judge whether an item should be executed as a session or a loom.
  - **success:** An expert invoked cold produces project-correct interpretation of a fragment using only the on-disk digest and returns a session-or-loom triage verdict that renders on the item, with its reasoning recorded on the packet timeline. The verdict is advisory: a human override is durable, and a later expert pass does not re-flip it. No expert process persists between calls.

- **CAP-10** Bed mode
  - **intent:** Overnight, Telar performs organization work unattended within a fixed scope — routing captures, fixing raw fragments into briefs, drafting attachments, and pulling foreign issue state into Telar's view — and reports it as a bounded digest the next morning.
  - **success:** A bed-mode run reports as actions-taken with **zero** started and zero completed; every artifact it produced is marked a proposal awaiting a human look. It creates no queue item, and its mirror sync is read-only. The digest is bounded by what the user can absorb, not by what the agents did.

- **CAP-11** Loom and session handoff
  - **intent:** When an item's turn comes, the user hands it to execution — a ripened packet becomes a loom's premise + context, or several selected items weave as one loom that carries them all — and the loom detaches, leaving the origin behind as a receipt.
  - **success:** Both handoffs emit the universal one-line detach receipt (premise + context · detached) in place; the packet remains as the loom's origin receipt. Batched rows **stay in the queue** marked as tracking the loom, and leave only when it lands **and** the human accepts — departure stays gated on the accept moat. "Start a session instead" is an equal-weight alternative on both.

- **CAP-12** Tasks as a Telar-wide substrate
  - **intent:** Items are not the Workspace surface's private data — any session anywhere in Telar can read its project's slice, create items, and modify them through a workspace tool surface, with provenance recording which surface did it.
  - **success:** Asking a normal project session "what are the tasks here?" returns that project's slice rendered with the same chips as the queue; creating one from that session files it into the right lane, stamps provenance to that session, places it on the desk, and carries it into the next briefing. Access is via the in-process workspace MCP server — no session needs write access to the store's directory.

- **CAP-13** External sources as reference
  - **intent:** A roster of **external** MCP servers, scoped to the workspace, lets the master read outside systems as reference material — distinct from the internal workspace tool server of CAP-12 — so the user can ask what is waiting on them elsewhere without those systems becoming an inbox.
  - **success:** The master answers a question about an external tracker by reading it live and states plainly that the results are not tracked in Telar; an external record becomes an item only on explicit human say-so.

## Constraints

- **Pull, never push.** Notifications are a dead channel; no surface in this module notifies, pings, badges, or interrupts. It answers when arrived at.
- **Prepare, never commit.** Agents (bed mode, experts, the master) may file, draft, ripen, propose, and sync *inbound* — they never start work, complete work, or write outward to a foreign system. This is the human-accept moat applied to organization, and it is what makes touching foreign or mirrored project structures safe.
- **Compress, never multiply (conservation of the queue).** Item count grows only when reality grows — a real meeting, a real request. Agents may fan out *inside* a packet, never at the queue level. Sub-tasks are the pressure valve for work discovered mid-item.
- **Capture raw, understand later.** Capture is zero-ceremony (he is mid-meeting); understanding is a deferred enrichment pass routed through the project's expert. Ambiguity is resolved in the next chat, never by a ping.
- **Experts write, master reads.** Experts produce durable state digests on disk; the master is a thin reader — receptionist, not manager. State lives on disk, not in the conversation; this is what removes the context-window ceiling.
- **Foreign structures stay foreign.** For projects Telar does not own, it makes the existing structure (issues, handoffs, mockups) part of itself rather than imposing its own. Native projects: Telar is source of truth. Mirrored projects: Telar holds a view with pointers back, and the expert doubles as translator of that project's methodology.
- **The master is a full harness session** (CC/Codex CLI, like project sessions — not an SDK-native agent), **resolved as a `SessionProfile` per `SPEC-runtime-foundations` CAP-7 rather than as a conditional branch in the chat route**: `cwd` = the dedicated empty subdirectory `TELAR_HOME/workspace/home` — never the store root itself, so `lanes.yaml` and `packets/` stay outside the master's path-based write boundary — `settingSources: []`, default guardrails, MCP injected programmatically. A new session kind adds a profile; it does not add an `if`, and the `PreToolUse` guardrail stays outside the profile so no profile can skip it. Never use `/Users/facundo` as cwd — trust never persists there, and per-directory keying means a stable home accrues one continuous history bucket while scratch dirs fragment it. See `brownfield.md`.
- **Codex reaches workspace tools via per-invocation config injection.** `runCodexTurn` has no MCP plumbing today; closing that gap is in scope for a Codex-backed master, not incidental. See `brownfield.md`.
- **Sub-agent scope is inverted here.** Sub-agents normally inherit the caller's project; in this module the master has *no* project and each expert it calls is scoped to its own. Any agent plumbing that assumes a sub-agent inherits the caller's project breaks the master.
- **Lanes are data, never an enum**, and lane structure changes are human-accepted: the master proposes, the human approves.
- **No clocks and no scheduling.** Order is stack position; deadlines are chips on an item. Nothing in this module is driven by wall-clock time, and a stack cannot silently slip the way a timed plan can.
- **Provenance is a free-form label, not a channel type** — there is no capture-channel enum to switch on.
- **The store is `lanes.yaml` + `packets/<id>/`** under `TELAR_HOME/workspace`: `lanes.yaml` holds lane definitions and their ordered id stacks; every item — one-liner or rich — is a `packet.yaml` in its own directory with attachments as siblings. Structure and content stay separate, and all writes follow core's atomic-write idiom (`.tmp` → rename). See `item-model.md`.
- **Cross-surface access goes through the in-process workspace MCP server** (same pattern as `loom-mcp` / `ultra-mcp`), never through raw file tools. Project sessions are sandbox-bound to their own working root, so file access to the store is not merely untidy — it does not work. See `brownfield.md`.
- **Only the human promotes a sub-task** out of its parent. Agents have no promotion path, proposed or otherwise.
- **Approval-gated advance is the protocol shape** wherever an agent wants to move something forward (`weave_batch`, lane splits): proposal → explicit human approval → effect, rendered as the shared `ApprovalCard`.
- **The detach receipt grammar is universal** — one mono line, identical whether it fires from a birth session, the queue's batch weave, or a packet's handoff.
- **Master chat is born on the shared `Conversation` shell** as an owner adapter, not a bespoke chat window. See `conversation-component.md`.
- **Tone law:** surfaces show state and data only — no suggestion-text, no doctrine captions in the UI.
- **Project-wide rules in `project-context.md` bind**, notably the client-bundle rule (`@telar/core` is server-only), atomic writes for all state, the single status vocabulary, and the quiet-color law (hue on the icon only).

## Non-goals

- **No capture-channel integrations in v1.** Screenshots, clipboard, voice memos, email forwarding, GitHub issues, Telegram, Telar Notes, and Granola were enumerated as ideas; none are built. v1 is hand-fed — typed, pasted, or dropped into a Telar surface.
- **No capture-channel taxonomy.** The proposed push-vs-watch split is explicitly not adopted as a formal model; provenance stays free-form.
- **No board view.** Retired in favor of the dense grouped queue.
- **No Telar-authored schedule or agenda.** Telar generates no agenda of its own.
- **No external calendar in v1.** Gap detection (CAP-8) runs only on commitments mined from the user's own captures. Reading a real calendar — Google, Apple, or otherwise — is deferred; when it lands it rides the CAP-13 workspace-MCP mechanism rather than becoming a named integration.
- **No notifications, alarms, badges, or push of any kind** — including for deadlines that have passed.
- **No always-alive expert agents.** Rejected for usage cost and context-keeping; experts are ephemeral by construction.
- **No deletion path.** Dismissing drains to the queue; nothing in this module deletes an item.
- **No agent-initiated sub-task promotion**, and no agent write-back to a foreign tracker by any agent at any time. Mirror sync pulls only.
- **No agent-initiated execution.** No agent starts work, completes work, or accepts a loom — the accept moat is untouched by this module.
- **No auth or multi-user model.** Inherits Telar's local single-user posture.
- **No loom-internals work.** This module hands off premise + context and stops at the detach boundary; the graph, gate, cockpit, and delivery surfaces belong to the loom specs.

## Success signal

Facundo sits down after a night away, opens one project-less chat, and asks where he stopped. In one screen he gets what bed mode did (proposals only, nothing started), where each project was left, what today holds across lanes, and the one move that unblocks someone else — plus an honest question about a self-deadline that has slid twice, and a gap where a sync he'd mentioned in an earlier capture came and went with nothing recorded from it. He dumps five loose fragments spanning three projects in one paragraph and gets back a receipt for exactly five: four filed, one asked about. Later that day a packet that ripened over three days hands its fixed brief and attachments straight to a loom, which detaches — and he never once received a notification.

## Assumptions

- The demo-gallery workspace mockups (`apps/web/lib/demo-gallery/workspace/**`) are the as-built rendering of the intended contract; `ui-contract.md` freezes what is contractual. Their static fixture state (pre-checked rows, one-shot `woven` toggles, hardcoded timestamps) is mockup-only.
- "Hand-fed v1" means capture happens by typing, pasting, or dropping into a Telar surface — no external channel listeners, watchers, or webhooks.
- The `Conversation` component extraction lands before or alongside master chat, since the loom-UX plan states new surfaces are born on it rather than hand-rebuilt.
- Bed mode's "0 started" reporting is a real invariant to assert against, not display copy.
- Mining time-commitments from captures (CAP-8) is expert work during the enrichment pass, not a separate parser — the expert already reads every capture.
