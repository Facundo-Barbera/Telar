# Telar Ultra — a deterministic script harness inside the engine

> Doctrine-bound (`docs/PRINCIPLES.md`). Design plan, not as-built. Depends on
> the approved codex-engine-driver plan (`docs/plans/codex-engine-driver.md`)
> for its Codex backend; ships Claude-first without it. Looms are untouched.

## Executive summary (for the owner)

1. **Ultra brings the tool you already develop Telar with — the fan-out
   orchestration harness — INSIDE Telar**, as an `ultra` MCP tool the chat's
   main agent authors a script for and the engine executes deterministically.
2. It is **lighter than looms on purpose**: no charter, no gates ceremony, no
   verify/mediate rungs, no `ready→done`. One user-requested orchestrated turn
   that returns a value to the main agent. Looms stay exactly as they are.
3. **It reuses, it does not rebuild.** Every subagent is one existing
   `agent()` call; fan-out is existing `parallel()`. Ultra adds a script
   sandbox, a journal, and a progress surface — no new spawn primitive.
4. **One engine, both providers.** Because Ultra only ever calls `agent()`, it
   inherits Claude today and Codex the moment the codex-driver seam lands —
   the same free ride the dispatcher and executor get. No dual path. **One
   carve-out, stated up front:** the USD *budget ceiling* rides free on Claude
   but is BLOCKED on Codex until codex-driver Open Q4 ships a price table (§3);
   the Codex backend already waits on the seam, so this adds no new gate.
5. **Isolation is honest and layered.** The real security boundary is the
   subagent layer: every child runs under its provider's shipped isolation
   (Agent SDK tool allow-lists/permission modes; Codex native read-only sandbox
   + `approval:never`). The *script* runs in a `node:vm` context that is a
   **capability-shaping and determinism device, not a security sandbox** — Node
   documents `vm` as not a security mechanism, and a determined script can walk
   the prototype chain to host globals. That is acceptable because the author is
   the **first-party main agent** under the owner's own account: the script
   holds no authority the author doesn't already have, so the vm is not a trust
   boundary and we never present it as one. Spend is capped by the executor
   (§3), and every prompt/opts/result is journaled.
6. **A UI comes with it**: a composer Ultra chip, an in-transcript run block
   (phases, per-agent rows, narrator log), and an expandable inspector.

---

## 1. Problem & shape

The owner develops Telar with an external fan-out harness (Claude Code's
Workflow tool): the orchestrating model authors a deterministic JS script, the
harness executes it, spawning subagents with a journal + resume. Looms are the
heavyweight, autonomous, human-gated build system. Ultra is the **light** one:
a single user-requested orchestrated turn, no autonomy ladder.

**Ultra = a deterministic script executor living in `@telar/core`** that fans
out provider subagents from a normal Telar chat session. What it is NOT: it has
no charter, no Verification Contract, no gates, no thread inner-loop, no
mediation rungs, and it **never writes loom state and never writes `done`**. It
is not a loom and must never be mistaken for one. The chat's main agent decides
the decomposition; Ultra just runs it and hands back the result.

Relationship to looms: **orthogonal and untouched.** Ultra composes the same
leaf primitive (`agent()`) that looms compose, one layer lower than the loom
dispatcher. Nothing in `dispatcher.ts`/`executor.ts`/`verifier.ts` changes.

## 2. Doctrine fit

