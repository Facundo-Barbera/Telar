# Telar Ultra — a deterministic script harness inside the engine

> Doctrine-bound (`docs/PRINCIPLES.md`). Design plan, not as-built. Depends on
> the approved codex-engine-driver plan (`docs/plans/codex-engine-driver.md`)
> for its Codex backend; ships Claude-first without it. Looms are untouched.

## Executive summary (for the owner)

1. **Ultra is a side quest — a tool of the main agent.** It brings the fan-out
   harness you develop Telar with INSIDE Telar, as an `ultra` MCP tool the main
   agent authors a script for and the engine executes deterministically. Not a
   mode, not a loom — one more thing the agent reaches for, launches, and stops.
   **It reuses, not rebuilds:** every subagent is one existing `agent()`, fan-out
   is existing `parallel()`; Ultra adds only a script sandbox, an ordinal-keyed
   journal, and a progress surface — no new spawn primitive.
2. It is **lighter than looms on purpose**: no charter, no gates, no
   verify/mediate rungs, no `ready→done`. **Non-blocking:** the tool returns
   `{runId}` immediately, the run detaches, and completion comes back to the main
   agent as an event it reacts to. **Several runs per session run in parallel**,
   a supported case. Looms stay exactly as they are.
3. **One engine, both providers.** Ultra only ever calls `agent()`, so it
   inherits Claude today and Codex the moment the codex-driver seam lands. **No
   budget carve-out:** budgets removed (pt 5) means the Codex path needs only the
   seam — no price table, no Open-Q4 dependency. Cost is *visibility*, not a cap
   (USD Claude / tokens Codex). No Ultra code branches on provider.
4. **Isolation is honest and layered.** The real security boundary is the **child
   posture** (§3): subagents run non-interactive under a fixed, vendor-shipped
   posture — the normal session tool surface for that provider — and any action
   needing an interactive approval **fails the `agent()` call** rather than
   pausing the run. The *script* vm is a capability/determinism device, **not a
   security sandbox** — fine because the **first-party main agent** authors it and
   holds no authority to fence (§3).
