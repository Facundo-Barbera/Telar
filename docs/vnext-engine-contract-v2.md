# vNext engine — contract v2

**Status:** proposed model, not implemented. Written 2026-08-11.
**Supersedes:** `packages/engine-client/src/contract.ts` (protocol version 1).

## 1. What this is for

The engine must run **detached agent sessions on its own** — full Claude and
Codex turns, sub-agents, tool timelines, approvals, and a real browser — with no
UI client connected. Clients (web, desktop, later mobile) become *viewers and
remote controls* over a daemon that would keep working if every one of them
closed.

Today it cannot. Protocol v1 is a durable text queue: eleven flat `turn.*`
events, `permissionMode: "default"`, and a driver that reads only text deltas.
`tool_use`, `tool_result` and `thinking` are dropped on the floor. There is
nothing to render and nothing to approve.

### In scope

Sessions, turns, tool timelines, thinking, approvals, sub-agents, usage/cost,
attachments, model selection, Codex, MCP, worktrees, the browser, and the
capability-aggregation mode currently called Ultras.

### Out of scope, deliberately

**Looms, weaves, the verifier, and the acceptance gate.** They need a rework of
their own and are not modelled here. `packages/core`'s loom/weave/verifier code
stays frozen and unmounted. The contract below must not grow a `loom` entity as
a side effect — when looms return they arrive as a layer *over* this stream, not
a parallel one beside it.

**Workspace queue/lanes/packets.** Deferred to its own pass, on top of v2.

**Visual design.** The Codex app is the visual reference; that is a separate
track from this contract.

## 2. References, and where we diverge

Studied: **t3 code** (`~/Projects/_refs/t3code`, pulled to `d37a9b09`,
2026-08-12 nightly). It is the closest existing thing to what Telar vNext wants
— an "agent harness control surface": one local server owning agent processes,
with web, desktop and mobile clients over RPC. Its `packages/contracts` is a
mature, hard-won version of the contract we are about to write, and the parts
worth copying are copied.

**Conductor** contributes one idea we take wholesale: a session runs in **its
own git worktree** so several can run in parallel without fighting over a
checkout. t3 code encodes the same idea as `ThreadEnvMode = "local" | "worktree"`.
There is no Conductor source in `~/Projects` — this is modelled from the
published behaviour, not from reading its code.

### Three places we deliberately diverge from t3 code

**1. The browser runs in the engine, not in a client.**
This is the most important divergence and it is forced by the goal. In t3 code,
browser automation is brokered to a connected desktop host
(`PreviewAutomationBroker`, `PreviewAutomationHost { clientId, environmentId }`);
with no host connected, tool calls fail with `PreviewAutomationNoAvailableHostError`.
A t3 code session cannot browse while detached.

Telar already has what closes that gap:
`apps/web_old/lib/server/browser-runtime.ts` drives a real headless Chromium and
already reports `provider: "desktop" | "playwright"`. We move it into the engine
and invert the default — see §6.

**2. `session` and `thread` are not split.**
t3 code has `Thread` (the conversation) *and* `ProviderSession` (the process).
The overload is a persistent source of confusion in its own code. Telar keeps
**Session** as the one durable, user-facing conversation and calls the process
attached to it a **Runtime**. One session, zero-or-one live runtime.

**3. Aggregation is a projection, not an entity.**
The single best structural idea in t3 code: it has no separate "fleet" or
"workflow" object. Multi-agent fan-out rides the *same* runtime event stream as
`task.*` events carrying `agentId`, `parentAgentId`, `workflowName`,
`phaseIndex`, `agentIndex`, `agentPath`. Every surface — sidebar liveness pill,
agent roster, workflow progress — is a fold over that one stream.

Telar's Ultras are the opposite: a parallel universe with their own storage,
journal, events, wake loop and surface (`packages/core/src/ultra/*`, ten
modules). That is why the old UI needed a whole second rail to display them. v2
folds aggregation back onto the main stream. See §7.

