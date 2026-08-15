# The Spool port

`SPEC-organization-workspace` is a finished, preservation-validated contract —
13 capabilities, 20 constraints, 12 non-goals, 0 open questions — and eight of
its thirteen stories are already built in the frozen app. This document is the
plan for bringing it back onto the engine/web split, and the record of every
place the new architecture forces a deviation from what the contract says.

The spec and its three companions (`ui-contract.md`, `item-model.md`,
`brownfield.md`) stay canonical for WHAT to build. This document is only about
WHERE it now goes and WHAT CHANGED — read it beside the spec, never instead of
it.

## The module, in one paragraph

A context bank, not a todo app. One project-less master chat is the front door;
you ask where you stopped and it answers with the sit-down overview. Items the
agents file land on a Desk rail beside the chat and drain into a queue of
user-defined lanes holding ordered stacks. An item ranges from a one-liner to a
rich packet that ripens over days into an execution-ready briefing, and when its
turn comes it hands its premise and context to a loom or a session and detaches.
Its laws: pull never push, prepare never commit, compress never multiply, lanes
are data never an enum, no clocks anywhere, and no delete path.

## Why it is now called Spool

`workspace` is taken. In the v2 protocol it already means the session's working
tree — `SessionWorkspace`, `WorkspaceFile`, `WorkspaceListing`,
`WorkspaceWriteResult` in `packages/engine-client/src/protocol/entities.ts`, plus
`apps/web/components/workspace-environment.tsx` and
`components/session/workspace-inspector.tsx`. `Item` is taken too, and by the
more load-bearing of the two: `protocol/items.ts` is a timeline row, and its
header calls itself "the point of v2".

Two meanings of one word inside one protocol file is the kind of thing that
reads fine to whoever writes it and costs every later reader a disambiguation.
Ultra was renamed to Warp for less. So the organization module is **Spool** —
thread wound and held until the loom needs it, which is what a queue of items
waiting their turn actually is. The handoff grammar falls out for free: the loom
takes it off the spool.

The rename is mechanical and total: `SpoolItem`, `SpoolLane`, `SpoolPacket`,
`SpoolDeskCard`; `/v2/spool/*`; `apps/engine/src/spool/`;
`apps/web/components/spool/`; the MCP server is named `spool` and its tool pills
read `spool.tasks · list project:aurora`. The spec's prose still says
"workspace" throughout and is not being rewritten — this section is the
translation table.

## What already exists

| # | Story | Built | Where |
|---|---|---|---|
| 1 | Item store — lanes, packets, shapes | yes | `packages/core/src/workspace/{store,schema}.ts`, 2 249 LOC; `packages/core/test/workspace-store.test.ts`, 94 KB |
| 2 | Workspace MCP server | yes | `apps/web_old/lib/workspace-mcp.ts`, 614 LOC; test 64 KB |
| 3 | Queue surface | yes | `apps/web_old/components/workspace/queue-view.tsx`, 854 LOC |
| 4 | Packet detail | yes | `apps/web_old/components/workspace/packet-view.tsx`, 694 LOC |
| 5 | Loom and session handoff | yes | `apps/web_old/lib/workspace-handoff.ts` 397 LOC, `lib/session-briefing.ts`, `lib/detach-receipt.ts` |
| 6 | Master session profile | yes | `packages/core/src/session-profile.ts` — `SessionKind: "master"`, synthetic `__master__` key |
| 7 | Master chat and Desk rail | yes | `components/workspace/{master-chat,desk-rail}.tsx` 682 LOC, `lib/{master-chat,desk-rail}.ts` 738 LOC |
| 8 | Ephemeral per-project experts | yes | `packages/core/src/workspace/expert.ts` 498 LOC; `packages/core/test/workspace-expert.test.ts` 33 KB |
| 9 | Brain dump to receipt | **no** | `components/workspace/master-chat.tsx:23` names it unbuilt |
| 10 | Briefing, witness, gap detection | **no** | mockup only |
| 11 | Bed mode | **no** | mockup only |
| 12 | External MCP roster | **no** | not started |
| 13 | Codex MCP injection | yes, in the new stack | `apps/engine/src/codex-driver.ts` `codexMcpServers()` |

