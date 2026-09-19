# Agent lab — evidence for #528

Two variants of Telar's built-in Agent on one harness, one fixture, one model and
one set of scenarios. **A. LangGraph.js** is below. **B. Deep Agents JS** and the
win/loss table belong to the session running part B; the headings are left in
place and empty.

Nothing here is imported by shipped code. `prototypes/agent-lab` is its own
package and is deliberately **not** in the root `workspaces`. The root has no
`tsconfig.json` — `bun run typecheck` at the root runs four package tsconfigs
(`packages/engine-client`, `packages/env`, `apps/engine`, `apps/web`) and none of
them reaches `prototypes/`, so this lab cannot break it. The lab typechecks
itself with `bun run typecheck` inside `prototypes/agent-lab`.

Every claim below is either **measured** (a number this repository produces) or
labelled **inferred**. Claims about part B are not made here at all.

---

## Versions

Installed and used for every number in this report.

| Package | Version |
| --- | --- |
| bun | 1.3.11 |
| `@langchain/langgraph` | 1.4.15 |
| `@langchain/core` | 1.2.11 |
| `@langchain/langgraph-checkpoint` | 1.1.5 |
| `@langchain/langgraph-checkpoint-sqlite` | 1.0.4 |
| `@langchain/openai` | 1.5.13 |
| `openai` (transitive) | 7.15.0 |
| `zod` | 4.4.3 (same version the engine uses) |
| `typescript` | 6.0.3 |

Model: OpenCode Go, `https://opencode.ai/zen/go/v1`, default model id
`kimi-k3` (`apps/engine/src/main-session/go.ts`). Headers on every live call:
`User-Agent: telar-agent-lab/0.1` and `x-opencode-session: <thread id>`. The key
comes from the engine's own resolver, imported rather than copied
(`apps/engine/src/main-session/credentials.ts`); it is never printed. On the
machine that produced these numbers the resolver reported *"using the OpenCode
CLI's own OpenCode Go key"* — rung 3.

### Footprint

Measured with `bun run footprint`, on a warm bun cache.

