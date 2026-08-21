# Loom — build spec

> Implementation spec for `orchestrator.md`. This is the buildable version: every
> open question in that doc is **answered here**, because implementation cannot
> proceed on a question mark. Where the answer is a judgment call it is marked
> **[decided]** with the reasoning, so it can be argued with later.

## 0. Vocabulary

- **Orchestrator** — the perpetual, per-project agent that decides what to work
  on. Fresh instance every tick. Never edits code.
- **Loom** — one dispatched unit of work. Owns a worktree, runs a Telar session
  against one item, is gated by the harness, ends as a published PR.
- **Program** — the artifact. A markdown file in the project repo describing how
  this project declares work, what its gates are, and what to do when stuck.
- **Tick** — one orchestrator invocation.
- **Sentinel** — deterministic, LLM-free probe that answers "did anything
  change?" for the cost of one command.
- **Ledger** — append-only JSONL of what happened, machine-local.

---

## 1. The four command slots

The anti-abstraction. There is no `WorkSource` interface, no GitHub adapter, no
provider registry. A project declares **four shell commands**. GitHub is a
*preset* (a block of default text), never an *integration* (code).

| Slot | Contract | Example |
| --- | --- | --- |
| `probe` | **Hard contract.** Prints one line to stdout. That line is the fingerprint. Must be cheap and LLM-free. Non-zero exit = probe failed, treat as "unknown, do not wake". | `gh issue list -s open -L 200 --json number,updatedAt -q 'map(.number\|tostring + .updatedAt) \| sort \| join(",")' \| shasum` |
| `list` | Free text. Prints the candidate work items, however the project wants. The agent reads it. | `gh issue list --state open --limit 200 --json number,title,labels,milestone,updatedAt` |
| `detail` | Free text. Receives `$ITEM`. Prints everything needed to understand one item. | `gh issue view $ITEM --comments` |
| `publish` | Free text. Receives `$BRANCH`, `$TITLE`, `$BODY`, `$BASE`. Makes the work visible. Exit 0 = published; stdout's first URL is recorded. | `gh pr create --draft --base $BASE --head $BRANCH --title "$TITLE" --body "$BODY"` |

A project with no tracker sets `list` to `cat inbox.md`, `probe` to
`shasum inbox.md`, `publish` to `git push -u origin $BRANCH`. Nothing in the
engine knows what GitHub is.

**Substitution** is literal `$NAME` replacement into the command string, executed
via the shell. This is an execution surface authored by the user, same trust
level as a `package.json` script. **[decided]** — refusing shell would mean
building the abstraction §7 forbids.

---

## 2. The Program artifact

Lives in the **project repo** at `.telar/loom.md`. Markdown, human-first, read at
2am. Machine-readable parts are fenced code blocks under known headings; anything
else in the file is prose passed verbatim to the agent as `notes`.

```markdown
# Loom program — <project>

## Work source
```probe
<command>
```
```list
<command>
```
```detail
<command>          # $ITEM
```
```publish
<command>          # $BRANCH $TITLE $BODY $BASE
```

## Gates
```gate
bun run ci
0 pass
1 fail
2 unknown
```
On unknown: hold          # or: publish

## Work
base: main
branch: t3code/<slug>
concurrency: 4
setup: bun install        # optional, run once per fresh worktree

## Never touch
.env*
supabase/.env.keys

## When stuck
1 re-read the item and everything said since it was dispatched   [on]
2 run the gate again — it may be flaky                           [on]
3 narrow the scope and retry once                                [on]
4 try a different approach from scratch                          [off]
5 split it and run the piece that is clear                       [off]

## Ask me only when
- the item needs a product decision
- credentials or access I do not have
- the gate has failed at every rung above

## When to look
every 300s, backing off to 3600s after 6 quiet checks

## Assumed — confirm
- ...
```

Parsing rules:
- Unknown headings → appended to `notes`, never an error. A Program with a typo
  degrades, it does not fail.
- A missing `probe` disables the sentinel; the orchestrator falls back to pure
  heartbeat (§3.8 of the design: every event source is additive).
- The parser round-trips: `parseProgram(render(p)) === p` for everything it
  understands. Editing via UI rewrites only the block that changed.

---

## 3. Gates are tri-state

`GateOutcome = 'pass' | 'fail' | 'unknown'`. Never a boolean, nowhere.

The exit-code table is **per project**, declared in the Program. An undeclared
exit code maps to `unknown`, never to `fail` — assuming POSIX convention is
exactly the imposition this design exists to avoid.

