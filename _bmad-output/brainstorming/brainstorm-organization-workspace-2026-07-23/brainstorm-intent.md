# Organization Workspace — Brainstorm Intent

> **Resolved since — 2026-07-24.** This document is the record of the 2026-07-23 session and its prose stands as written. The decisions below were taken later, during spec distillation, and **supersede it where they conflict**. The contract now lives in `_bmad-output/specs/spec-organization-workspace/` (SPEC.md + companions); its `.memlog.md` carries the full reasoning.
>
> **All six §6 open questions are closed:**
> - **Master session shape** → full harness session (CC/Codex CLI), `cwd` = `TELAR_HOME/workspace/home` (a dedicated empty subdir — the conciliation pass moved it off the store root so the store stays outside the master's write boundary), `settingSources: []`, project gate skipped, MCP injected programmatically.
> - **Bed-mode autonomy scope** → four actions: route captures, fix raw fragments into briefs, draft attachments (always marked proposal), pull foreign issue state inbound. Creates no queue item; mirror sync is **read-only**.
> - **Task/packet store format** → `lanes.yaml` (lane defs + ordered id stacks) + `packets/<id>/packet.yaml` with attachments as siblings, uniform for one-liners and rich packets. Confirms the coach idea §6 floated.
> - **Formal workspace MCP toolset** → **ships in v1**, superseding §4's "hand-fed v1 … formal toolset later." Codex's sandbox write boundary is working-root + `--add-dir`, so a project session physically cannot reach the store with file tools — the substrate does not work without it.
> - **Sub-task promotion** → human-only; the promoted item carries its parent as provenance. No agent path exists.
> - **Batch execution representation** → member rows stay in the queue marked as tracking the loom, leaving only when it lands **and** the human accepts.
>
> **Parked ideas, adjudicated:**
> - **Self-deadline renegotiation ritual** → **adopted** (the `slips` counter and Witness card were already built in the 24 Jul mockups).
> - **Calendar as expectation source** → **split**. Gap detection is adopted as a capability, but reading an external calendar is **out of v1** — v1 mines time-commitments from captures only. The mockup's "was on your calendar" example is explicitly out of scope.
> - **Capture channel push/watch taxonomy** → **rejected**; provenance stays a free-form label, per `fixtures.ts`.
>
> **Also promoted from observation to required work:** the §5 Codex MCP gap. `runCodexTurn` has no MCP plumbing, so a Codex-backed master cannot reach workspace tools until `-c mcp_servers.*` overrides are wired.

## 1. The need (bedrock)
Facundo runs many concurrent projects (work + school) and needs to stay organized without losing captured context (meeting snippets, notes, tasks). Agent speed inverted the old bottleneck: work that took months now takes hours, so far more tasks are in flight than before, across more projects, with no order among them. The bedrock need is calm, not speed: he should be able to put a project down under pressure and pick it back up without anxiety. The real cost today is warm-up — re-entering an untouched project often takes longer than the work itself. Notifications are a dead channel for him (instantly-or-never, no late reaction), so the system must be pull-based, never push. This module is the connective tissue between the real world, the product vision, and the "dirtiness of multi-tasking" — docs without order are just text in a repo, and Jira-style methods assume pre-agent pace.

## 2. Product concept
The module is a **context bank for calm multi-tasking**, not a todo app: snippets, notes, meetings, and agent activity are deposits; "where am I at" is the withdrawal. Its front door is a single, project-less **master chat** that gives the sit-down overview (priorities, what's pending, what agents did overnight) and can be told everything in one go (a **brain dump**) which it parses, routes, and answers with a **receipt** ("6 items, 3 projects, filed these, 2 unplaceable"). Behind the master sit **ephemeral per-project expert agents**, rehydrated from an on-disk project digest whenever called — ephemeral because the master reads durable state, not live conversation. Work items **ripen**: a raw fragment becomes a fixed todo, accumulates context (mockups, meeting excerpts, expert analysis), and at execution time IS the loom/session briefing — the BMad story-file concept made native to Telar. The calm mechanism is asymmetry: what stresses Facundo ("everything I need to do") is already-known ground for the master.

Load-bearing metaphors: context bank (deposit/withdrawal), morning-resume conversation, master as receptionist not manager, brain dump / receipt as bookends, work packet that ripens, desk (persistent right-rail), queue with dynamic lanes/stacks.

## 3. Laws / invariants
- **Pull, never push** — notifications are a dead channel; the system answers when asked, never interrupts.
- **Prepare, never commit** — agents (bed mode, experts) may file, draft, ripen, or sync, but never start or complete work themselves; this is the accept-moat applied to organization, and it's what makes foreign/mirrored project structures safe to touch.
- **Compress, never multiply (conservation of the queue)** — the queue's item count grows only when reality grows (a real meeting, a real request), never because an agent got creative; agents may fan out *inside* a packet, never at the queue level; bed mode's output is a digest bounded by his attention.
- **Capture raw, understand later** — capture stays zero-ceremony (he's mid-meeting); understanding is a deferred enrichment pass, routed through the project's expert agent, who can decompress shorthand a generic AI can't; ambiguous leftovers get resolved in the morning chat, never via pings.
- **Experts write, master reads** — experts produce durable state digests on disk; the master is a thin reader (receptionist, not manager) — this is what dissolves the context-window fear, since state lives on disk, not in the conversation.
- **Foreign structures stay foreign** — for projects Telar doesn't own, it makes the existing structure (issues, handoffs, mockups) part of itself rather than imposing its own; native projects = Telar is source of truth, mirrored projects = Telar holds a view with pointers back, and the expert agent doubles as translator of that project's methodology.

## 4. Decided shape

### Surfaces
- **Master chat** — single project-less front door, the overall view.
- **Desk** — right rail (session-sidebar pattern), for persistent agent-filed items.
- **Queue** — dense grouped list (board retired); dismiss drains an item to the queue, never deletes it.
- **Packet detail** — the ripening-work-packet view.
- **In-session access** — tasks substrate reachable from inside a project session.

### Agents model
- **Master**: project-less, orchestrates experts, calls them at will (inverted sub-agent scope: sub-agents normally inherit the caller's project, here each expert is scoped to its own project while the master has none).
- **Experts**: ephemeral — spawned per call, rehydrated from the on-disk project digest; always-alive agents were rejected as bad for usage and context-keeping.
- **Bed mode**: Telar performs organization tasks autonomously overnight; bounded by prepare-never-commit; exact scope of autonomy is undecided (see Open questions).

### Items model
- Spectrum from one-line todos to rich **work packets** that can hold entire files (mockups, docs) — richness is a spectrum, not a requirement.
- **Sub-tasks** live inside items — the conservation valve for work discovered mid-item.
- **Batches**: select N items → weave as one loom series.
- **Deadlines as data**, not schedule — including flexible **self-deadlines** for work with no external time limit.
- **Dynamic lanes**: context lanes (office/school/free — coarse, shifting) each hold an ordered stack; lanes carry structural provenance (master may propose splits, human accepts). A stack can't silently slip the way a timed plan can (slippage = guilt = anti-bedrock).
- Ordering combines this stack/lane model with live, conversational reprioritization ("what's next?") — both modes coexist; no dedicated schedule/clock.

### Capture model
- **Hand-fed v1** — tasks are a Telar-wide substrate; any session can read/create/modify via workspace tools, and provenance records which surface created an item.
- **No integration enum** — capture channels were enumerated as ideas (screenshots, clipboard, voice memos, email forwarding, GitHub issues, Telegram, Telar Notes, Granola, agent chats) but none are committed as built integrations for v1.
- **Brain dump + receipt**: he dumps everything from multiple projects in one go; the master parses, splits, routes, and confirms back with a receipt, naming what's unplaceable.

### External sources
- Read via **workspace-scoped MCP servers** — reference, not inventory; nothing becomes a task unless he says so.

## 5. Feasibility (verified)
- **Telar coupling**: project coupling lives in the chat route, not the engine. `engine.ts` `agent()` takes `cwd` as an optional param (falls back to `process.cwd()`), with zero manifest dependency. The one hard gate is `route.ts`'s `getProject(project).manifest` → `workspace=manifest.root`, which feeds cwd, guardrails, and settingSources.
- **Pre-existing gap**: Codex sessions never receive project MCP servers today — `resolveProjectMcpServers` is wired only on the Claude branch (SDK `mcpServers` + `strictMcpConfig:true`); `runCodexTurn` has no MCP plumbing at all.
- **Project-less chat is nearly free**: `store.ts` `Chat.project` is already optional; permissions are string-keyed (a synthetic `'__master__'` works); session-log is keyed by sessionId only; loom/ultra MCP servers dereference project only lazily, inside mutating tools. Remaining blockers: the upfront project gate, a synthetic cwd, default guardrails, and `settingSources:[]`.
- **Claude Code**: cwd is incidental, not hard-required — an empty non-git directory works fine empirically; there's no dedicated no-cwd mode (process cwd is always used), but SDK cwd is optional with a `process.cwd()` default. `settingSources:[]` zeroes ambient config discovery. MCP injection is fully programmatic (`mcpServers` + `strictMcpConfig`, already used by Telar). The trust dialog is skipped in non-interactive/SDK mode. Session history and auto-memory are keyed **per-directory** (`~/.claude/projects/<encoded-path>`) — a stable master cwd accrues one continuous history/memory bucket, while throwaway scratch dirs fragment it. Never use `/Users/facundo` itself as cwd — trust never persists there.
- **Codex**: also no no-cwd mode; `-C`/`--cd` sets the working root and the directory must exist. An empty non-git dir works once `--skip-git-repo-check` (SDK: `skipGitRepoCheck`) is set. The sandbox's workspace-write boundary is working-root + `--add-dir`, purely path-based. Per-invocation MCP injection is verified two ways with zero global config: `-c mcp_servers.<name>.<field>` dotted overrides (SDK: config object → repeated `--config` flags), or `CODEX_HOME` pointed at a synthetic dir; `--ignore-user-config` gives config-file-free runs. This closes Telar's Codex MCP gap.
- **Conclusion**: neither harness has a true wd-less mode, but neither needs a *meaningful* one — both run fine in an empty directory (Claude Code natively, Codex with the skip flag). Both key state per-directory (CC history+auto-memory, Codex trust+sandbox writable roots), which argues for **one stable synthetic home** (`TELAR_HOME/workspace`) over throwaway scratch dirs. Master session shape: skip the project gate, cwd = workspace home, `settingSources:[]`, default guardrails, MCP injected directly (Codex wired via `-c` overrides to close its gap).

## 6. Open questions

> **Superseded 2026-07-24** — every question below is now answered, and both live parked ideas adjudicated. See *Resolved since* at the top of this file. Preserved as the record of what was genuinely open on 2026-07-23.
- **Master session shape**: whether the master runs as a full harness session (CC/Codex CLI, like project sessions) or a lighter SDK-native agent — research covered feasibility on both the CLI and SDK sides but never committed to one.
- **Bed-mode autonomy scope**: explicitly flagged as an open design question by Facundo; the only constraint set so far is prepare-never-commit — the concrete list of what bed mode is allowed to do overnight is undecided.
- **Task/packet store format**: how "tasks as a Telar-wide substrate" are actually persisted is unresolved. A coach idea (packets as `workspace/packets/<id>/` directories with `packet.yaml` + attachments) was floated but never confirmed by a user decision, and got entangled with a correction about how MCP config is (and isn't) materialized.
  - **Closed by `SPEC-organization-workspace`** (see the header above): `lanes.yaml` + `packets/<id>/packet.yaml` with attachments as siblings. Independently, `SPEC-loom-redesign` defines both loom-birth paths as a **typed handover** (premise list + context references) rather than a read of this store — consistent with that spec's rule that cross-surface access goes through the workspace MCP server and never raw file tools, which a loom reading `packets/` directly would violate.
- **Formal workspace MCP toolset**: v1 read/write path is harness file tools; a formal MCP toolset for cross-surface task access is acknowledged as coming "later," undesigned.
- **Sub-task promotion**: sub-tasks live inside items as the conservation valve; whether/how one gets promoted to a standalone item is unaddressed.
- **Batch execution representation**: batches are decided at creation time (select N → weave as one loom series); what the queue shows once that loom series is actually running is unaddressed.

### Parked ideas (unconfirmed, potentially valuable)
- Capture channel taxonomy: push (notes, memos, Telegram, email) vs. watch (GitHub issues, agent chats, calendar) — proposed split, not adopted as a formal model; capture stayed "hand-fed v1" instead.
- Calendar as an expectation source for gap detection: watch the external Google/Apple Calendar + mine spoken time-commitments from captures ("we'll sync Thursday"); a watch-input external calendar could coexist with Telar's own generated output-agenda. Doesn't appear in the final decided Ordering shape.
- Self-deadline renegotiation ritual: instead of alarms, the master surfaces slipped self-deadlines in the morning chat ("you told yourself Friday, third slide — reset or drop it honestly?"); silent sliding is framed as the actual failure mode.

## 7. Existing artifacts
UI mockups live in the app's demo gallery: `apps/web/lib/demo-gallery/workspace/**` (fixtures, shared, home, queue, packet, session), registered as 4 entries — `workspace-home` (master chat + desk rail + linear read), `workspace-queue` (dense grouped list, dynamic lanes, sub-tasks, batch action bar), `workspace-packet` (ripening work packet), `workspace-in-session` (tasks substrate from a project session). View at `/demo-gallery`.