| | packages | node_modules | clean install |
| --- | --- | --- | --- |
| runtime only (`bun install --production`) | 62 | 81.3 MB | 0.80 s |
| with dev deps (typescript, @types/*) | 67 | 111.3 MB | 0.66 s |

Largest runtime contributors: `js-tiktoken` 22.4 MB, `openai` 17.8 MB,
`better-sqlite3` 12.3 MB (unusable under Bun — see below), `@langchain/core`
7.6 MB, `@langchain/langgraph-sdk` 5.0 MB, `zod` 4.6 MB, `@langchain/langgraph`
4.4 MB, `langsmith` 3.3 MB. Five direct dependencies pull 62 packages.

---

## Commands

From `prototypes/agent-lab`:

```
bun install
bun test                     # all 17 tests: harness, adapter, and the 7 scenarios
bun run typecheck
bun run scenarios            # every scenario in order, one verdict at the end
bun run scenario:1           # …through scenario:7, each runnable alone
bun run footprint
bun run src/tools/make-recordings.ts   # regenerates scenario 7's 80-step fixture
```

Live calls are off unless asked for:

```
TELAR_LIVE_SMOKE=1 bun run scenario:2    # one real OpenCode Go conversation
TELAR_LIVE_SMOKE=1 bun run scenario:7    # one real call with 40 turns of history
```

Everything else runs offline against a recorded model, with no key on the
machine. A live run writes what it actually received to `recordings/live/`
(gitignored); the fixtures the tests replay are in `recordings/` and are
**authored, not captured** — they exercise a path, and the two live smokes are
what prove the same shapes work against the real endpoint.

---

## A. LangGraph

### What the variant is, and why

`src/variants/langgraph.ts` is a **hand-built `StateGraph`**, not
`createReactAgent`. The installed package deprecates the prebuilt in its own
type declarations:

> `@deprecated` `CreateReactAgentParams` has been moved to the **langchain**
> package. Update your import to `import { CreateAgentParams } from "langchain";`
> — `node_modules/@langchain/langgraph/dist/prebuilt/react_agent_executor.d.ts`

LangChain's v1 migration guide says the same: the prebuilt is replaced by
`createAgent` in the `langchain` package. That leaves three readings of "the
LangGraph.js baseline", and the issue names `@langchain/langgraph` and
`@langchain/core`:

- `createReactAgent` — deprecated by the package itself. Not a baseline.
- `createAgent` from `langchain` — a **third package**, and an agent abstraction
  with its own middleware system. That is the same kind of thing Deep Agents is,
  so using it as A would compare two agent frameworks and never measure the
  substrate underneath both.
- A `StateGraph` over the two packages the issue names — non-deprecated, in
  scope, and what the framework gives you before anybody's agent opinions are
  added.

A is the third. **A real integration should still weigh `createAgent`** — it is
where LangChain's own effort is going, and a middleware system may buy things
this graph hand-rolls. That comparison is not in this lab and is not claimed
either way.

The graph is `model → tools → model` with two properties that are not decoration:

1. **Approvals are a first pass.** `interrupt()` propagates by throwing, so a
   node that ran one tool and *then* interrupted would lose that tool's state
   write and re-run it on resume. Every gated call is interrupted before any
   effect in the same node runs.
2. **Effects are ledgered in graph state**, so the record of an effect is
   checkpointed in the same write as the messages that produced it. The ledger
   is read *before* the approval check, so a deduplicated retry neither asks the
   person again nor reaches the wall.

Both approval styles the issue names are implemented. `approvalMode:
"interrupt"` (default) is the current JS API and is what the scenarios use;
`approvalMode: "interruptBefore"` compiles the static node-level gate. The
difference is evidence, not taste: **`interruptBefore` stops before the whole
tools node and carries no payload** about which call triggered it, so the
surface asking a person to approve would have to re-derive the call from the
last message itself. `interrupt()` hands over the tool name and arguments, and
scenario 3 reads them out of the checkpoint in a different process.

### Tools

The real walls, unchanged, over a fixture capability. 18 tools reach the model:

```
sessions_list sessions_create sessions_send sessions_read sessions_status
sessions_stop sessions_settle sessions_diff sessions_subscribe
sessions_unsubscribe sessions_subscriptions sessions_requests
sessions_resolve_request
notes_projects notes_list notes_read notes_write notes_delete
```

`sessionsTools(tool, capability)` and `notesTools(tool, capability)` take their
factory as an argument precisely so no SDK has to be imported beside them; the
adapter (`src/harness/adapter.ts`) answers that seam with LangChain's `tool()`.
**No file in `apps/engine` was edited for this lab.** A wall's MCP refusal comes
back as *text*, not a throw — these walls' refusals are sentences the model is
meant to read and act on.

**Measured:** the two copies of zod (the workspace's, which built the field
schemas; this package's, which wraps them in `z.object`) interoperate, and the
combined schema converts to the JSON Schema a model is shown.
`test/adapter.test.ts` asserts it rather than assuming it.

### Evidence table

Every row is the output of the same function `bun test` runs. Token counts from
the recorded model are **estimated at 4 characters per token** and are marked
`est`; the live rows are the provider's own `usage_metadata`.

| # | Scenario | Result | Model calls | Tool calls | Prompt tok | Completion tok | Thread storage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Own state, no Telar session | **PASS** | 2 | 1 | 308 est | 26 est | **SqliteSaver (durable)** + MemorySaver compared |
| 2 | Streaming + read tool (recorded) | **PASS** | 2 | 1 | 385 est | 51 est | MemorySaver |
| 2L | Streaming + read tool (**LIVE**) | **PASS** | 2 | 1 | **7 905** | **145** | MemorySaver |
| 3 | Approval interrupt survives restart | **PASS** | 1 parent + 1 child | 1 (child only) | 86 est | 36 est | **SqliteSaver (durable)** |
| 4 | Delegation round trip | **PASS** | 6 | 4 | 3 081 est | 166 est | MemorySaver |
| 5 | Cancellation (3 parts) | **PASS** | 6 | 3 | — | — | MemorySaver |
| 6 | No duplicate delegation on retry | **PASS** | 7 | 4 | 4 194 est | 192 est | MemorySaver |
| 7 | Growing context, 40 turns | **PASS** | 80 | 40 | 382 345 est total | 1 166 est | MemorySaver |
| 7L | One real call on 40 turns of history (**LIVE**) | **PASS** | 1 | 0 | **18 468** | — | — |

Live total for this report: **3 real calls** (two in scenario 2's conversation,
one in scenario 7).

Per-scenario detail worth having:

- **1 — own state.** `sessions_create` was called **0 times for the Agent
  itself**. A fresh process, given only the thread id and the sqlite path,
  resumed **4 messages** and answered from them. The same run against
  `MemorySaver` with a fresh saver on the same thread id found **0 messages**.
- **2 — streaming.** Recorded: 28 assistant text chunks after 1 tool call.
  Live: **2** text chunks — Go streams in large pieces, so "it streams" is true
  and "it streams word by word" is not. Assistant tokens are counted separately
  from the tool result, which `streamMode: "messages"` also carries.
- **3 — approval across a restart.** The parent parked the interrupt and made
  **0 sends**. A separate process read `sessions_send` *and its arguments*
  (`sessionId`, `intent: "task"`, the message) out of the checkpoint, approved,
  and sent exactly **1**.
- **4 — delegation.** One create, one send, one subscription, one wake, one
  report. The wake ran as a **second turn on the same thread** and saw the first
  turn's history.
- **5 — cancellation.** Three parts; see the finding below.
- **6 — no duplicate delegation.** The model asked for `sessions_send` **twice**;
  the wall was reached **once**; the fixture saw **1 send**, **1 create**,
  **1 worker run**; the person was asked to approve **once**.
- **7 — growing context.** 80 model calls, prompt **78 → 9 601 est** tokens,
  and the series **never fell**. The approval state from turn 3 — both the
  ledger key and the `sessions_send` tool message — was still on the thread at
  turn 40.

### Durable versus in-memory

**Measured.** `SqliteSaver` resumes a thread in a **process that has never seen
it**: scenarios 1 and 3 both spawn a real child (`Bun.spawn`, awaited, exit code
checked) rather than building a second object in the same heap. Messages, the
effect ledger and a **parked interrupt with its payload** all survive.
`MemorySaver` survives nothing across a saver instance, which is what a process
boundary is.

**The Bun blocker, and what it cost.** `@langchain/langgraph-checkpoint-sqlite`
does not load under Bun:

```
'better-sqlite3' is not yet supported in Bun.
Track the status in https://github.com/oven-sh/bun/issues/4290
```

`better-sqlite3` is its only dependency and is a native addon Bun cannot host.
`node:sqlite` is also absent in Bun 1.3.11. This is a real cost for a Bun-first
codebase and it is reported as one.

What A does about it: `src/harness/checkpointer.ts` runs the **published
`SqliteSaver` class, unmodified**, over a ~30-line `bun:sqlite` adapter
answering the five `better-sqlite3` methods it calls (`pragma`, `exec`,
`prepare` + the statement's `get`/`all`/`run`, and `transaction`), with
`undefined` mapped to `NULL` for the first checkpoint's parent id. The schema,
the SQL, the serde and the pending-sends migration under test are therefore the
shipped package's, not ours. *(Session B independently ported the saver's body
onto `bun:sqlite`; both approaches produce the same on-disk schema. The thin
adapter is preferred here for exactly one reason: a durability claim about a
reimplementation is a claim about our code.)*

**Inferred**, not measured: a real integration has three ways out — ship the
adapter, run the Agent's process on Node (where the official package works
untouched), or write a checkpointer against the engine's own store. The third
is the one that removes a dependency rather than adding a workaround; see the
integration sketch.

### Finding: a node is the unit of atomicity, not an effect

Scenario 5 cancels three times and only the first has the answer people assume.

| Cancel | Effect at the cut | After resume |
| --- | --- | --- |
| A — mid-stream, in the model node | nothing landed | resumed and finished, **1 send** |
| B — mid-tool, **before** the effect | **0 sends** | **1 send** |
| C — mid-tool, **after** the effect | **1 send**, node never committed | **2 sends** |

C is not a LangGraph bug and no graph framework can fix it: an HTTP call and a
local checkpoint write cannot be made atomic. What it means for Telar is
concrete. **Anything that lands must be idempotent on a key the CALLER owns and
can reuse** — and `sessions_send` currently mints its `runId` *inside the tool
wall*:

```ts
// apps/engine/src/sessions-tools/tools.ts — sessions_send
const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
```

That comment is right about what it defends against (a model-supplied id lets
two different messages share one) and it also means **the engine's own
idempotency is unreachable from a retry**: `submitTurn` is idempotent on
`runId`, but a retried tool call mints a new one, so the store never sees the
two calls as the same act. The in-state ledger in A closes this for a retry the
agent makes on one thread (scenario 6) and does **not** close it for a cancel
that lands the effect (scenario 5C) or for two processes racing.

**Recommendation (inferred):** derive the `runId` from the tool call — the
provider's own `tool_call_id`, or a hash of `(sessionId, intent, input)` — so a
replayed call replays at the store rather than queueing a second turn. That is a
change to the wall, it is small, and it makes every framework's retry safe
rather than only this one's.

### Finding: LangGraph manages no context at all

**Measured.** Across 40 turns the prompt grew monotonically and never fell.
There is no summariser, no window and no eviction anywhere in
`@langchain/langgraph`: `MessagesAnnotation` appends, the checkpointer stores
what it is given, and the prompt is whatever the graph hands the model. The
curve is linear until the provider refuses.

That is not a defect — the package is a runtime, not a context manager — but it
is the thing B claims to do differently, so it is the number that matters in the
comparison. It is also **not a gap Telar currently has**: `#527`'s `telar`
driver already trims, in `apps/engine/src/main-session/history.ts` — a
120 000-character budget, newest-first, system prompt and current turn never
dropped, and a tool call and its result kept as one indivisible block so no
orphan `tool` message can 400 the API. **Adopting LangGraph means keeping that
code, not retiring it**, unless B's summarisation is measurably better.

### Finding: the tool wall is most of the prompt

**Measured, live.** Scenario 2's first live call carried a system prompt and one
short question — and cost **3 829 prompt tokens**. Scenario 7's live call
carried 162 messages of real history and cost **18 468**. The floor is the 18
tool schemas: roughly **3.6–3.8 k tokens on every single call**, before anybody
says anything.

Two consequences, both **inferred**:

- A per-call cost that size argues for narrowing what the Agent is shown per
  turn (the read wall always; the effectful tools only when the conversation is
  about delegating), not for a longer system prompt.
- The 4-chars-per-token estimate the recorded model uses is a **lower bound**:
  it said 8 084 where the provider said 18 468 for the same 162 messages, since
  it counts neither the tool schemas nor per-message overhead. Every `est`
  number in this report understates real cost by roughly 2×, and no comparison
  between A and B should be made across the est/live boundary.

### What A does not have

Measured by absence in the installed package and in this variant:

- No planning or todo state. (A `StateGraph` will hold one; nothing provides it.)
- No summarisation or offload of any kind.
- No skills.
- No subagent concept. **This may be a win rather than a gap for Telar**
  (inferred): Telar's delegation is already peer sessions plus subscriptions,
  with no parent/child link by design, and a framework that supplies its own
  subagent tree would sit beside that model rather than on top of it.
- No virtual filesystem, and no assumption that the agent has a cwd — which
  matches the built-in Agent exactly.

---

## B. Deep Agents JS

*For session B.*

---

## Win / loss, A versus B

*For session B.*

---

## Recommendation

*For session B, from both halves. A's side of the input is the four findings
above: durable threads work and cost a Bun workaround; approvals survive a
restart with their payload; context management is absent and Telar already has
its own; and the retry hole is in Telar's wall rather than in either framework.*

---

## Integration sketch — the built-in Agent

What #528 asks for: an Agent entry at the **top of the sidebar** that exists
automatically when the experimental feature is on. No picker, no create step, no
project, no cwd, its own persisted history, identity and lifecycle. Telar
sessions are resources it operates on, not its backing identity.

Everything in this section is **inferred** from what the lab measured plus the
shipped code it reads. None of it is implemented.

### Data — where the thread lives

The lab's thread is a LangGraph checkpoint keyed by `thread_id`. Three options,
in the order I would weigh them:

1. **A checkpointer over the engine's own store.** `BaseCheckpointSaver` is four
   methods (`getTuple`, `list`, `put`, `putWrites`) plus `deleteThread`. Writing
   one against the engine's document directory removes `better-sqlite3`,
   `bun:sqlite` and the adapter in one move, and puts the Agent's history where
   every other thing the engine persists already is — backed up together,
   deleted together, and visible to the same tooling. **Cost:** the checkpoint
   blob is LangGraph's own format, so the transcript a person reads would still
   have to be written as journal rows beside it, exactly as `#527`'s driver does
   today.
2. **One sqlite file beside the engine's documents**, via the adapter in this
   lab. Smallest diff, proven here, and one native-ish dependency Bun does not
   love.
3. **Node for the Agent's process only.** The official package works untouched;
   the engine gains a second runtime. Hard to justify for one dependency.

Whichever is chosen: the Agent's conversation must **also** exist as engine
events, because the transcript is what the cockpit and iOS draw and
`history.ts`'s premise — *the transcript is the truth* — is worth keeping.

### Lifecycle — enable, disable, reset

The Agent has **no session**, so `MainSession.sessionId` has nothing to point
at. `main-session.json` (`{ enabled, sessionId?, generation?, model? }`) reduces
to `{ enabled, model?, threadId }`:

- **enable** — mint a thread id if there is none; the entry appears. Nothing is
  created in any project.
- **disable** — the entry disappears; the thread is kept, so re-enabling returns
  to the same conversation. This is exactly the rule `sessionId` already
  encodes ("`sessionId` outlives `enabled`, deliberately"), applied to a thread.
- **reset** — a new thread id. The old checkpoint may be dropped or kept; the
  transcript should be kept, because a person who resets a conversation has not
  asked to lose it.
- `generation` **survives the move, and is still needed.** It exists for one
  race: a turn claimed while Main was on can still call `sessions_subscribe`
  after the switch goes off. A built-in Agent has the same race — a turn in
  flight when the feature is switched off — so the counter and the refusal in
  `sessions_subscribe` keep earning their place.

### Permissions

Unchanged, and that is the point. `#527`'s driver routes every tool call through
`onRequest` — the worker's `askEngine` — so the runtime mode decides, an
approval parks for a human, and a decline reaches the model as a readable
result. A LangGraph integration must route `interrupt()` into that same path
rather than inventing a second approval surface: **one gate, two callers**. The
lab's `ApprovalRequest` payload (tool, args, call id, reason) is a strict subset
of what `EngineRequest`'s `tool_call` detail already carries, so the mapping is
mechanical.

### UI

- **Top-of-sidebar entry**, always present when the feature is on, with no
  project group and no branch.
- **Reuse the transcript.** If the Agent's turns are written as ordinary engine
  events, every surface that draws a session draws the Agent with no new
  renderer — which is what `#527` already gets and what would be thrown away by
  storing the conversation only as checkpoints.
- **iOS** follows for free under the same condition, and only under it: the
  phone reads sessions and events over the engine's routes. A checkpoint blob is
  not something the phone can render.

### The `telar` driver

`#527`'s driver already does what a framework would do: builds the conversation,
calls the model, streams journal rows, dispatches tools, loops to
`MAX_ROUNDS = 12`. Adopting LangGraph would replace its **loop and its history
assembly** while keeping its **wire format knowledge, its gate wiring and its
trimming**. It is not an obvious trade, and the honest framing for the
recommendation is: what LangGraph adds over that driver is durable interrupts
across a restart and a checkpointed state you did not have to design. What it
costs is 62 packages, a Bun workaround, and a second place the conversation
lives.

---

## Migration plan — preserving #523 / #527 users

**Inferred.** Everything here is a plan, not a measurement.

The population is small and known: users who switched on the experimental Main
session and designated a conversation. Their state is one
`main-session.json` per machine plus an ordinary session that happens to be
designated.

1. **The designated session becomes an ordinary session, and nothing is
   moved.** It already is one — `MainSession` "designates, it does not create a
   kind". Dropping the designation leaves a normal conversation with its whole
   transcript, in its project, in the rail. **No history is migrated, because
   no history changes hands.** This is the whole reason the #523 design is easy
   to walk back.
2. **`main-session.json` is reused, not retired.** Keep the file and the route;
   change the shape to `{ enabled, model?, threadId }` and treat a document that
   still carries `sessionId` as *"this machine had a designated Main"*. On first
   read after the upgrade: keep `enabled` and `model` as they are, mint
   `threadId`, and leave `sessionId` in place unread so a downgrade still finds
   its designation. `generation` stays for the race above.
3. **Tell the person once, in the conversation they already have.** A note
   written into the previously-designated session — *"Main is now the Agent at
   the top of the sidebar; this conversation is ordinary again and nothing here
   was lost"* — costs nothing and lands where they will look. The new Agent
   starts empty; **do not** import the old transcript into it. It was a
   different identity with a different tool wall, and a conversation that claims
   to remember something it never did is worse than an empty one.
4. **The `telar` driver stays, in one of two roles.** Either it remains the
   Agent's runtime (and LangGraph is not adopted), or it survives as the
   provider driver for the sessions that still use it, with its history trimming
   lifted out for the Agent's own use. What it must not become is dead code that
   still appears in `ProviderDriverKind` — a driver a user can pick and nothing
   runs is worse than one that was removed.
5. **Order.** Ship the Agent behind its own flag while the designation still
   works; let both exist for one nightly; remove the designation path only once
   the Agent's transcript, approvals and iOS rendering are all confirmed on a
   real machine.

---

## Honest limits of this evidence

- The offline model is **scripted**, not captured. It proves the paths, not that
  a real model chooses them. Only the three live calls speak to real behaviour.
- The fixture engine is **in-process**, so "the parent sent nothing and the child
  sent once" is measured on two separate counters (scenario 3). The real engine
  outlives both processes and would see one send across them.
- Token estimates understate real cost by roughly 2× (measured, above). Do not
  compare an `est` number with a live one.
- No read scenario hit the real engine's read routes with the token from
  `engine.json`. The issue permits one; it was not needed to answer any question
  here, and it is the cheapest thing to add if the recommendation turns on it.
- Nothing here measures part B. Every A-versus-B sentence in this document is
  either absent or explicitly marked inferred.