`onUnknown: 'hold' | 'publish'` is policy the Program must answer. Default `hold`
**[decided]** — the failure mode of holding is a PR you did not get; the failure
mode of publishing is red CI and burnt Actions minutes, which is worse and noisy.

**The worker never runs the gate.** The session's job ends at "changes are in the
worktree". The harness runs gates in the worktree afterward. The worker cannot
skip what it never held.

---

## 4. Loom lifecycle

```
queued → working → gating → publishing → published
                      ↓          ↓
                   stuck ──── (ladder) ──→ parked | asking
```

| State | Meaning | Who moves it |
| --- | --- | --- |
| `queued` | dispatch decided, worktree not yet made | supervisor |
| `working` | session running in the worktree | session exit |
| `gating` | harness running the Program's gates | gate runner |
| `publishing` | running the `publish` command | publish runner |
| `published` | terminal, happy. `publishedUrl` set. | — |
| `stuck` | gate failed / worker exited without changes | ladder |
| `parked` | ladder exhausted, written reason, no more attempts | — |
| `asking` | escalated past the ladder, waiting on the human | human |
| `cancelled` | killed by the human | human |

Terminal states: `published`, `parked`, `cancelled`.

### Done-detection across ticks

The orchestrator dies each tick, so in-flight state is **re-derived**, never
remembered. A killed worker must be distinguishable from a running one:

- Each loom records `sessionId` and the OS `pid` of the worker.
- On every tick, `working` looms are reconciled: session still live? → still
  working. Session gone, worktree has commits → `gating`. Session gone, no
  commits → `stuck` (rung 1).

**[decided]** No heartbeat file. The session store already knows whether a
session is alive; adding a second source of truth invites them to disagree.

---

## 5. The escalation ladder

The user is asleep. Escalations go to the **orchestrator first**, and only reach
the human when the ladder is exhausted or the Program's "ask me only when" says
so. This is the centrepiece, not a footnote.

```ts
type Rung = { n: number; label: string; enabled: boolean; absorbed: number }
```

Rungs are authored by the human in the Program, in prose. The engine does not
interpret rung text — it hands the rung's label to the orchestrator agent, which
decides how to enact it. What the engine enforces is:

- rungs are tried **in order**, cheapest first;
- a rung is tried **once** per loom;
- `absorbed` increments when a rung resolves a stuck loom — this is the number
  that tells the human whether their ladder is any good;
- past the last enabled rung the loom moves to `asking` and appears in
  **Needs you**.

`attempts` is capped at the number of enabled rungs. There is no "fourth try".

---

## 6. Sentinel and the tick loop

**Idle must be free.** The supervisor never invokes an agent to discover there is
nothing to do.

```
loop:
  if any loom in a non-terminal machine state → advance it (no agent needed)
  else:
    run probe → hash stdout
    unchanged and nothing in flight → sleep(interval, backing off) ; continue
    changed → tick (agent)
```

Backoff: `interval` doubles after each quiet probe up to `backoffMax`, resets to
`interval` on any change. Defaults 300s → 3600s. **[decided]**

Wake sources, all additive:
- **Heartbeat** — always available, works with no credentials, no git.
- **Probe diff** — one command per interval.
- **Process exit** — a worker finishing wakes the loop immediately, for free.
- **Human action in the UI** — dispatch/cancel/reply wakes the loop immediately.

No system crontabs. No webhooks. One supervisor process inside the engine, one
file describing what it watches, one thing to kill.

---

## 7. What a tick actually does

Input assembled by machinery (bounded by construction):

1. the Program (whole file, it is small)
2. `probe` output and whether it changed
3. `list` output
4. current looms (id, item, state, attempts, last gate, parked reason)
5. **triage cache** entries whose `updatedAt` matches `list` — i.e. only items
   whose classification is stale get re-read
6. last N ledger entries (N = 40) **[decided]**

Output — a single structured object:

```ts
{
  triage: Array<{ item, classification, reason, ask }>   // the durable output
  dispatch: Array<{ item, title, branchSlug, brief }>    // capped by concurrency
  park: Array<{ loomId, reason }>
  ask: Array<{ loomId?, item?, question, why }>
  note: string                                           // one line for the ledger
}
```

`classification ∈ dispatchable | needs-decision | needs-credentials | needs-split
| never | done`.

### Triage is a first-class output