5. **No budgets, explicit models (owner decisions).** No spend ceiling anywhere —
   no spend-holdback math, no `budget` global; bounded discovery is *loop-until-dry*.
   What remains: live **cost visibility** (per-agent tokens/cost, in the session's
   cost language) plus **runaway brakes** (per-run concurrency cap, lifetime
   agent-count backstop, human Stop, the agent's stop control). Separately, every
   `agent()` call must name its `model` — validation rejects a script that omits
   it — and the UI shows `model·effort` on every agent row.
6. **A UI comes with it, arranged as a side quest**: a composer Ultra chip that
   only arms; a compact **fixed-height transcript anchor** per run; and the
   **existing sub-agent rail** gains a Workflows section. No inline-large run
   block, no bespoke inspector, no budget meter (§6).

## 1. Problem & shape

The owner develops Telar with an external fan-out harness (Claude Code's
Workflow tool): the orchestrating model authors a deterministic JS script, the
harness executes it, spawning subagents with a journal + resume. Looms are the
heavyweight, autonomous, human-gated build system; Ultra is the **light** one —
a single user-requested orchestrated turn, no autonomy ladder.

**Ultra = a deterministic script executor in `@telar/core`** that fans out
provider subagents from a normal chat session. What it is NOT: no charter, no
Verification Contract, no gates, no thread inner-loop, no mediation rungs, and it
**never writes loom state and never `done`**. It is not a loom; the main agent
decides the decomposition and Ultra just runs it and hands back the result.
**Orthogonal and untouched:** Ultra composes the same leaf `agent()` looms
compose, one layer below the loom dispatcher — nothing in
`dispatcher.ts`/`executor.ts`/`verifier.ts` changes.

## 2. Doctrine fit

- **One engine.** Ultra is one executor used identically from a Claude and a
  Codex session; it never inspects the provider. It calls `agent()`, which
  already dispatches env by the account fact (`accountEnv`, engine.ts:107) and —
  once the codex-driver seam lands — routes the spawn through
  `driverFor(provider)`. Ultra is provider-agnostic *for free*, like the
  dispatcher/executor/thread-loop; it ships Claude-first and lights up on Codex
  when the seam lands (no Ultra-specific work either way).
- **Opt-in is a REQUEST, not a behavior flag.** The engine has no "ultra mode."
  It is a tool the main agent may call; the description forbids reaching for it
  unless the user asked (keyword "ultra" or the composer chip annotates the
  message). A per-message user request — not a `TELAR_*` switch, not a
  `telar.yaml` key, not a default/alternative (forbidden by §1/§2).
- **No placebo.** Every UI knob is backed. Exactly two things write: the composer
  Ultra chip (→ a message annotation the tool reads) and Stop (→ the run's
  AbortController, from the human's button or the agent's `ultra_stop`).
  Everything else is a read-only projection of journaled state.
- **Structured output, one loop for both providers.** The injected `agent()`
  wraps engine `agent()`, whose contract is already "no emit = `null`, success
  never inferred" (engine.ts:222). Where a provider lacks native forcing (Codex)
  the *driver* owns the emit; Ultra adds one **executor-side validate-and-retry**
  (K=2, then a final `null`), identical for both backends. No dual path.
- **Ultra never writes loom state, never `done`.** No access to
  `saveLoom`/`appendEvent`/acceptance; its store is a separate top-level dir (§5)
  so loom code (`listLooms`, `reconcileStuckLooms`) can never enumerate a run.

## 3. Executor

**Script format** (mirrors the reference harness, minus the budget global):

```js
export const meta = { name, description, phases };   // pure literal, no exec
export default async function ({ agent, parallel, pipeline, phase, log,
                                 args }) { /* body */ }
```

`meta` is a pure object literal (statically read before any execution). The
`async` body receives ONE argument, the frozen injected surface; there are no
other globals — and, deliberately, **no `budget`** (owner decision, pt 5).

**Injected surface** (the ONLY capabilities the script has):

| Global | Contract |
|---|---|
| `agent(prompt, opts)` | wraps engine `agent()`. `opts.model` is **REQUIRED** (a call without it throws `MissingModel`; §4 rejects it). Other `opts`: `label`, `phase`, `effort`, `schema` (forces a validated object via the driver's emit path; without it returns final text), `isolation` (fresh worktree for parallel mutators — narrows *where* writes land, never *whether* the child can write). Returns the typed value or `null` (dead agent). **No per-agent permission knob** — the child posture is fixed (below). |
| `parallel(thunks)` | concurrent with a barrier; a thunk that throws an **agent failure** → `null`, never rejects. **Carve-out:** `AbortError` (Stop) and `MissingModel` (the explicit-model contract) are **control signals**, not failures — they propagate past the barrier and terminate the run (never coerced to `null`). (Existing `parallel`, engine.ts:228.) |
| `pipeline(items, ...stages)` | each item flows all stages independently, no inter-stage barrier; stage cb gets `(prev, item, i)`; a throwing stage drops that item to `null` (same control-signal carve-out as `parallel`). |
| `phase(title)`, `log(msg)` | progress grouping + narrator lines into the run's event stream. |
| `args` | the JSON value passed at invocation. |

**Child posture — the real security boundary (fixed, non-interactive,
fail-closed).** Every subagent runs under the **same tool surface a normal Telar
session agent has for that provider** — no elevation, no human-approval path
mid-run. Any action that would require an interactive approval **fails that
`agent()` call** (fail-closed, the shape of a charter-time refusal) instead of
pausing the run. Enforcement is **vendor-shipped only**, never Ultra-invented:
**Claude** via Agent SDK `canUseTool`/`allowedTools` (writes confined to the
project root, or the `opts.isolation` worktree); **Codex** via native sandbox
`workspace-write` + `approval-policy: never`. There is deliberately **no
per-agent permission knob** in `agent()` opts — scripts *narrow* work
(`isolation`, `schema`), never *grant* capability. The isolation story rests
here; the script vm below is not it.

**Script sandboxing — capability-shaping + determinism, NOT a security boundary
(zero new deps).** The script runs in a `node:vm` context whose global exposes
ONLY the injected surface plus pure intrinsics (`Object`, `Array`, `JSON`,
`Math` sans `random`, `Promise`, …) — `require`/`import`/`process`/`fs` are not
in scope, so an authoring mistake (a stray `fs.readFileSync`) is a
`ReferenceError`, not a footgun, and the surface is `Object.freeze`d against
monkeypatching. Compilation: `new vm.Script(code)` once, wrapped
`({meta, default:...})` via a fixed CJS shim — no experimental module flag.
**This is explicitly not a security sandbox:** Node documents `vm` as "not a
security mechanism"; a determined script reaches host globals via the prototype
chain (`agent.constructor('return process')()`), which `Object.freeze` cannot
stop. We do not pretend otherwise, because **there is no privilege to drop** —
the first-party author already drives looms and MCP under the owner's account and
holds no authority to fence; the trust boundary is the child posture above.
**Event-loop honesty:** `vm`'s `timeout` guards only synchronous *first*
execution, so a runaway `while(true)` hangs the single Node event loop (and every
loom) — an author-quality bug, not a threat; the future `worker_threads` kill
switch (deviations table, zero new deps) is not shipped now.

**Determinism bans** (resume correctness depends on them): `Date.now`,
`new Date()`, and `Math.random` **throw** inside the context (throwing stubs; the
rest of `Math` preserved). The script cannot observe wall-clock or entropy, so a
re-run is byte-identical given the same journal — stricter than the reference,
which only documents the ban.

**Concurrency + runaway brakes (numbers, no budget).** Fan-out is bounded by
two layered caps, both concrete:

- **Per-run cap = 3.** A run-local semaphore: no single run holds more than 3
  in-flight `agent()` calls, so a burst of 100 parallel thunks can never
  monopolize the process or starve sibling runs / looms.
- **Per-process ceiling = 4.** Every Ultra `agent()` also acquires the engine's
  shared gate (`MAX_CONCURRENT = 4`, engine.ts:89), the honest hard ceiling on
  concurrent child turns across *all* runs and looms in the single Node process.
  Low by design; raising it is an engine change for everyone (§1), not an Ultra
  knob. **Lifetime backstop = 1000 agents/run**, so an unbounded loop can't spawn
  forever.

Beyond these caps the runaway story is human/agent control, not a budget: the
**human Stop** and the **agent's `ultra_stop`** (§4) both abort a run.

**Cost visibility (not a cap).** Each `agent()`'s settled cost streams live
per-agent in the session's cost language — **USD on Claude** (`total_cost_usd`,
engine.ts:217), **tokens on Codex** (no `cost_usd`) — and the run total rolls up
into the owning chat message's usage (§4). Nothing gates on it; it is a readout.

**Journal + deterministic-ordinal resume.** The script is deterministic
(time/random banned), so the *order in which `agent()` calls are ISSUED* is
reproducible — even though completion order under `parallel()` is not. Ultra
keys each call by a **monotonic ordinal assigned at issue time** (deterministic
because `parallel` kicks off its thunks in array order). **The ordinal is THE
key everywhere** — journal records, transcripts (`agents/<ordinal>.ndjson`), the
API (`/agents/[ordinal]`). A **content hash of `(prompt, opts)`** (stable-
stringify, schema included) is stored *inside* each record purely as a
**cache-validity check**. **Resume** re-runs the script from the top; call `i`
is served from journal record `i` instantly (no spawn) **iff** its stored hash
matches call `i` of the re-executed script; the **first mismatch invalidates `i`
and every later ordinal** (the script was edited there) and resumes those live.
Stop → edit → resume is the standard surgery; `phase`/`log` re-emit from the
cheap re-run. **Corruption tolerance:** `journal.jsonl` is parsed line-by-line; a
torn trailing line (crash mid-append) is dropped and that ordinal re-runs.

**Abort + single-process reality (honest).** One `AbortController` per run,
shared into every `agent()` call (`opts.abort`, engine.ts:169); Stop (human
button or `ultra_stop`) aborts it → in-flight children interrupt, the run ends
**`stopped`**, journal prefix kept. A run is an in-process detached task: the
registry is `globalThis`-backed so it survives Next dev HMR and page navigation
(the browser re-subscribes over SSE, tailing `journal.jsonl` + the in-memory
ring). **On server restart the task dies** — no cross-process supervisor, by
design (local-first). A user Stop and a server death land in the **same state,
`stopped`**, both resuming from the journal; on startup Ultra scans
`~/.telar/ultra/` for `running` runs with no live task and marks them `stopped`
(Resume offered). Because the tool is **non-blocking** (§4) there is no orphaned
tool call to reconcile — the completion event simply fires on the resumed run's
terminal instead.

## 4. Authoring & invocation

The session's **main agent authors the script**, like the reference harness.
Ultra is exposed as MCP tools (in-process `createSdkMcpServer`, the pattern of
`loom-mcp.ts` and engine `emit_result`) to **both** provider main agents.

- **Tools:** `ultra({ script, args? })`, `ultra_status({ runId })`,
  `ultra_stop({ runId })`. **Opt-in rule lives in the `ultra` description:**
  "Only call `ultra` when the user explicitly asked for a large orchestrated run
  (said 'ultra', or the message is Ultra-annotated). Never infer it." The
  composer Ultra chip annotates the user message; the system prompt tells the
  agent an annotated message is the user's request.
- **Non-blocking return (owner decision).** `ultra` **validates synchronously,
  then returns `{runId}` immediately** — it does NOT block. The run detaches; the
  agent and user keep talking. The agent polls `ultra_status(runId)` and stops
  via `ultra_stop(runId)`. On terminal, the outcome reaches the agent as a
  **completion event / fresh tool-result** (resolved value, or `{state, ...}`)
  which it summarizes in chat. **Several runs may be live at once** — every
  control is keyed by `runId`.
- **Explicit-model enforcement (owner decision).** A best-effort **static lint**
  on the `agent()` call sites catches a `model`-less call *before* `runId` is
  returned — a fast, synchronous reject. The hard contract is at the runtime
  `agent()` boundary: a call reached without `model` throws `MissingModel`, a
  control signal that unwinds past any `parallel` barrier and ends the run
  `failed`, structured error back to the agent so it re-authors.
- **Other validation → back to the author agent.** Before returning `runId` Ultra
  checks that `meta` is a pure literal, a default export exists, and the source
  parses. It also **lints** out-of-scope identifiers (`require`, `import`,
  `process`, `Date`, `Math.random`) — **a determinism/hygiene aid, not a security
  control:** trivially bypassed by dynamic access (`this['pro'+'cess']`), so never
  presented as an admission boundary (§3: no security boundary at the script
  layer). Failures return `{error, kind, detail, line}` to the agent, not the
  user.
- **Child posture (restated for the author).** Subagents run non-interactive
  under the fixed vendor-shipped posture of §3 — the normal Telar tool surface,
  no elevation, any approval-needing action fails the `agent()` call. Scripts
  narrow work; they never grant capability.
- **Nested-run policy.** The injected surface does **not** include `ultra`, so a
  script cannot recurse into another run. One level of orchestration, always.
- **Spend visibility.** The run's live spend (§3) is attributed to the owning
  chat message and folds into the session's per-turn usage display — a readout,
  no cap.

**Authoring reference (ships with the tool).** A **single source file in core**
ships **with** the tool so agents know how to write good scripts — **for Claude**
injected as a skill / system-prompt appendix, **for Codex** folded into the
`ultra` tool description. Same content both ways: the injected surface API; the
**explicit-model rule** (every `agent()` names `model·effort`); quality patterns
(**adversarial-verify** — a critic `agent()` checks a builder; **loop-until-dry**
— the no-budget way to bound discovery, iterate until the queue is empty, not to
a ceiling); and a worked example. Hidden from chrome; the rail's Script tab (§6)
may link it.

## 5. Storage & API

**Where runs live.** `~/.telar/ultra/<runId>/` (override `TELAR_HOME`), a new
top-level sibling of `looms/`/`sessions/` — deliberately NOT under `looms/`, so
no loom-listing/reaper code can ever see a run. It mirrors loom conventions:

- `manifest.json` — atomic rewrite (temp+rename, as looms.ts): `{runId,
  sessionId, messageId, account, meta, args, state, spend, startedAt}`,
  `state ∈ running | stopped | completed | failed`, `spend` the live total (USD
  Claude / tokens Codex); `sessionId`+`messageId` **link the owning chat message**.
- `journal.jsonl` — append-only, one record per **ordinal** (the resume source):
  the `agent()` result + its `(prompt, opts)` content hash (cache check, §3); UI
  tails it by line offset.
- `events.ndjson` — append-only progress stream (phase/log/agent/result), the SSE
  tail source.
- `agents/<ordinal>.ndjson` — per-agent transcript (that ordinal's `EngineEvent`
  stream: text/tool/tool-result), for the rail's agent view.

**API routes** (mirror the loom/chat SSE idioms):

| Route | Verb | Purpose |
|---|---|---|
| `/api/ultra` | POST | validate + create + start a run (called by the `ultra` tool handler); returns `{runId}` immediately. |
| `/api/ultra/[id]` | GET | manifest + state + terminal result. |
| `/api/ultra/[id]/events` | GET (SSE) | progress tail (phase/agent/log deltas by line offset; `end` closes), same shape as `/api/looms/[id]/events`. |
| `/api/ultra/[id]/stop` | POST | abort the AbortController → `stopped`. |
| `/api/ultra/[id]/resume` | POST | re-run the (possibly edited) script serving the journal prefix by ordinal. |
| `/api/ultra/[id]/agents/[ordinal]` | GET | one agent transcript for the rail. |

## 6. UI CONTRACT v2 (FROZEN — the mockup builds EXACTLY this)

House rules apply (design-pass.md): terse copy, `min-w-0`+`truncate` on
variable-width flex children, density over height, no placebo, masked shimmer
only. The gallery mock is **fixtures-only** (client-bundle rule) — a
`setInterval` fake of the `/api/ultra/[id]/events` EventSource, no real SDK; no
`Date.now()`/`toLocale*` in any SSR-reachable path (use `DEMO_NOW` + `fmtAgo`).

1. **CONTEXT — a session, not a stage.** Everything renders inside real
   session-window chrome: header, transcript, composer, and the **existing
   sub-agent rail** (the owner-selected round-1.1 sidebar). The mockup **embeds a
   session view**, not a standalone Ultra surface; the composer Ultra chip is a
   normal composer control here.
2. **ANCHOR — a side quest, not a window.** Each run appears in the transcript as
   **ONE compact fixed-height tool-style row**: run name, state pill, agents
   done/total, a quiet spend readout (`$` Claude / tokens Codex), a thin progress
   sliver. **Fixed-height while running — it never grows or reflows**; conversation continues beneath it. Its **sole permitted height change** is a one-time collapse to a one-liner on reaching a terminal state (§6.7) — no per-tick resize. Clicking it **focuses that run in the rail**.
3. **RAIL — Workflows section.** The existing sub-agent rail gains a
   **Workflows** section listing every run of the session. A run **card** shows
   name + state + spend; **phase groups** with per-agent rows (`label` · state ·
   `model·effort` chip · masked-shimmer live snippet · tokens/cost); and a
   **fixed-height scrolling narrator `log()` window** (no layout shift, ever).
   Clicking an agent row **opens its transcript as a sub-agent tab does today**.
   A **Script tab** shows the script read-only (model pins visible) + a link-out
   to the authoring reference. **Stop** lives on the card.
4. **MULTIPLE RUNS.** The story shows **≥2 runs live concurrently plus 1
   completed** — anchors stacked in the transcript where launched, all listed
   together in the rail.
5. **MAIN-AGENT CONTROL.** The transcript story shows the main agent **launching
   a run** (tool call → immediate `runId`), human and agent **continuing the
   conversation** while it runs, the agent **stopping one run by tool call**
   (visible in anchor + rail), and **reacting to another run's completion event**
   by summarizing it in chat. Include one beat where a script omitting
   `opts.model` is **validation-REJECTED** and the agent **re-authors** — teaching
   the explicit-model rule on screen.
6. **NO BUDGET UI anywhere.** No meters, no ceilings, no reserved headroom —
   **spend readouts only**. The composer Ultra chip just **arms** ultra (no
   ceiling editor, no submenu).
7. **TERMINAL STATES.** `completed` / `stopped` / `failed` chips. `stopped` shows
   a **Resume** affordance; `completed` triggers the anchor's **one permitted terminal transition** — a single collapse to a one-liner (§6.2: the only resize, once, at the end — not the live-run growth owner decision E killed), result reachable from the rail card; `failed` shows the terse terminal error, Resume offered.
8. **REPLAY.** Play / Pause / Restart / speed drive the whole story
   **deterministically** — virtual time only, so replay is exact.
9. **DOCK.** A session with live runs shows **run state in its dock bubble** (name
   · state · spend), adapting v1's dock behavior to the anchor+rail arrangement —
   tapping re-focuses the run. One dock signal per session; live runs summarize.

## 7. Build plan

Cuts sized like codex-driver, each independently green-gate-able
(`bun test packages/core`, `tsc` core + web).

- **U1 — sandbox + executor core (`packages/core/src/ultra/`).** `node:vm`
  context, frozen surface, determinism bans, `meta` static read,
  `agent()`/`parallel()` wired to engine, per-run cap + 1000-agent backstop,
  AbortController. Tests: banned-identifier reject, frozen surface, `MissingModel`
  throw, per-run cap, abort.
- **U2 — journal + ordinal resume.** Ordinal keying, `(prompt,opts)` hash cache
  check, `journal.jsonl` append, prefix-serve resume, `agents/<ordinal>.ndjson`.
  Test: edit-tail resume serves the prefix by ordinal, re-runs from divergence.
- **U3 — validate-and-retry + `pipeline`/`phase`/`log`.** The K=2 retry loop; the
  remaining globals; the run event stream; cost-visibility roll-up.
- **U4 — storage + API routes** (`~/.telar/ultra/`, the six routes, SSE tail).
- **U5 — `ultra`/`ultra_status`/`ultra_stop` tools + composer annotation +
  session-cost linkage + authoring reference.** Non-blocking return, opt-in
  description, validation-error return path, child posture via SDK `allowedTools`
  / Codex sandbox.
- **U6 — UI** (mockup agent builds §6 against fixtures; then wire to real SSE).
  Same green gate; gallery entry first.

**Prove-run plan** (sandbox project, cheap real runs):

1. **Claude path:** a small real run ("ultra: summarize these 8 files in parallel
   and rank them") asserting: the hygiene lint catches a `require`; `parallel`
   honors the per-run cap under the shared gate; every schema'd result is
   Zod-valid; a `model`-less call is **rejected** (static lint) and a runtime
   `MissingModel` ends a run `failed`, not swallowed to `null`; **cost
   visibility** accrues (`spend > 0`); Stop aborts all children → `stopped`;
   edit-and-resume serves the journal prefix **by ordinal**; the tool returns
   `{runId}` and the completion event delivers the result.
2. **Codex path (gated ONLY on the codex-driver seam — no price table):** the
   SAME script on a Codex session, asserting identical behavior with the retry
   loop exercising the Codex emit path and cost visibility showing **tokens** —
   one executor, both backends, no Ultra branch. Budgets gone → no Open-Q4
   dependency; it lights up when the seam lands (Claude-first, exec pt 3).

## Deviations from the reference harness

| Reference | Telar Ultra | Why |
|---|---|---|
| Token budgets / spend ceilings | **no budget at all** — live cost visibility + runaway brakes (per-run cap, 1000-agent backstop, human Stop, agent stop) only | owner decision: "we should not have a budget for these." Bounded discovery is loop-until-dry. |
| `agent()` inherits the session model | `opts.model` **required per call** (validation rejects otherwise) | owner decision: the script must state the model explicitly; the UI shows `model·effort` per agent. |
| Children may pause for interactive approval | children **non-interactive, fixed posture**; an approval-needing action **fails the `agent()` call** (fail-closed) | the child posture is the real security boundary; enforcement is vendor-shipped (SDK `canUseTool`/`allowedTools`; Codex `workspace-write` + `approval:never`), never an Ultra-invented knob. |
| Concurrency `min(16, cores-2)` | per-run cap **3** under the shared engine gate **4** (engine.ts:89) | per-run fairness across parallel runs; raising the process ceiling is an engine change for everyone (§1), not an Ultra knob. |
| Blocking harness call | **non-blocking** — returns `{runId}`; several runs per session; completion is an event | owner decision: "multiple ultras can run in parallel"; Ultra is a side-quest tool, not a turn-blocker. |
| Time/random "banned by convention" | banned **mechanically** (stubs throw in the `vm` context) | resume determinism by construction, not documentation. |
| Harness may run out-of-process/persistent | in-process, dies on restart → `stopped`; journal-resume recovers | local-first single-process reality; honest, no invented supervisor. |
| Store unspecified | new `~/.telar/ultra/`, **ordinal-keyed** journal/transcripts | invisible to loom listing/reaper — Ultra is not a loom. |
| Result emit provider-native | executor-side **validate-and-retry (K=2)** over the driver's emit | one loop both backends; no silent degradation where a provider lacks native forcing. |
| Script isolation invented | the **script** runs in `node:vm`, a **non-security** capability/determinism device a determined script can escape (prototype-chain walk to host `process`) | Node documents `vm` as not a security mechanism; no-new-deps rules out a real isolate, and the first-party author holds no authority to fence. `worker_threads` is the future hardening if untrusted scripts arrive. |

## Open questions (owner verdict)

1. **`schema`-less `agent()`** returning raw final text: keep it (reference
   parity, cheaper for read-only fan-out) or always force a `schema`? Both allowed
   by the reference.
2. **Completion delivery mechanism.** When a detached run reaches terminal, how
   does its outcome reach the main agent — a synthetic tool-result that wakes a
   fresh assistant turn, a system event surfaced on the user's next turn, or pure
   `ultra_status` polling? The non-blocking contract is fixed; the wake mechanism
   is the open fork.
3. **Codex ship gating.** Advertise Ultra as Claude-only until the codex-driver
   seam lands (honest, no half-Codex), or hold release until both backends prove?
   I recommend Claude-first — budgets gone, Codex needs only the seam.