## 3. Entities

```
Environment          the host the engine runs on (one, for now; remote later)
  └── Project        a registered repo
        └── Session  a durable conversation. Survives restarts and disconnects.
              ├── Runtime   the live provider process, if any (0..1)
              └── Turn      one user input and everything it caused
                    ├── Item     a timeline row (message, tool call, reasoning…)
                    ├── Request  something needing a human answer (0..n)
                    └── Task     a sub-agent or background job (0..n)
```

**Session** carries: project, title, provider instance, model selection,
`envMode: "local" | "worktree"`, worktree path when applicable, runtime mode,
lifecycle state, and cumulative usage.

**Runtime** is not persisted state the user owns; it is the engine's handle on a
process. A session with no runtime is *cold* — reopening it starts a runtime and
resumes provider continuity from the stored cursor.

**Turn** is the unit of work and stays the durable, claimable, replay-safe unit
v1 already gets right. v1's `runId` idempotency, claim tokens, and the
`ambiguous`/`discarded` states are **kept** — they are the best part of the
current engine and they are what makes a detached turn safe to recover after a
crash.

## 4. The event stream

One append-only, monotonically-numbered journal per session. Every client state
is a fold over it; there is no second source of truth. Cursor-based replay
(`?since=<id>`) already works in v1 and carries over.

### Event families

| Family | Events | Purpose |
| --- | --- | --- |
| `session.*` | `created`, `updated`, `state.changed` | lifecycle, title, settings |
| `runtime.*` | `started`, `configured`, `state.changed`, `exited` | the process |
| `turn.*` | `accepted`, `claimed`, `started`, `completed`, `aborted`, `ambiguous`, `discarded`, `plan.updated`, `diff.updated` | the unit of work |
| `item.*` | `started`, `updated`, `completed` | timeline rows |
| `content.delta` | — | streaming text into an item |
| `request.*` | `opened`, `resolved` | approvals and user input |
| `task.*` | `started`, `progress`, `updated`, `completed` | sub-agents and background work |
| `usage.updated` | — | tokens and cost |
| `browser.*` | `state.changed`, `action` | the engine's browser |
| `mcp.*`, `account.*`, `runtime.warning`, `runtime.error` | — | diagnostics |

Every event carries `{ id, at, sessionId, turnId?, itemId?, requestId?, taskId?, providerRefs?, raw? }`.

**`raw` is optional and load-bearing.** t3 code keeps the untranslated provider
payload on every normalized event. It is how you debug a normalization bug
without re-running the session, and how a client can render something the
contract does not model yet. Keep it, keep it optional, and never let a client
*depend* on it.

### Item types

Adopting t3 code's canonical set, minus the parts we do not have:

```
user_message · assistant_message · reasoning · plan
command_execution · file_change · mcp_tool_call · dynamic_tool_call
web_search · image_view · browser_action
context_compaction · error · unknown
```

`item.status` is `inProgress | completed | failed | declined`. The tool-lifecycle
subset is what the UI renders as expandable tool cards — this is precisely the
data protocol v1 throws away.

### Requests — the detached-mode crux

`request.opened` carries a kind
(`command_execution_approval`, `file_change_approval`, `file_read_approval`,
`tool_user_input`, …) and stays open until `request.resolved`.

A **detached session with an open request is blocked**, and that is the one
failure mode that makes autonomous runs useless in practice. Resolution is
governed by the session's runtime mode:

| Runtime mode | Behaviour when a request opens with no human present |
| --- | --- |
| `approval-required` | session goes `waiting`, notification fires, work parks |
| `auto-accept-edits` | file edits auto-resolve; commands park |
| `auto` | everything inside the session's boundary auto-resolves; escapes park |
| `full-access` | nothing opens a request in the first place |