Plus the design source-of-truth mockups at
`apps/web_old/lib/demo-gallery/workspace/**` — 1 999 LOC across `fixtures.ts`,
`shared.tsx`, `home.tsx`, `queue.tsx`, `packet.tsx`, `session.tsx`. Their static
fixture state is mockup-only; `ui-contract.md` froze what is contractual.

Roughly 9 000 LOC of production code and 300 KB of tests exist. Stories 1–8 are
a **port**. Stories 9–12 are a **build** with no donor.

## The constraint that shapes everything: the store cannot be imported

`packages/core/src/workspace/` is 2 763 LOC that neither new app may touch.
`apps/web/lib/engine/source-boundary.test.ts:27` bans `@telar/core` from the web
by import-specifier scan, and `apps/engine/src/state.ts:1` opens with "this
module never imports legacy Telar storage, so starting the daemon cannot create
a `chats.json`, cutover marker, or any other legacy mutation by accident."

So the store is re-homed, not reused. Two things change with it, and both are
deliberate deviations from `item-model.md`:

**Deviation 1 — the store moves under the engine root.** `item-model.md` fixes
the layout at `TELAR_HOME/workspace/`. The engine owns `<TELAR_HOME>/engine` and
its header explains why it has a subtree at all: the packaged shell points
`TELAR_HOME` at Electron's userData directory, which already has other owners.
A store outside the engine root would be a second owner of engine state with no
migration story and no `statePaths()` entry. New layout:

```
<TELAR_HOME>/engine/spool/
  home/                    # master session cwd — dedicated, empty, holds no store files
  lanes.json               # lane definitions + ordered [item-id] stacks
  packets/
    <item-id>/
      packet.json          # every item — one-liner or rich, same shape
      <attachment files>   # siblings, only when the item grew some
```

**Deviation 2 — JSON, not YAML.** The engine serializes JSON through one atomic
writer (`state.ts:459`, `.tmp-<pid>-<uuid>` then `renameSync`), which is the same
idiom `item-model.md` demands and the same one core's `manifest.ts` uses. Adding
a YAML dependency to the engine to preserve a file extension would buy
hand-editability of a store the contract says nothing outside may reach into
anyway. Everything else in `item-model.md` — structure and content separate, one
shape for all items, atomic writes, nothing outside reaches in — holds exactly.

`rank` stays a read-time projection over `lanes.json`, per
`docs/workspace-item-schema-design.md`'s resolution of the contract's one
internal contradiction. That reasoning ports unchanged.

**Three smaller deviations the implementation forced**, recorded because each is
a place a reader comparing the two trees will notice a difference:

- **`atomicWrite` moved to `apps/engine/src/atomic.ts`.** The donor deliberately
  took a shared import rather than inlining a ninth copy of the idiom. The same
  reasoning applies here, but `state.ts` imports the spool store, so a spool
  module reaching back into `state.ts` for the writer would be a cycle. The
  function is unchanged; `state.ts` now imports it too.
- **An empty `lanes.json` needs one line of code.** `YAML.parse("")` returned
  `null`; `JSON.parse("")` throws. The reader treats a blank or whitespace-only
  file as the ordinary first-run state, and the suite asserts both spellings.
- **The attachment tally excludes `.tmp-`, not `.tmp`.** The engine's writer
  leaves `<file>.tmp-<pid>-<uuid>` behind if it dies mid-write, so the exclusion
  matches that shape rather than the donor's bare suffix. Reporting a failed
  write of the user's own as "1 file" is the failure both versions avoid.

`workspaceStorePaths()` is `storeEntries(paths)` here — same list, same reason,
and the suite pins that it names the two store entries while excluding both the
master's `home/` and the expert digests.

## Where each layer lands