Per §3.10 of the design: a tick that dispatches nothing but classifies six new
items correctly was a good tick. The triage cache is keyed by `item` and
invalidated by the `updatedAt` string the `list` command reports. This is what
makes "read the whole comment thread" affordable — it happens **once per item
per change**, not once per tick.

The cache also stores `ask` — the distilled current intent, since the newest
comment may retract the body. That distillation is the expensive part and is
exactly what must not be recomputed every five minutes.

---

## 8. Dispatch

1. Reconcile: refuse to dispatch an item that already has a non-terminal loom.
2. Refuse to exceed `concurrency`.
3. Create a worktree using the engine's existing worktree machinery, branch
   `<branchPrefix><slug>` off `<base>`.
4. Run the Program's `setup` command if present (`bun install`).
5. Start a Telar session in that worktree with a prompt assembled from: the
   Program's notes, the `detail` output for the item, the boundaries, and an
   explicit **"do not run the gate, do not commit to base, do not open a PR"**.
6. Record `pid` + `sessionId`. Return. The supervisor advances it on exit.

### Worktree divergence **[decided]**

Rebase onto the freshly fetched base **before gating**, not at dispatch. Six
worktrees cut Monday and gated Tuesday each rebase against Tuesday's base, so the
gate result describes the world the PR will actually land in. If the rebase
conflicts, the loom goes `stuck` at rung 1 with the conflict as its reason —
which is correct, because a conflicting branch genuinely needs a decision.

---

## 9. Persistence **[decided]**

| Thing | Where | Why |
| --- | --- | --- |
| Program | project repo, `.telar/loom.md` | portable, diffable, reviewable, travels with the project |
| Loom records | `<engineRoot>/looms/<projectId>/<loomId>.json` | machine-local; a loom is a fact about *this machine's* worktrees |
| Ledger | `<engineRoot>/looms/<projectId>/ledger.jsonl` | append-only; commit noise every tick would be intolerable in-repo |
| Triage cache | `<engineRoot>/looms/<projectId>/triage.json` | derived, rebuildable, machine-local |
| Fingerprint | `<engineRoot>/looms/<projectId>/sentinel.json` | derived |

All writes atomic. The ledger appends with `O_APPEND` and one JSON object per
line, so a torn write costs one line, not the file.

---

## 10. Overnight risk posture **[decided]**

The system **opens PRs and never merges**. It never pushes to base. It never
force-pushes. `neverTouch` globs are enforced by the harness after the worker
exits: a diff touching a forbidden path parks the loom rather than publishing it.
The failure mode of the alternative is silent and compounding.

---

## 11. UI

Two surfaces, both inside Telar. **The session chat and composer are stock Telar
— unchanged.** The orchestrator is a Telar session; what is new is the data
around it.

### The deck — `/looms`

Session-sized rows, not GitHub cards. Grouped by what the human must do:

- **Needs you** — looms in `asking`, plus Program `assumed` items awaiting
  confirmation. Each row says what was already tried (which rungs, and that they
  were absorbed or not) so the human is answering a question, not doing triage.
- **Ready to review** — `published`, with the gate chip and the URL.
- **Working** — `queued`/`working`/`gating`/`publishing`, nested under their
  project, with the live session row.
- **Seen and not taken** — the triage cache, grouped by classification. This is
  §3.10 made visible and it is the most valuable pane on the page.

Gate chip is tri-state and never green-by-default:
`pass` → success token, `fail` → destructive, `unknown` → warning + "could not
verify". `unknown` must never look like a pass.

### The orchestrator — `/looms/[projectId]`

Three panes:
- **left rail (≈210px)** — live looms as session-style rows, click to open.
- **centre** — the stock Telar session cockpit for the orchestrator session.
  Unchanged. Not reimplemented.
- **right** — the existing right-panel tab strip with one new tab: **Program**.
  It renders the artifact as editable blocks (Where work comes from · How to read
  one · What must pass · When stuck · Ask me only when · When to look), each
  block writing back to `.telar/loom.md`. Pending `assumed` items show as a badge
  on the tab.

The Program tab is the thesis: *the orchestrator helps you program the
automation, it does not merely run it.*

---

## 12. Setup is a conversation

`POST /looms/setup` starts a Telar session with a setup prompt: look first, ask
only what cannot be determined, emit a Program draft, then a **dry run** — what
it would dispatch right now, and, crucially, what it noticed that the human did
not say. The dry run is the trust surface; it costs almost nothing and happens
before anything is dispatched.