The mode is per session, set at creation, changeable mid-session. Default for a
**detached** session is `auto`; default for an **attended** session is
`approval-required`. A parked request must produce a real notification —
otherwise "detached" means "silently stuck".

## 5. Detached execution

Detached is **the default, not a mode**. The engine already has the right bones
(`daemon.ts`, `worker-supervisor.ts`, `worker.ts`, claim tokens, requeue); what
is missing is that the worker currently runs one turn and exits.

What changes:

- **The runtime outlives the turn.** A provider process is kept warm per active
  session, supervised, with a crash/restart policy that reuses the existing
  claim/requeue machinery.
- **Client presence is an input, never a requirement.** Copy t3 code's
  `ClientActivityLease` idea — clients *report* visibility/focus so the engine can
  cheapen polling — but no code path may require a lease to exist.
- **Wake and notify.** Telar's `packages/core/src/ultra/wake.ts` already solved
  scheduled wake-ups for Ultras. Generalize it to sessions so a detached session
  can sleep, poll CI, and resume.
- **Worktree isolation.** `envMode: "worktree"` creates the session's own
  worktree via the existing `packages/core/src/vcs.ts`, so N detached sessions on
  one project do not collide. This is the Conductor idea, and it is a
  precondition for running several detached sessions at once.

## 6. The browser

Two providers behind one tool surface, chosen per session:

- **`headless`** — engine-owned Playwright/Chromium. Works with nothing
  attached. **This is the default**, and it is what makes "detached with full
  browser capabilities" true rather than aspirational.
- **`attached`** — a connected desktop/web client's webview, for when a human
  wants to watch the agent work or drive alongside it. Brokered the way t3 code
  brokers it.

A session on `headless` **upgrades to `attached` when a host connects** and
falls back when it leaves. The agent's tool surface is identical either way; the
provider swap is invisible to the model. `apps/web_old/lib/browser-mcp.ts`'s
fourteen tools are the surface to port, and
`apps/web_old/lib/server/browser-runtime.ts` is the implementation to move.

Browser activity is journalled as `browser_action` items on the normal stream,
so a detached run's browsing is reviewable after the fact — a screenshot trail,
not a black box.

### 6.1 Telar's own tools are MCP tools, and they have a naming standard

The browser is not special-cased into the provider — it is an in-process MCP
server. So are the toolkits that come after it. The rule, taken from t3 code
(`mcp__t3-code__preview_navigate`, toolkits under `mcp/toolkits/<capability>/`
behind a `requireMcpCapability` gate) and defined once in
`packages/engine-client/src/protocol/tools.ts`:

> **`mcp__telar__<capability>_<verb>`** — one server named `telar`, and the
> capability is legible in the tool name.

- **One server, many capabilities.** Not one server per toolkit. Ten toolkits
  registered as ten servers would show a client ten groups that are all Telar.
- **`TELAR_CAPABILITIES` is the registry.** Adding a capability there is the
  whole registration: the prefix check, the item mapping and the approval
  routing all read that list. `assertTelarToolNames` is run over every toolkit
  by a test, so a tool added without its prefix fails the build.
- **The stored name is always fully qualified**, because it is what correlates a
  timeline row with its approval and with the provider's own `tool_use`.
  `displayToolName()` strips the addressing for labels — defined in the contract
  so three clients cannot invent three ways to shorten it.
- **Providers are normalized to one spelling.** Claude reports
  `mcp__linear__search`; the Codex app-server reports `{ server, tool }`.
  `canonicalToolName()` makes both store the same string. Without it one MCP
  tool has two names depending on which provider called it, and a client
  grouping by tool sees two.

**What this fixed, not just tidied.** The browser was registered as a server
called `browser` holding tools called `browser_*`, producing
`mcp__browser__browser_navigate`. The stutter was the symptom; the defect was
that it matched the generic `mcp__` arm of the item mapping, so **`browser_action`
— in this contract since v2 was written, with an icon in the cockpit — was
produced by nothing.** Every browser call rendered as an anonymous MCP row.
Routing on capability rather than on server identity is what makes the row type
reachable and keeps it reachable for the next toolkit.