**Store → `apps/engine/src/spool/{schema,store,expert}.ts`.** A behaviour-exact
port of `packages/core/src/workspace/`, re-rooted onto `statePaths()` and the
engine's atomic writer. The 94 KB store suite and 33 KB expert suite port with
it and are the acceptance gate — if a test needs rewriting for anything but the
root path and the serializer, the port drifted. The verbs carry over as-is:
`readLanes` / `writeLanes`, `listItems` / `getSpoolItem` / `createItem` /
`updateItem`, `createLane` / `renameLane` / `retireLane` / `reorderLane`,
`addSubtask` / `setSubtaskDone` / `promoteSubtask`, `trackLoom`,
`applyExpertPass` / `setItemVerdict`, and the projections `rankOf`,
`queueSlice`, `deskSlice`, `agentsAddedCount`, `minedCommitments`,
`attachmentTally`.

**Entities → `packages/engine-client/src/protocol/spool.ts`.** `SpoolItem`,
`SpoolLane`, `SpoolDeadline`, `SpoolPacket`, `SpoolDeskCard`, `SpoolQueueRow`.
Its own file rather than a section of `entities.ts`, for the reason
`workspace-item-schema-design.md` already argued in core: a subtree with one
owning module keeps its shapes beside that module so the two move together.

**Routes → `/v2/spool/*` on the daemon, thin adapters in
`apps/web/app/api/spool/`.** The donor's twelve route files under
`app/api/workspace/` total ~387 LOC and are already thin; they become daemon
handlers plus the `engineClient()` forwarding pattern `app/api/inbox/route.ts`
demonstrates.

**Tools → the engine's single in-process MCP server.** `driver.ts:374` builds
one `TELAR_MCP_SERVER` holding every Telar capability — its comment is explicit:
"ONE server for every Telar capability, not one per toolkit." Spool tools join
it there.

> **Deviation 3 — one server, not one per file.** This inverts the donor's
> invariant. `workspace-mcp.ts:44` required a dedicated file per server because
> `invariants.test.ts` computed tool-name literals per file and applied them to
> every server declared in it. That test does not exist in the new stack and the
> engine's structure is the opposite. The donor's *absences* — no accept path,
> no delete tool, no agent promotion path, no lane-structure change, no
> cross-project reach, no path-shaped input key — are the part that must survive,
> and they now need their own assertions rather than inheriting a file-scoped
> one.

**Surfaces → `apps/web/components/spool/`.** Copied from web_old with fetches
swapped for engine-client calls and shadcn imports repointed at the local
`components/ui/` copies. The chip grammar (`chips.tsx`, 204 LOC) ports first —
`ui-contract.md`'s cross-surface invariant 1 is that deadline, verdict, project
and provenance render identically everywhere, and that only holds if there is
one component.

## The five hard problems

These are the parts with no donor answer, in rough order of how much design they
need.

### 1. `Session.projectId` is required