Setup does not refactor the repo. Its only output is `.telar/loom.md` plus a
proposal the human can accept.

---

## 13. Relationship to looms v1

v1 (`packages/core/src/looms.ts`, `weave.ts`, `tick.ts`, the loom paths of
`executor.ts`) is **left in place and not extended**. The new system lives in its
own modules with its own names and shares no types. Ripping v1 out is a separate
change with its own blast radius; doing both at once means neither can be
reviewed. **[decided]**

---

## 14. Where the code goes **[decided]**

Recon finding that reshaped this: **`packages/core` is not reachable from the
live product.** `apps/engine` does not depend on `@telar/core`, and
`apps/web/lib/engine/source-boundary.test.ts:27` bans the import outright. Core
is the frozen looms-v1 world. Building there would produce code the product
cannot call.

The live stack is `apps/engine` (HTTP daemon) → `packages/engine-client` (zod
protocol + typed client) → `apps/web` (thin Next adapters + client components).
So:

| Layer | Path | Modelled on |
| --- | --- | --- |
| Wire types | `packages/engine-client/src/protocol/loom.ts` | `protocol/entities.ts:125` |
| Events | `packages/engine-client/src/protocol/events.ts` | its `event()` helper `:46` |
| Pure logic | `apps/engine/src/loom/{program,gates,machine,ladder,sentinel,triage,decide,ledger-format}.ts` | — |
| Store | `apps/engine/src/loom/store.ts` | `apps/engine/src/spool/store.ts` |
| Runtime | `apps/engine/src/loom/{supervisor,dispatch,gate,run}.ts` | `spool/night.ts` + `spool/work.ts` |
| EngineStore wiring | `apps/engine/src/state.ts` lazy getter + detach idiom `:2112-2126` | spool's |
| Routes | `apps/engine/src/daemon.ts`, if-arms after the bearer gate `:450` | `daemon.ts:656` |
| Client | `packages/engine-client/src/index.ts` class `EngineClient` | `:496` |
| Web adapters | `apps/web/app/api/looms/**/route.ts` | `app/api/spool/areas/route.ts` |
| Web browser API | `apps/web/lib/engine/client.ts` `createEngineApi` `:86` | — |
| Web UI | `apps/web/app/looms/**`, `apps/web/components/loom/**` | `components/session-cockpit.tsx` |

Constraints inherited from the codebase, not negotiable:

- **All persisted writes go through `atomicWrite`** (`apps/engine/src/atomic.ts`).
  Invariant INV-11d scans for this. Journals are the O_APPEND exception.
- **Validation lives in the store, not the route**, so in-process callers hit the
  same wall as HTTP ones.
- **Readers are tolerant per row.** One unreadable loom must not take out the
  list — `spool/store.ts:290-300` explains why `.array().safeParse` is wrong.
- **Id traversal guard** on every path-composing id: regex *plus* a containment
  re-check.
- **Background promises must be detached with `.catch(() => undefined)`** — an
  unhandled rejection on a background promise takes the daemon down in Bun.
- **The one recurring-timer precedent** is `daemon.ts:343`: injected via
  `EngineDaemonOptions`, `.unref()`ed, cleared in `close()`. The supervisor's
  interval must follow it exactly, or tests hang.
- **Tests never shell out to a real CLI** and never spend rate limit. Everything
  expensive is injected through `EngineDaemonOptions` (see `daemon.ts:51-85`).
- The gate for *this* repo is `bun run verify` = `typecheck && lint && test`.
  `lint` covers `apps/web` only.

---

## 15. The seam contract

Four layers get built in parallel, so the interfaces between them are fixed here
rather than negotiated. Anything not in this section is the implementing layer's
own business.

### 15.1 `EngineStore` methods (`apps/engine/src/state.ts`)

Delegating to `apps/engine/src/loom/*`. Validation lives here, not in the route,
so an in-process caller hits the same wall as an HTTP one.

```ts
loomOverview(): LoomOverview                       // ONE read for the whole deck
loomProgram(projectId): LoomProgramDoc             // { path, exists, markdown, program|null, warnings }
saveLoomProgram(projectId, markdown): LoomProgramDoc
looms(projectId?): { looms: Loom[]; unreadable: LoomUnreadable[] }
loom(loomId): Loom
loomLedger(projectId, limit?): { entries: LedgerEntry[] }
loomTriage(projectId): { entries: TriageEntry[] }
loomWork(): { runs: LoomRun[] }                    // in-memory, in-flight ticks
startLoomWatch(projectId): { watch: LoomWatch }
stopLoomWatch(projectId): { watch: LoomWatch }
tickLoom(projectId, input?): { run: LoomRun }      // 202, detached
dryRunLoom(projectId): { run: LoomRun }            // 202, detached; result on the run
dispatchLoom(projectId, input): { loom: Loom }     // { item, title?, brief? }
cancelLoom(loomId): { loom: Loom }
answerLoom(loomId, answer): { loom: Loom }
suggestLoomProgram(projectId): { markdown, findings: string[] }
```