## 7. Warp — the aggregation mode formerly called Ultras

**Decided: Ultras becomes Warp.** In weaving, the warp is the set of parallel
threads held under tension on the loom, through which the weft passes. It is
semantically exact for a parallel fan-out, it is native to Telar's vocabulary,
and it does not collide with `loom`, `weave` or `thread`, which are all taken.
"Ultra" had drifted into model-tier and thinking-budget vocabulary and read as
an intensity setting rather than a structure.

Vocabulary: **a warp** (one orchestrated run), **a warp script** (the authored
file), **a warp agent** (one child in the fan-out), **warp phase**.

The mode is Telar's deterministic multi-agent orchestrator: a script that fans
out agents across phases under a budget. It is the one aggregation feature that
exists today and it is worth keeping.

**The structural change: it stops being a parallel universe.** Ultras today own
their storage, journal, event bus, wake loop, sandbox and surface —
`packages/core/src/ultra/{storage,journal,events,wake,runner,executor,sandbox,signals,surface,child-guard}.ts`.
Every one of those needs a bespoke UI rail because none of it is on the session
stream. In v2 a warp emits ordinary `task.*` events carrying `warpName`,
`phaseIndex`, `phaseTitle`, `agentIndex`, `parentAgentId` — exactly t3 code's
`taskAgentLinkage`. Sub-agents, warp agents and background shells then render
through **one** timeline component instead of three.

The script-authoring surface (`surface.ts`, `sandbox.ts`, the `agent()` /
`parallel()` / `pipeline()` / `phase()` API) is genuinely good and stays as-is.
What changes is where its *observations* go.

### Rename scope — revised, and narrower than planned

The original plan was a mechanical sweep: `packages/core/src/ultra/` →
`packages/core/src/warp/`, the `ultra:` event namespace → `warp:`,
`UltraAgentOpts` → `WarpAgentOpts`. **That sweep was rejected on inspection.**

The name is what needed to change, and in the vocabulary that survives it
already has: `WarpLinkage`, `WarpPhase`, `warpRunId`, `warpName`, `phaseIndex`
are the contract's words, and every vNext surface reads them. What the sweep
would additionally have done is rename 3,400 occurrences across a legacy
implementation whose only consumers are its own tests and `apps/web_old` — and
`web_old` is FROZEN, so it cannot be edited to follow. The rename would break
the frozen reference app in order to tidy the vocabulary of an architecture
vNext replaces rather than carries forward.

So `packages/core/src/ultra/` keeps its name and its header now says why, in
place. The two hard parts of the sweep are recorded here rather than done:

- **`ultra:run-anchor`**, the kind id retired INV-10 used to pin, becomes
  `warp:run` **when the vNext warp surface is built**, not before — there is
  nothing to re-pin it against yet.
- **Persisted runs** under `TELAR_HOME/ultra`: abandoned deliberately. vNext
  writes only beneath `TELAR_HOME/vnext` and never reads legacy run history.

**What a vNext Warp still has to do**, and has not: run a warp script inside the
engine so its `agent()` calls become sub-agent turns whose observations land on
the session stream as `task.*`. The authoring surface is the part worth porting;
the ten modules of parallel infrastructure around it are the part that exists
precisely because there was no session stream to put anything on.

## 8. Staging

Each stage is independently shippable and leaves the tree green.