`protocol/entities.ts:127` declares `projectId: Id` — not optional. The donor's
blocker was a project gate inside a chat route (`brownfield.md`'s "one hard
coupling"); ours is in the schema, which is harder. Every read path, the sidebar,
the inbox banding and the worker's session lookup assume it.

Worse, the donor's answer does not exist here. `SessionKind: "master"` lives in
`packages/core/src/session-profile.ts`, and `apps/engine/src` has **no profile
resolver at all**. Story 6 is therefore not a port — it is a design, and it has
to decide both how a session declares itself project-less and where session shape
(cwd, setting sources, guardrails, tool mount) is resolved now that there is no
`SessionProfile`.

The spec's constraint is unusually firm about the mechanism and worth re-reading
before choosing: a new session kind adds a profile, it does not add an `if`,
because the guardrail enforcing the accept moat rides that path and every extra
branch is another one that must remember to wire it.

### 2. Codex cannot reach in-process tools

`drivers.ts` states it: "The Codex app-server runs its own tooling and has no
seam for an engine-owned browser yet." Codex receives *external* MCP servers as
url/command config (`codexMcpServers()`), not SDK-side in-process servers. The
engine's own browser tools do not reach Codex today for exactly this reason.

CAP-12 — "any session anywhere in Telar can read its project's slice" — is
therefore **Claude-only** unless the engine exposes spool tools over a transport
Codex can be pointed at, which means a real MCP endpoint on the daemon and a
`-c mcp_servers.spool.url=…` injection. That is net-new work the donor never had
to do, and it is the single largest hidden cost in this port. It is also
reusable: solving it once gives Codex the browser too.

Until it exists, CAP-12 ships degraded and the degradation must be visible, not
silent.

### 3. The store has no protection mechanism yet

`store.ts:96` is emphatic that the directory layout is *not* the boundary — an
earlier version of that comment claimed it was, and a review measured otherwise:
siblings are reachable by `../lanes.yaml` and one "always allow" click. The real
boundary is `workspaceStorePaths()` naming the two entries, the master profile
putting them in `addProtectedPaths`, and `makeGuardrailDecision` denying before
any permission mode votes.

None of those three exist in the engine. Its model is `runtimeMode` +
requests/approvals. The port needs an equivalent that denies file-tool writes to
`spool/lanes.json` and `spool/packets/` for every session including the master's,
whose cwd sits one directory below them. Without it the module's whole
prepare-never-commit posture is advisory.

### 4. Master chat needs a second consumer of the transcript

The donor built master chat as an owner adapter on a shared `Conversation` shell
— `lib/master-chat.ts` (555 LOC) is that adapter with React removed, a pure
reducer over SSE frames, which is why it is `bun test`-able. In the new web the
transcript and composer live inside `session-cockpit.tsx`, and that carve-out has
not happened.

Two options, and the donor is unambiguous about which: story 7's dispatch note
says to STOP rather than hand-rebuild another chat window. So extract the seam
first. The good news is `lib/master-chat.ts` ports nearly unchanged once there is
a shell to adapt — the reducer's reductions (no sub-agent frames, no ultra
anchors, no rollback/queueing/compaction) are all still correct.

### 5. Bed mode needs a trigger, and the module forbids clocks

CAP-10 runs overnight; the constraints say "no clocks and no scheduling". These
do not actually conflict — the no-clock law binds *queue ordering* (order is
stack position, deadlines are chips) and forbids anything clock-*driven* reaching
the user. Bed mode is a batch run, not a notification.

There is precedent to ride rather than a new concept to invent: `daemon.ts:314`
already runs a `setInterval` pruner, and `state.ts` already carries snooze/wake
stamps with an early-wake rule. Bed mode is a due-check on that loop. What must
be asserted, not merely written, is its output contract: zero started, zero
completed, every artifact marked a proposal, no queue item created, mirror sync
read-only.

## Staging

Each stage is judgeable on its own and nothing later invalidates it.

**A · Store on the engine. — DONE.** `apps/engine/src/spool/store.ts` (the port)
and `packages/engine-client/src/protocol/spool.ts` (the shapes), with
`apps/engine/test/spool-store.test.ts` — 112 tests, all of the donor's
behaviours. Nothing user-visible. Everything downstream inherits these shapes,
which is why the donor made this a done-checkpoint.

**B · Protocol and routes. — DONE.** `EngineStore`'s spool block, `/v2/spool/*`
on the daemon, the typed client methods, and ten thin adapters under
`apps/web/app/api/spool/`. `apps/engine/test/spool-routes.test.ts` drives the
whole seam over HTTP — 9 tests. Its own reason for existing beside the store
suite: the seam is where the store's two-vocabulary contract ("a read is
tolerant, a write is loud") has to become status codes without losing the
sentences, and a refusal arriving as a bare 400 is a regression only this file
can catch.

> **Deviation 4 — a lane-retire refusal is a 200, not a 4xx.** Every refusal the
> store produces is a sentence naming what the human must move first. It is the
> ANSWER to "can I retire this?", not a malformed request, and a 4xx invites a
> client to render it as an error toast and drop the sentence. The client's
> `retireSpoolLane` returns `{ok: false, reason}` rather than throwing.

**C · Queue surface. — DONE.** `components/spool/{chips,queue-view,tabs}.tsx`,
the shared chrome under `components/common/`, `/spool`, and a sidebar entry.
`components/spool/idiom.test.ts` guards the frozen grammar as source text — that
there is ONE chip module, that a self-deadline is dashed and carries its slip
count, that the footer's numbers are interpolated rather than typed, that no
clock and no delete affordance exist on the surface.