- **One engine.** Ultra is one executor used identically from a Claude session
  and a Codex session. It never inspects the provider itself: it calls
  `agent()`, which already dispatches env by the account fact (`accountEnv`,
  engine.ts:107) and — once the codex-driver seam lands — routes the spawn
  through `driverFor(provider)`. Ultra is provider-agnostic *for free*, exactly
  as the dispatcher/executor/thread-loop are (codex-driver §"Thread
  transcripts"). **Dependency, stated honestly:** Ultra needs nothing from the
  codex-driver track to ship on Claude. It needs the driver seam — and only the
  seam, no Ultra-specific work — to run on a Codex session. **Ship order:**
  Ultra Claude-first; Codex is the already-approved follow-on that lights up
  automatically. No Ultra code branches on provider.
- **Opt-in is a REQUEST, not a behavior flag.** The engine has no "ultra mode."
  Ultra is a tool the main agent may call; the tool description forbids
  reaching for it unless the user asked (keyword "ultra" or the composer Ultra
  chip annotates the message). This is a per-message user request, the same
  category as a user asking for anything — not a `TELAR_*` switch, not a
  `telar.yaml` key, not a default/alternative (forbidden by §1/§2).
- **No placebo.** Every UI knob is backed. There is exactly one control that
  writes anything (the composer Ultra chip → a message annotation the tool
  reads) and one that acts on a live run (Stop → the run's AbortController).
  Everything else is read-only projection of journaled state.
- **Structured output, one loop for both providers.** Ultra's injected
  `agent()` is a thin wrapper over engine `agent()`, whose typed-result
  contract is already "no emit = `null`, success never inferred" (engine.ts:222).
  Where a provider lacks native forcing (Codex, per codex-driver §emit_result),
  the *driver* owns the emit mechanism; Ultra adds one **executor-side
  validate-and-retry** on top — identical code for both backends: a `null`
  return triggers up to `K` re-spawns with a correction appendix, then a final
  `null`. No silent degradation, no dual path.
- **Ultra never writes loom state, never `done`.** It has no access to
  `saveLoom`/`appendEvent`/acceptance. Its store is a separate top-level dir
  (§5) so loom code (`listLooms`, `reconcileStuckLooms`) can never enumerate an
  Ultra run as a loom.

## 3. Executor

**Script format** (mirrors the reference harness exactly):

```js
export const meta = { name, description, phases };   // pure literal, no exec
export default async function ({ agent, parallel, pipeline, phase, log,
                                 budget, args }) { /* body */ }
```

`meta` is a pure object literal (statically read before any execution). The
body is `async` and receives ONE argument: the frozen injected surface. There
are no other globals.

**Injected surface** (the ONLY capabilities the script has):

| Global | Contract |
|---|---|
| `agent(prompt, opts?)` | wraps engine `agent()`; `opts`: `label`, `phase`, `schema` (forces validated object via the driver's emit path; without it returns final text), `model`, `effort`, `isolation` (fresh worktree for parallel mutators). Returns the typed value or `null` (dead agent). |
| `parallel(thunks)` | concurrent with a barrier; a thunk that throws an **agent failure** → `null`, never rejects. **Carve-out:** `BudgetExhausted`/`AbortError` are control signals, not failures — they propagate past the barrier and terminate the run (never coerced to `null`). (Existing `parallel`, engine.ts:228.) |
| `pipeline(items, ...stages)` | each item flows all stages independently, no inter-stage barrier; stage cb gets `(prev, item, i)`; a throwing stage drops that item to `null` (same control-signal carve-out as `parallel`). |
| `phase(title)`, `log(msg)` | progress grouping + narrator lines into the run's event stream. |
| `budget` | `{ total, spent(), reserved(), remaining() }` — one USD ceiling; `agent()` **reserves** a per-agent max before spawning and throws `BudgetExhausted` when a reservation won't fit (§3, reservation-based). |
| `args` | the JSON value passed at invocation. |

**Sandboxing — capability-shaping + determinism, NOT a security boundary
(zero new deps).** The script runs in a `node:vm` context (`vm.createContext`)
whose global object exposes ONLY the injected surface plus pure intrinsics
(`Object`, `Array`, `JSON`, `Math` sans `random`, `Promise`, `String`,
`Number`, etc.) — `require`/`import`/`process`/`fs`/`Buffer` are simply not in
scope, so an *authoring mistake* (a stray `fs.readFileSync`) is a
`ReferenceError` rather than a footgun, and the injected surface is
`Object.freeze`d so a capability can't be monkeypatched onto a shared
reference. **This is explicitly not a security sandbox.** Node documents `vm`
as "not a security mechanism"; a determined script reaches host globals by
walking the prototype chain (`agent.constructor` resolves through the
host-realm `Function` constructor → `agent.constructor('return process')()`),
and `Object.freeze` on own props does nothing to that inherited `.constructor`.
We do not pretend otherwise, because **there is no privilege drop to enforce**:
the script is authored by the same first-party main agent that already drives
looms and MCP under the owner's account, so it holds no authority the author
lacks — the vm buys capability-shaping and mechanical determinism (below), and
the real trust boundary is the subagent layer plus the spend cap, never this
context. Compilation: `new vm.Script(code)` once, source wrapped as
`({meta, default:...})` via a fixed CJS-style shim — no `vm.SourceTextModule`
experimental flag. **Event-loop honesty:** `vm`'s `timeout` guards only
synchronous *first* execution, not an async body — a first-party script with a
runaway `while(true)` would hang the single Node event loop (and with it the
dev server and every loom, §"single-process reality"). We treat that as an
author-quality bug, not a threat; the future hardening (untrusted authorship, a
`worker_threads` run with a real kill switch — still zero new deps) is in the
deviations table so it is never mistaken for shipped isolation.

**Determinism bans** (resume correctness depends on them): `Date.now`,
`new Date()`, and `Math.random` are made to **throw** inside the context
(`Date` and `Math.random` are replaced with throwing stubs; the rest of `Math`
is preserved). The script literally cannot observe wall-clock or entropy, so a
re-run is byte-identical given the same journal. This is stricter than the
reference (which documents the ban); Telar enforces it mechanically.

**Concurrency.** Fan-out is bounded by the engine's existing single in-process
gate (`MAX_CONCURRENT`, engine.ts:89) — every Ultra `agent()` acquires it, so
Ultra shares the process-wide budget with any looms running, and cannot
stampede. A per-run **1000-agent lifetime backstop** and the USD budget are the
two hard ceilings. (Deviation from the reference's `min(16, cores-2)`: the cap
is the engine's shared gate, because raising concurrency is an engine change
that must land for everyone at once — §1 — not an Ultra-local number.)

**Budget is a hard ceiling — reservation-based, concurrency-safe.** A naïve
"throw once `spent() ≥ total`" does NOT bound fan-out: under `parallel()` every
thunk's `agent()` passes the check before any child has returned its `costUsd`,
so a `total=$5` run with 100 concurrent `$1` agents spends ~`$100`. Instead
each `agent()` **reserves** a per-agent max (`opts.maxUsd` or a run default)
*before* spawning; admission is `remaining() = total − spent − reserved ≥
reservation`, else it throws `BudgetExhausted`. On completion the reservation
is released and the real `costUsd` booked into `spent()`. Because *reserved*
(not just settled) spend gates the next spawn, peak concurrent commitment can
never exceed `total`. The `BudgetExhausted` throw is a **control signal**:
`parallel`/`pipeline` do not coerce it to `null` (they swallow only agent
failures) — it unwinds past the barrier, no further `agent()` admits, and the
run ends `failed(budget)` with the journal intact for an edited resume. Claude
`costUsd` = `total_cost_usd` (engine.ts:217). **Codex USD ceiling is BLOCKED,
not free:** codex-app-server exposes token counts only (no `cost_usd`;
`cache_creation` hardcoded 0), and the tokens×price table is codex-driver
**Open Q4 — still open**. Until Q4 ships that table as a provider-fact the
Codex path cannot enforce a USD reservation; since the whole Codex backend
already waits on the driver seam, Ultra treats Q4 as a **blocking dependency of
the Codex path**, not a solved fact. There is no token-only USD path — that
would silently unbound the waste guard, exactly as the codex-driver doc
forbids.

**Journal + deterministic-ordinal resume.** The script is deterministic
(time/random banned), so the *order in which `agent()` calls are ISSUED* is
reproducible — even though completion order under `parallel()` is not, and even
though identical fan-out calls would collide on a content hash. Ultra therefore
keys each call by a **monotonic ordinal assigned at invocation time** (in issue
order, at the synchronous moment `agent()` is called — deterministic because
`parallel` kicks off its thunks in array order), NOT by completion order and
NOT by content alone. Each result is journaled under its ordinal together with
a content hash of `(prompt, opts)` (stable-stringify, schema included) for
divergence detection. **Resume** re-runs the script from the top; the Nth
issued `agent()` call is served from journal entry N instantly (no spawn) when
its content hash matches; the first ordinal whose hash diverges (the script was
edited there) resumes live from that point on. Stop → edit → resume is the
standard surgery. `phase`/`log` re-emit from the deterministic re-run (cheap).
**Corruption tolerance:** `journal.jsonl` is parsed line-by-line on resume; a
torn or unparseable trailing line (crash mid-append) is dropped and that
ordinal simply re-runs — a single interrupted write never breaks recovery.

**Abort.** One `AbortController` per run, shared into every `agent()` call
(`opts.abort`, engine.ts:169). The user Stop button aborts it → every in-flight
child is interrupted and the run ends `stopped`. The journal keeps completed
prefix for resume.

**Single-process reality (honest).** A Telar run is an in-process detached
async task, like a chat turn and its delta ring (session-log.ts §"single-process
assumption"): the run registry is `globalThis`-backed so it survives Next dev
HMR and **survives page navigation** (the browser re-subscribes over SSE and
tails `journal.jsonl` + the in-memory activity ring). **On server restart the
running task dies** — there is no cross-process supervisor, by design (local-
first) — and so does the blocking `ultra` tool call's chat turn. Recovery is
**explicit, not hand-waved**: on startup Ultra scans `~/.telar/ultra/` for runs
left in `running` with no live in-memory task and marks them `interrupted`. The
UI surfaces an `interrupted` run with a **Resume** affordance; resume is
**user- or agent-initiated** via `/api/ultra/[id]/resume`, which re-runs serving
the journal prefix (no completed work repaid; in-flight-at-crash ordinals
re-run). The orphaned tool call is reconciled the way the chat already handles
an interrupted turn: its `tool_use` never receives a result, the session marks
the turn interrupted, and the resumed run's outcome is delivered as a **fresh
assistant message**, not through the dead call. Nothing is assumed to
spontaneously re-invoke the owner.

## 4. Authoring & invocation

The session's **main agent authors the script**, exactly like the reference
harness. Ultra is exposed as an `ultra` MCP tool (an in-process
`createSdkMcpServer` tool, the same pattern as `loom-mcp.ts` and engine
`emit_result`) available to **both** provider main agents — the single harness.

- **Tool input:** `{ script: string, args?: JSON }`. **Opt-in rule lives in the
  tool description:** "Only call `ultra` when the user explicitly asked for a
  large orchestrated run (said 'ultra', or the message is Ultra-annotated).
  Never infer it." The composer Ultra chip annotates the user message; the
  system prompt tells the agent an annotated message is the user's request.
- **Return:** the tool blocks until the run reaches a terminal state and returns
  the script's resolved value (or a structured `{stopped|failed|blocked, ...}`).
  The main agent narrates the result to the user.
- **Validation errors → back to the author agent.** Before execution Ultra
  statically checks: `meta` is a pure literal, a default export exists, and the
  source parses. It also **lints** for obvious non-capabilities (`require`,
  `import`, `process`, `Date`, `Math.random`) — but purely to return a fast,
  legible authoring error ("`process` isn't in scope; use the injected
  surface"). This lint is an **ergonomics aid, not a security control**: it is
  trivially bypassed by dynamic access (`this['pro'+'cess']`,
  `globalThis['req'+'uire']`), so it is never presented as the admission
  boundary — §3 is explicit that there is no security boundary at the script
  layer. A failure returns a structured `{error, kind, detail, line}` to the
  agent (not the user) so it revises and re-calls — the tool-layer retry the
  reference relies on.
- **Nested-run policy:** the injected surface does **not** include `ultra`, and
  subagents get their normal restricted tool sets, so a script cannot recurse
  into another Ultra run. One level of orchestration, always.
- **Spend in session cost:** the run's `spentUsd` is attributed to the owning
  chat message (linkage in §5) and folds into the session's existing per-turn
  cost accounting — the user sees Ultra spend in the same usage bar as chat.

## 5. Storage & API

**Where runs live.** `~/.telar/ultra/<runId>/` (override `TELAR_HOME`), a new
top-level sibling of `looms/` and `sessions/` — deliberately NOT under
`looms/`, so no loom-listing/reaper code can ever see an Ultra run. It mirrors
the loom file conventions:

- `manifest.json` — atomic rewrite (temp+rename, as looms.ts): `{runId,
  sessionId, messageId, account, meta, args, state, spentUsd, startedAt}`.
  `sessionId`+`messageId` are the **linkage to the owning chat message**.
- `journal.jsonl` — append-only, the content-keyed `agent()` results (resume
  source), tailed by the UI by line offset like `events.ndjson`.
- `events.ndjson` — append-only progress stream (phase/log/agent-state/result),
  the SSE tail source.
- `agents/<contentKey>.ndjson` — per-agent transcript (the `EngineEvent`
  stream from that `agent()` call: text/tool/tool-result), for the inspector.

**API routes** (mirror the loom/chat SSE idioms in the recon):

| Route | Verb | Purpose |
|---|---|---|
| `/api/ultra` | POST | create+start a run (called by the tool handler); returns `runId`. |
| `/api/ultra/[id]` | GET | manifest + terminal result. |
| `/api/ultra/[id]/events` | GET (SSE) | progress tail (`run` events with phase/agent/log deltas by line offset; `end` closes), same shape as `/api/looms/[id]/events`. |
| `/api/ultra/[id]/stop` | POST | abort the AbortController. |
| `/api/ultra/[id]/resume` | POST | re-run the (possibly edited) script serving the journal prefix. |
| `/api/ultra/[id]/agents/[key]` | GET | one agent transcript for the inspector. |

## 6. UI CONTRACT (FROZEN — the mockup agent builds EXACTLY this)

House rules apply (design-pass.md): terse copy, `min-w-0`+`truncate` on
variable-width flex children, density over height, no placebo, masked shimmer
only. Gallery mock uses fixtures (client-bundle rule) — a `setInterval`-driven
fake of the `/api/ultra/[id]/events` EventSource, no real SDK.

1. **Composer Ultra affordance.** A toggle chip in the chat composer ("Ultra").
   Active → the sent message is annotated `ultra:true`; the chip shows an armed
   state. It is the ONLY new composer control. No submenu, no options.
2. **In-transcript RUN BLOCK** (durable, appended after the message like the
   loom `InlineLoomRow`, fed by the SSE subscriber):
   - Header: run name (`meta.name`), overall state pill
     (`running`/`stopped`/`completed`/`failed`), live budget meter
     (`spent / total` USD), elapsed agent count.
   - **Phase groups** (`phase()` titles) as collapsible sections.
   - **Per-agent rows** inside a phase: `label` · state
     (`queued`/`running`/`done`/`failed`) · a one-line **live activity snippet**
     (latest tool/text from that agent's transcript, truncated) · token/cost
     count. Queued rows are dimmed; running rows carry the masked shimmer;
     failed rows a quiet error affordance.
   - **Narrator `log()` lines** interleaved in timeline order with agent-row
     state changes (a lightweight lifecycle log, not a wall).
   - **Collapse:** the whole block collapses to a one-line summary (name, state,
     `n agents`, spend); phases collapse independently. Default expanded while
     running, auto-collapsed on terminal.
3. **Expanded run inspector.** Opens in the existing **SubagentRail** side rail
   (persistent, collapsible — reuse, don't invent), keyed to the run. Adds over
   the inline block: (a) **per-agent detail** — full transcript for the selected
   agent row (tool calls, result JSON); (b) **script view** — read-only source +
   `meta`; (c) **budget meter** — spend over time / per-phase. No controls here
   except Stop.
4. **Terminal states.** `completed` → a result block (the returned value,
   pretty-printed/JSON, collapsible) under the run block. `stopped` → "Stopped
   by you" with the partial journal still inspectable + a Resume affordance.
   `failed` → the terminal error (script throw / validation) terse, Resume
   offered. (No `blocked` — Ultra has no human-question rung.)
5. **Dock/bubble for a live run.** While a run is live and the user scrolls away
   or navigates, a small persistent **dock bubble** (run name + state + spend +
   Stop) keeps it reachable and re-opens the inspector on tap — reusing the rail
   collapse state, not a new overlay. One bubble per live run.

## 7. Build plan

Cuts sized like codex-driver — each independently green-gate-able
(`bun test packages/core`, `tsc` core + web).

- **U1 — sandbox + executor core (`packages/core/src/ultra/`).** `node:vm`
  context, frozen injected surface, determinism bans, `meta` static read,
  `agent()`/`parallel()` wired to engine, budget accounting, 1000-agent
  backstop, AbortController. Unit tests: banned-identifier rejection, frozen
  surface, budget throw, abort.
- **U2 — journal + resume.** Content-key hashing, `journal.jsonl` append,
  prefix-serve resume, `agents/<key>.ndjson` transcripts. Test: edit-tail
  resume serves the unchanged prefix and re-runs from divergence.
- **U3 — validate-and-retry + `pipeline`/`phase`/`log`.** The structured-output
  retry loop; the remaining injected globals; the run event stream.
- **U4 — storage + API routes** (`~/.telar/ultra/`, the six routes, SSE tail).
- **U5 — `ultra` MCP tool + composer annotation + session-cost linkage.** Tool
  in the shared MCP surface, opt-in description, validation-error return path.
- **U6 — UI** (separate mockup agent builds §6 against fixtures; then wire to
  the real SSE). Ships behind the same green gate; gallery entry first.

**Prove-run plan** (sandbox project, cheap real runs):

1. **Claude path:** a small real run — e.g. "ultra: summarize these 8 files in
   parallel and rank them" — asserting: script sandboxed (a `require` attempt
   is rejected at validation); `parallel` fan-out through the shared gate;
   every `agent()` typed result Zod-valid; `budget.spent() > 0` and a synthetic
   low `budget.total` makes the next **reservation** throw `BudgetExhausted`,
   the throw unwinds past the `parallel` barrier (asserted NOT swallowed to
   `null`), and the run ends `failed(budget)` with fan-out clamped; Stop aborts
   all children; edit-and-resume serves the journal prefix by ordinal.
2. **Codex path (gated on the codex-driver seam AND Open Q4's price table):**
   the SAME script on a Codex-account session, asserting identical behavior with
   `costUsd` populated from tokens×price and the structured-output retry loop
   exercising the Codex emit path — proving the single executor, both backends,
   no Ultra branch. Until Q4 lands the Codex USD ceiling is unenforceable, so
   this path stays blocked (Claude-first ship order, exec-summary pt 4).

## Deviations from the reference harness

| Reference | Telar Ultra | Why |
|---|---|---|
| Concurrency `min(16, cores-2)` | the engine's shared in-process gate | raising concurrency is an engine change that lands for everyone (§1), not an Ultra-local knob. |
| Time/random "banned by convention" | banned **mechanically** (stubs throw in the `vm` context) | Telar enforces resume determinism by construction, not documentation. |
| Harness may run out-of-process/persistent | in-process, dies on server restart; journal-resume recovers | local-first single-process reality (session-log.ts); honest, no invented supervisor. |
| Store unspecified | new `~/.telar/ultra/` top-level | keeps Ultra runs invisible to loom listing/reaper — Ultra is not a loom. |
| Result emit provider-native | executor-side validate-and-retry over the driver's emit | one loop both backends; no silent degradation where a provider lacks native forcing. |
| Subagent isolation is vendor-shipped; script isolation is invented | subagents keep vendor isolation (SDK tool allow-lists/permission modes; Codex native read-only sandbox + `approval:never`); the **script** runs in `node:vm`, a **non-security** capability/determinism device that a determined script can escape (prototype-chain walk to host `process`) | Node documents `vm` as not a security mechanism; no-new-deps rules out a real isolate (`isolated-vm`/subprocess), and the first-party author holds no authority to fence off — disclosed honestly, never sold as a boundary. `worker_threads` is the future hardening if untrusted scripts arrive. |

## Open questions (owner verdict)

1. **Store location:** `~/.telar/ultra/<id>/` (this plan) vs reusing
   `looms/<id>/` (recon's suggestion). I chose a separate dir to keep loom code
   from ever enumerating a run. Confirm?
2. **Composer chip vs keyword-only:** ship the composer Ultra chip in U5, or
   start keyword-only ("ultra" in the message) and add the chip later? The chip
   is the clearer affordance but is the one new composer control.
3. **`schema`-less `agent()`** returning raw final text: keep it (reference
   parity, cheaper for read-only fan-out) or force a schema always (stronger
   typed-result guarantee)? Reference allows both.
4. **Resume ergonomics:** should Stop→edit→Resume be driven by the main agent
   re-calling `ultra` with an edited script, or a first-class UI "edit & resume"
   on the run block? The former is simpler; the latter matches the reference's
   "standard surgery" framing.
5. **Codex ship gating:** advertise Ultra as Claude-only until the codex-driver
   seam lands (honest, no half-Codex), or hold Ultra's release until both
   backends prove? I recommend Claude-first, Codex auto-lights-up.