| # | Stage | Status | Unblocks |
| --- | --- | --- | --- |
| 1 | **Rich turn journal.** Items, content deltas, reasoning, usage. Driver stops discarding blocks. | **DONE** | A real session view. Everything else. |
| 2 | **Requests + runtime modes.** Approvals end-to-end, parked-request notifications. | **DONE** | Trustworthy detached runs. |
| 3 | **Persistent runtimes.** Warm processes, supervision, resume. | **DONE** | Detached, properly. |
| 4 | **Providers.** Codex via app-server, driver selection per session. | **DONE** | Parity with the frozen app. |
| 5 | **Tasks.** Sub-agents on the stream, then Warp on top of them. | **sub-agents DONE**, Warp not started | Fan-out surfaces. |
| 6 | **Browser.** Headless provider first, attached second. | **headless DONE**, attached not started | Autonomous verification. |
| 7 | **Worktrees.** `envMode`, parallel sessions. | **DONE** | Many detached sessions at once. |

**"Contract only" means the shapes exist and are tested, and nothing emits
them.** Nothing is in that state any more, but the distinction is worth keeping
written down: a reader must never infer from a modelled shape that the behaviour
behind it works.

### What is still not built, precisely

- **Warp.** The linkage (`WarpLinkage`, `WarpPhase`) is modelled and Claude's
  own `workflow_name` populates it, so an SDK workflow already surfaces as
  warp-linked tasks. Telar's own script harness — `agent()`, `parallel()`,
  `pipeline()`, `phase()` — has NOT been ported onto the session stream. The
  legacy implementation stays at `packages/core/src/ultra/` under its old name;
  see that module's header for why renaming it was rejected rather than
  forgotten.
- **The `attached` browser provider.** `headless` is the default and works
  detached, which was the point. `attached` needs a client offering a webview
  and no client offers one, so nothing reports it; adding the arm without an
  implementation would be a lie in the enum. The headless one is now VISIBLE:
  `GET /v2/sessions/:id/browser` answers a `BrowserSnapshot` with an optional
  screenshot, polled by the cockpit's browser tab. It is a READ, never an event
  — a screenshot per navigation would dominate the journal within an hour and
  the only one anybody wants is the current one. Answered from the DAEMON's own
  runtime, so a deployment running its worker out of process reports
  `provider: "none"` there even while that worker drives a page; the journalled
  `browser.state.changed` still shows the tabs, because the party that drove
  them reported them.
- **Per-turn model and effort.** DONE. `TurnSubmission.model` is a
  `TurnModelSelection` — model and effort, and deliberately NO `instanceId`, so
  a turn cannot change the provider that owns the session's resume cursor. The
  engine stamps the instance from the session and `claimNextTurn` prefers
  `turn.model` over `session.model`, which is what makes three messages queued
  under three models each run on the one they were written under.
- **Attachments.** DONE. Bytes upload on their own route
  (`POST /v2/sessions/:id/attachments`, raw body, 20 MB) and the submission
  carries ids; the engine mints the filename so no user-supplied byte reaches
  the filesystem. Images reach Claude as base64 content blocks and Codex as its
  `localImage` input element; anything else is named by PATH, because both
  agents have a Read tool and a file they can reopen beats a copy they cannot.
- **The git surface.** DONE, and deliberately narrower than the frozen app's.
  `GET /v2/sessions/:id/diff` answers `base…worktree` — committed and
  uncommitted together, run in the SESSION's own checkout — because `git status`
  forgets a change the moment the agent commits it and a branch comparison
  forgets everything uncommitted. A local session now records `baseRef` at
  creation so that question is answerable for it too. The cockpit joins the
  result against the journal, so files that differ on disk and never appeared in
  the transcript are named. `POST /v2/sessions/:id/git/commit` is the ONE git
  mutation: additive, reversible, human-pressed. Staging, branch switching and
  discarding are refused by design — the frozen pane's branch list ran
  `git checkout` in the tree a running agent was writing to.
- **User-configured MCP servers.** DONE for Claude. Environment-scoped in
  `mcp-servers.json`, filtered to the enabled ones on the `WorkerClaim`, and
  merged UNDER Telar's own servers so a user server called `telar` cannot shadow
  the engine's capabilities. NOT applied to Codex: the app-server owns its own
  registry through `~/.codex/config.toml`, and the shape its `thread/start`
  `config` overlay accepts for servers is not verifiable from here — guessing it
  would fail the whole turn on an unknown key. The cockpit's MCP settings say
  so rather than implying otherwise.