Error vocabulary follows the spool's translators exactly: a store `Error` becomes
`EngineStateError("invalid_request", message)` **with the sentence preserved**; a
`null` lookup becomes `EngineStateError("not_found", …)`; `EACCES` rethrows.

### 15.2 Routes (`/v2/looms/**`, inline arms in `daemon.ts` after the bearer gate)

Literal paths must be matched **before** the `/:loomId` regex.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/v2/looms` | — | `LoomOverview` (bare, like `GET /v2/spool`) |
| GET | `/v2/looms/program` | `?project=` | `LoomProgramDoc` |
| PUT | `/v2/looms/program` | `{projectId, markdown}` | `LoomProgramDoc` |
| POST | `/v2/looms/program/suggest` | `{projectId}` | `{markdown, findings}` |
| GET | `/v2/looms/ledger` | `?project=&limit=` | `{entries}` |
| GET | `/v2/looms/triage` | `?project=` | `{entries}` |
| GET | `/v2/looms/work` | — | `{runs}` |
| POST | `/v2/looms/watch` | `{projectId, running}` | `{watch}` |
| POST | `/v2/looms/tick` | `{projectId}` | **202** `{run}` |
| POST | `/v2/looms/dry-run` | `{projectId}` | **202** `{run}` |
| POST | `/v2/looms/dispatch` | `{projectId, item, title?, brief?}` | `{loom}` |
| GET | `/v2/looms/:loomId` | — | `{loom}` |
| POST | `/v2/looms/:loomId/cancel` | — | `{loom}` |
| POST | `/v2/looms/:loomId/answer` | `{answer}` | `{loom}` |

### 15.3 `EngineClient` methods — one-liners, same names as §15.1

`looms()`, `loom(id)`, `loomProgram(projectId)`, `saveLoomProgram(projectId, markdown)`,
`suggestLoomProgram(projectId)`, `loomLedger(projectId, limit?)`, `loomTriage(projectId)`,
`loomWork()`, `setLoomWatch(projectId, running)`, `tickLoom(projectId)`,
`dryRunLoom(projectId)`, `dispatchLoom(projectId, input)`, `cancelLoom(id)`,
`answerLoom(id, answer)`.

### 15.4 Web adapters — `apps/web/app/api/looms/**`

One file per route, the 15-line `engineClient()` / `engineErrorResponse` shape.
Paths mirror §15.2 with `/api` for `/v2`.

### 15.5 Web components live in `apps/web/components/loom/` — **singular**

`@/components/looms` (plural) is on the banned-import list in
`apps/web/lib/engine/source-boundary.test.ts:35`, because it names the frozen
app's directory. Singular `loom/` is clear. Do not amend the ban list.

### 15.6 Additional wire types

```ts
LoomProgramDoc  = { projectId, path, exists, markdown, program: LoomProgram | null, warnings: string[] }
LoomWatch       = { projectId, running, intervalSec, quietChecks, lastProbeAt?, lastChangeAt?, nextProbeAt?, lastError? }
LoomRunKind     = 'tick' | 'dry-run'
LoomRun         = { id, projectId, kind, state: 'running'|'done'|'failed'|'cancelled',
                    startedAt, settledAt?, step?, note?, decision?: TickDecision,
                    dispatched: string[], error? }
LoomUnreadable  = { file, reason }
LoomOverview    = { projects: LoomProjectSummary[], looms: Loom[], triage: TriageEntry[],
                    runs: LoomRun[], unreadable: LoomUnreadable[] }
LoomProjectSummary = { projectId, name, root, hasProgram, programPath,
                       watch: LoomWatch, counts: Record<LoomState, number>,
                       assumed: string[], warnings: string[] }
```

`LoomOverview` is the **one-call snapshot** for the deck. Two surfaces fetched on
separate cadences would disagree with no way to tell which is stale; the spool
learned that the hard way and the rule is written into `state.ts:1101-1103`.