> **Deviation 5 — the Chat tab and the tracking mark are inert.** Neither the
> master chat nor a loom surface exists yet. The donor's own rule for exactly
> this case: "a real href would be a promise this story does not keep." The
> idiom test pins both, so whoever lands those surfaces is told to update them.

**Two defects the gate could not have caught, found by driving it.** Both are
recorded because they are the argument for driving it at all:
>
> 1. **The group header shouted a paragraph.** The port passed
>    `label · window · note` as one string into a slot that UPPERCASES and
>    truncates, so the seed lane's note filled the header and cut off mid-word.
>    `ui-contract.md` §3 always said these were three things — label, note, and
>    the window right-aligned — and `GroupHeader` now has a `meta` slot for the
>    two that are not the group's name.
> 2. **The seed lane's note was half instruction.** "created by the store on
>    first use — rename, split or retire it like any other lane" is provenance
>    plus a suggestion, and the tone law admits only the first. Shortened to
>    "created on first use". A deliberate divergence from the donor.

**D · Packet detail. — DONE.** `components/spool/packet-view.tsx`, `/spool/[id]`,
and `lib/spool-briefing.ts`. Born-as (the raw fragment verbatim above the brief
that replaced it), the attachment tally, sub-tasks with the human's promote, the
ripening timeline with actor icons and the `· proposal` marker, the durable
verdict override, and "Its turn came".

> **Deviation 6 — the handoff is half-built, and says so.** "Plan loom from this
> packet" renders as the filled primary CAP-11 asks for, disabled, because there
> is no loom to plan into and no weave endpoint behind it. Removing it would have
> been worse: the two paths are EQUAL WEIGHT, and a surface showing only the
> session path quietly teaches that a loom is not an option. The detach receipt
> and the batch weave land with looms.
>
> **Deviation 7 — "Start a session instead" resolves a project first.** A
> packet's `project` is a free-form label; a session needs a registered project
> id. The button matches on name, then id, and states which of the two reasons
> it is unavailable — floating, or named a project this machine has not
> registered.

**E · Spool tools on the Claude driver. — BLOCKED, deliberately.** Delivers
CAP-12 for Claude sessions and the in-session surface of `ui-contract.md` §5.
Explicitly leaves Codex degraded and says so on screen.

> **Held for the reason this document already gave.** Warp is being built in
> `apps/engine/src/driver.ts`, `warp/runner.ts`, `warp/surface.ts` and
> `worker.ts` concurrently, and stage E lands in `driver.ts`'s MCP assembly — the
> one file both touch. "Stage E should wait for Warp to settle in `driver.ts`"
> was written before either started; it held. Stages A–D deliberately avoided
> that file and shipped alongside.

**F · Master session. — DONE (the engine half).** `Session.projectId` is now
optional, `EngineStore.ensureMasterSession()` mints the singleton, and
`GET /v2/spool/master` serves it. Two tests.

> **The decision, and why it went this way.** The blocker was that `projectId`
> was required in the protocol. Three options: make it optional, mint a
> synthetic project for the Spool, or add a session-kind discriminator. A
> synthetic project was rejected because "no project" would then be a lie at the
> data layer — the master answers ACROSS projects and its experts are each
> scoped to their own, so a master carrying a project is scoped to the one thing
> it must not be. Optional won because the blast radius turned out to be six
> read sites, two of which were unreachable anyway: they sit inside
> `workspace.mode === "worktree"`, and a project-less session is always `local`
> because a worktree is cut from a repository it does not have.
>
> **A SINGLETON, not a create verb.** CAP-1 says "ONE project-less conversation —
> the module's front door", so the route is an ensure: it returns the existing
> master or mints it, and is safe on every page load. A "new master chat" button
> would turn the front door into a list of front doors.
>
> **Found by driving it:** `parseSession` asserted `projectId` unconditionally,
> so the master minted successfully and then 400'd on every subsequent read —
> exactly the failure `Session.projectId`'s own comment warns about, reached at
> the first reader every other reader goes through.
>
> **Still owed from this stage:** the store-protection mechanism (problem 3).
> `storeEntries()` names what it must cover and nothing consumes it yet, so
> prepare-never-commit is advisory against a file tool. The master's cwd being a
> sibling of the store defeats a relative-path accident and nothing more.