### What stage 1 actually landed

Protocol v2 is live end to end. `apps/engine/src/driver.ts` now maps `tool_use`
to canonical items by capability, closes each one on its `tool_result` (keyed by
`tool_use_id`), streams text and thinking as `content.delta`, and reports usage
and cost. The worker relays observations rather than raw text; the engine stamps
and journals them and maintains an `items.json` projection beside the queue.
`apps/vnext-web` renders a real timeline — collapsed tool cards with output,
collapsible reasoning, per-turn token and cost.

v1 is deleted, not deprecated: `packages/engine-client/src/contract.ts` is gone,
routes moved `/v1/**` → `/v2/**`, and a v1 state document fails with a message
naming the version break rather than reading as disk corruption.

**Not yet verified against a real provider.** Every driver test drives a
synthetic SDK fixture. The item mapping is modelled from t3 code's canonical set
plus the SDK's documented message shapes, and the first thing stage 2 should do
is capture actual Claude output and assert the normalizer against it — that is
where a contract drifts from reality.

Stage 1 is the one that matters. Everything the previous agent could not build
was downstream of it, and it is **contract-first** (§9.3): the v2 type surface
lands in `packages/engine-client` with tests before the driver changes.

### Verification note

`apps/web_old` was retired from verification, which took INV-1's MCP-surface
half, INV-4, INV-8, INV-10, INV-11c/e/g and others with it. Each retirement in
`packages/core/test/invariants.test.ts` names what must come back and when.
Stage 2 should restore the tool-layer moat (retired INV-1g) **before** approvals
ship, not after — restoring it later means auditing a surface that already
shipped.

## 9. Decisions and remaining questions

### Decided

1. **Ultras → Warp.** §7.
2. **Provider driver/instance split, adopted now.** A `ProviderDriverKind`
   (`claude` | `codex`) is *what* runs; a `ProviderInstanceId` is *which
   configured one* — account, credentials, cwd binding. **Routing is on instance
   id.** t3 code's own contract carries visible scar tissue from doing this the
   other way round first (`provider` is still marked "optional during the
   driver/instance migration… once every producer populates it, routing flips to
   instance-id-only"), and a mid-flight migration would touch every event and
   every persisted model selection. Telar's existing accounts registry
   (`packages/core/src/accounts.ts`, `account-identity.ts`) is the natural
   source of instances.
3. **Stage 1 is contract-first.** Write the full v2 type surface in
   `packages/engine-client` with tests, then rewrite the driver to emit it. The
   contract is reviewable before behaviour changes, and `apps/vnext-web` can
   bind against real types while the driver lands.
4. **zod in `engine-client`, types derived with `z.infer`.** Not `effect/Schema`
   — t3 code uses it because its *entire server* is Effect-based (`Effect`,
   `Layer`, `Context.Service`, `Stream`), so that choice follows its
   architecture rather than standing alone. Not plain TS types either: the
   shapes cross three trust boundaries (provider SDK → engine, engine → client,
   disk → engine) and types are erased before any of them. v1's cost was already
   visible — `isDiscovery()` was fifteen hand-rolled lines ending in a
   `value is EngineDiscovery` assertion tsc takes on trust, and
   `apps/vnext-web/lib/vnext/journal.ts` hand-checked `typeof event.data.text
   === "string"` because every payload was `Record<string, unknown>`. One
   definition per shape; the type falls out of it.
5. **`environmentId` carried from day one**, pinned to `"local"`. One legal
   value costs nothing now and is the cheapest this will ever be.

### Still open

6. **Warp run-history migration.** See §7 — decided to abandon `TELAR_HOME/ultra`;
   the read-side of that decision still needs writing when `storage.ts` moves.