**G · Master chat and Desk rail. — NOT STARTED, and it is a build.**
`session-cockpit.tsx` cannot be reused as-is: `projectId` is required through it
and it is deeply project-coupled — the canvas href, the draft key, session
creation, the breadcrumb, the git environment strip, and the whole right panel
(files, diff, GitHub) all assume a repository the master does not have. Making it
project-optional would put a branch through a 1 200-line component for a surface
that wants almost none of what those branches guard.

The honest shapes are (a) extract the transcript and composer into a shell both
consume — what the donor's `Conversation` extraction was for — or (b) build a
leaner master surface on the same primitives. Either is a real piece of work and
neither should be started by half-widening the cockpit.

**H · The unbuilt four.** Briefing (10) first, because it is the module's front
door and its stated success signal; then brain dump to receipt (9), bed mode
(11), external roster (12).

**I · Codex tool transport.** Problem 2. Closes CAP-12 properly and hands the
browser to Codex as a side effect. Can move earlier if Codex-backed sessions
matter sooner.

### Sequencing against Warp

The overlap is narrow but real: both land in `driver.ts`'s MCP assembly and
`daemon.ts`'s routing, and both add protocol files. Stages A–D touch neither hot
spot and can run concurrently with Warp. Stage E should wait for Warp to settle
in `driver.ts`.

## The loom removal

Looms are a planned feature that does not work in this app: the whole
implementation is legacy-only, and nothing in the engine can weave, land or
accept one. Every loom reference was therefore taken out of the Spool rather
than left disabled. **Issue #93** maps the feature and lists the exact
re-attachment points.

**Removed, and why each is not merely hidden:**

| Gone | Why |
| --- | --- |
| `SpoolLoomRef`, `SpoolItem.tracking`, `trackLoom` | A weave stamp with no writer is dead weight, and its whole contract is about a lifecycle — lands, then a human accepts — that nothing here can observe. |
| `SpoolVerdict`, `verdictOverride`, `setItemVerdict`, `POST …/verdict` | The verdict IS the question "session or loom?". Half its answer names a thing the app cannot do, so it was a question the user could not answer correctly, rendered as though they could. |
| `VerdictChip`, `TrackingChip` | Both name a loom. Cross-surface invariant 1 still holds — they now render on no surface rather than on some. |
| "Plan loom from this packet" | Removed, not disabled. A filled primary that never responds is a worse lie than an absence. |

**What this costs, stated plainly.** The durable-override rule — "a human
override is durable and a later expert pass does not re-flip it" — was the most
carefully reasoned thing in the port, and it went with the verdict. Its two
halves are recorded in place: the guard in `updateItem` and the gate in
`applyExpertPass` both carry a comment saying what stood there and why
restoring the verdict means restoring them too.

**Restoring is additive.** Both fields were optional on a `z.looseObject`
schema, so a packet written by a future build that carries them still parses
today and no packet needs a migration to gain them.

The idiom suite pins the absence with a word-boundary scan over every Spool
surface, comments stripped — the comments that explain a removal have to name
it, and a scan that read prose would teach the next person to delete the
explanation.

## What must not drift

The module's laws are the reason it is calm rather than another tracker, and
most of them are enforceable rather than reviewable. Each of these needs an
assertion in the new stack, not a comment:

- **No accept path, no delete tool, no agent promotion path.** The donor asserted
  all three as source-text invariants. They need new homes (Deviation 3).
- **Conservation of the queue.** Sub-tasks live inside items; breaking an item
  down leaves the queue count unchanged. The queue footer's `agents added 0` is a
  live number, not copy.
- **Bed mode reports 0 started.** A real invariant to assert against.
- **The receipt's count equals the input's count.** Assertable, not display copy.
- **Lanes are data.** No enum, anywhere, at any layer.
- **Dismiss drains, never deletes.** Stated in the UI wherever the action exists.
- **One chip grammar.** Deadline, verdict, project, provenance render identically
  on the queue, in a packet, and inside a session. One component or the invariant
  is a wish.
