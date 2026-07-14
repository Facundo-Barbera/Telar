# Codex engine driver — one engine, two execution backends

> Doctrine-bound (`docs/PRINCIPLES.md`). This is a design plan, not an as-built.
> Scope: make `agent()` (packages/core/src/engine.ts) run a turn on a Codex
> account as it does on a Claude account, with no second engine and no runtime
> switch.

## PROBLEM

Looms are Claude-only. `agent()` is hardcoded to the Anthropic Agent SDK
(`query()` from `@anthropic-ai/claude-agent-sdk`, engine.ts:4,160). Every leaf
— builder, critic, scoping, the Verifier — flows through it, so **no loom can
build or verify on a Codex account**, even though:

- the account **provider is already a FACT** — `AccountProfile.provider`
  (schemas.ts:6,25), seeded from `~/.codex` (accounts.ts:32-34), persisted in
  the registry;
- `accountEnv()` (engine.ts:107-131) **already dispatches env by provider** via
  `providerOf()` — `CODEX_HOME` vs `CLAUDE_CONFIG_DIR`, `OPENAI_API_KEY` vs the
  Claude token — with zero engine-behavior branching;
- the web **chat route already drives Codex end to end** through
  `runCodexTurn()` (apps/web/lib/codex-app-server.ts), normalizing the
  `codex app-server` JSON-RPC stream into a small event vocabulary that already
  parallels the engine's `EngineEvent`.

So the wire protocol, auth, sandbox, approvals, and subagent-spawn mapping are
solved for chat. What's missing is a driver seam inside `agent()` so the same
work the SDK does — structured result, capability wall, autonomy, transcript,
resume, abort — is expressed against Codex too.

## DESIGN — a driver selected by the provider fact

`agent()` keeps its entire signature and contract. Its body splits behind one
lookup, the twin of `accountEnv`:

```ts
const driver = driverFor(opts.account?.provider);  // fact lookup, like providerOf()
return driver.run(promptText, opts);               // returns z.infer<schema> | null
```

`driverFor` is a table keyed by `ProviderId`, exactly like `PROVIDERS` in
providers.ts. **Why this passes the doctrine test (§1, and the "what this
forbids" list):** the selector is not a switch on *how the engine behaves* — it
is *what the account IS*. A Codex account can only be driven by the Codex CLI;
a Claude account only by the Claude SDK. There is no "default path" and no
"alternative path" a project opts into: given the account fact, exactly one
driver is possible, the same way `providerOf` already forces exactly one
config-dir env. No `telar.yaml` key selects it (that would be an engine switch,
forbidden by §2); the fact lives in the account registry. This is the accountEnv
precedent extended from "which env vars" to "which subprocess protocol."

**What doctrine §1 covers here (and what it does not over-claim).** "One
engine, an improvement lands for every project at once" holds in full for the
*shared surface*: the `ExecDriver` interface, and all the provider-agnostic
control flow above it — dispatcher, executor, the thread inner loop, and
orchestrator mediation, which only ever call `agent()` and read its typed
result. A change there lands for every project on every backend at once.
The two driver *bodies* (`drivers/claude.ts`, `drivers/codex/`) are not a dual
path in the §1 sense: they are not two implementations of the same behavior
that a project opts between — each is the *only* way to drive its own account
fact, the same as `providerOf`'s two env branches. A body-level improvement
(e.g. a better Codex transcript adapter) applies per-backend *by nature*,
because the backends are physically different subprocesses; it is not a project
opt-in and cannot fossilize. Universal rollout is a property of the interface
and the control flow, not a claim that one code body serves both providers.

### Driver interface

```ts
interface ExecDriver {
  // Run one agent turn: stream events, force a typed result, return it (or null).
  run<S>(prompt: string, opts: AgentOpts<S>): Promise<z.infer<...> | null>;
  // Charter-time capability probe (see "honest degradation").
  supports(req: CapabilityReq): CapabilityResult;
}
```

**Where `supports()` is actually invoked (the wall must have a caller or it is
placebo).** The charter gate is `validateCharter(c: Charter)` in scoping.ts:36,
called by `dispatcher.startLoom` (dispatcher.ts:675 and :727) on both the
hand-authored and scoped-draft routes. `startLoom` already resolves the
account for the loom (`manifest.account` → `deps.accounts[...]`,
dispatcher.ts:656,721), so it holds the `provider` fact at exactly the moment
it validates. The wiring: `validateCharter` gains the loom's `AccountProfile`
and, for each capability the charter's decomposition requires (a read-only
Verifier wall, a workspace-write builder, Playwright MCP, subagent spawn),
calls `driverFor(provider).supports(req)`; any `CapabilityResult` that is not
satisfiable becomes a hard `errors[]` entry, and `startLoom` refuses the
charter the same way it refuses a malformed one today. This is the single
enforcement point on which every "honest degradation" / "refuses at charter"
claim below depends — without it, `supports()` computes a verdict nobody reads
and the degradation happens silently.

`run` owns four jobs; the mapping per backend:

| Job | Claude driver (today) | Codex driver |
|---|---|---|
| **spawn/stream** | `query()` async-iterator | `runCodexTurn()` → `AppServerClient` over app-server stdio |
| **tool bridge** | built-in tools + `mcpServers` | Codex commandExecution/fileChange/webSearch/mcp + MCP servers written into `CODEX_HOME/config.toml` |
| **transcript** | SDK msgs → `EngineEvent` | `CodexNormalizedEvent` → `EngineEvent` (adapter already 1:1 for session/text/tool/tool-result) |
| **result emission** | `emit_result` in-process SDK MCP server | see below — Codex has no in-process JS MCP host |

### The load-bearing mechanics, mapped

- **`emit_result` (the typed-result contract).** Claude registers an
  in-process `createSdkMcpServer` tool and forces one call (engine.ts:140-154);
  `null` = never emitted = failure, never inferred success (engine.ts:222).
  Codex `app-server` has **no in-process JS MCP host** — it loads MCP servers by
  config only. Two mechanisms are *candidates*, and exactly ONE ships — this is
  not a runtime dual path. **(a) `telar-emit` MCP:** a tiny stdio MCP server (a
  Codex-visible sibling of the `out` server) registered in the run's
  `CODEX_HOME`, exposing `emit_result` with the same Zod-derived schema; the
  Codex model calls it, the server captures the value, `run` returns it.
  **(b) Fenced JSON block:** the prompt appendix `agent()` already appends
  instructs a single fenced `telar-result` block; the driver parses the final
  `agentMessage` and Zod-validates it. **Prove-run 1 (Open Q6) decides which,
  empirically, and the Codex driver commits to exactly that path for every
  run.** Both preserve the identical "no emit = failure, `null` never inferred
  as success" contract; the choice is which *one* the driver body contains.
  There is no auto-fallback where the driver silently switches mechanism when
  the tool isn't offered at runtime — that would be the forbidden hidden dual
  path. If (b) wins, `telar-emit` is dropped from the tree, not kept as a live
  alternative; if (a) wins, the JSON-block instruction is dropped for Codex.
- **`restrictTools` (the capability wall).** Claude filters *built-in tool
  availability* so Write/Edit/Bash/Agent never load (engine.ts:26,173-175) — the
  Verifier's read-only guarantee by construction. Codex has **no per-named-tool
  availability filter**; its wall is the OS sandbox. `restrictTools:true` +
  read-only tool set maps to `sandbox:"read-only"` + `approvalPolicy:"never"`
  (codex-app-server.ts:319-329): file writes and mutating exec are denied by the
  kernel, a *stronger* wall than a denylist *for the write/exec axis*. **Genuine
  gap:** Codex cannot withhold a *specific* capability (allow reads but forbid
  `webSearch`, or forbid `collabAgentToolCall` spawn) while allowing others —
  it's all-or-nothing per sandbox tier. This gap is not hypothetical: the
  Verifier's own wall is not just read-only file access — it *also* disallows
  `Agent` (verifier.ts:244) to block subagent escalation, and a read-only OS
  sandbox does **not** deny `collabAgentToolCall` spawn (spawning an agent is
  neither a file write nor a mutating local exec). So the read-only sandbox does
  **not** by itself reproduce the Claude Verifier's no-spawn guarantee.
  Resolution — one of two, decided by prove-run 2, never a silent weaker wall:
  either (i) prove that `sandbox:"read-only"` + `approvalPolicy:"never"` in the
  tested app-server build actually denies `collabAgentToolCall` (no worker turn
  can start under read-only), and cite it here; or (ii) `supports()` must REFUSE
  the Verifier capability on a Codex account, so a web loom on Codex **fails at
  charter** rather than verifying under a wall that permits subagent spawn.
- **`bypassPermissions` (autonomy).** Claude's `permissionMode` (engine.ts:166).
  Codex equivalent: `approvalPolicy:"never"` + `sandbox:"workspace-write"`
  (network on, writes confined to the worktree) — full autonomy inside the lane,
  the builder's mode. Clean 1:1.
- **Thread transcripts / mediation.** The thread inner loop and orchestrator
  mediation (dispatcher.ts, executor.ts, PRINCIPLES §L1-L2) are **pure control
  flow in code** that only ever call `agent()` and read its typed result — they
  never touch the SDK. They are provider-agnostic *for free* the moment `run`
  returns a valid typed result on Codex. No mediation change. Codex's own
  `collabAgentToolCall` subagents map to `spawn`/`spawn_result` events already
  (codex-app-server.ts:51-67) — surfaced as transcript, not as Telar threads.
- **The Verifier.** Same `agent()` call (verifier.ts:237-264). Its wall +
  Playwright MCP map as above: on Codex, the driver writes the Playwright
  `mcp_servers` entry into the run's `CODEX_HOME/config.toml` and sets
  `sandbox:"read-only"`. The `disallowedTools` denylist (verifier.ts:244) covers
  two things: Write/Edit/Bash/NotebookEdit (write/exec — the read-only sandbox
  *does* subsume these) **and `Agent`** (subagent spawn — the read-only sandbox
  does **not** subsume this; see the restrictTools gap above). Until (i) is
  proven, the Verifier is only honestly expressible on Codex if `supports()`
  either confirms read-only denies spawn or refuses the account at charter.
  Do not describe the read-only sandbox as subsuming the full denylist — it does
  not cover the spawn dimension.

### Structural move

`codex-app-server.ts` currently lives in `apps/web/lib` — the ENGINE (core)
needs it. Lift it into `packages/core/src/drivers/codex/` as the driver's
transport; the web chat route imports it from core thereafter (one owner, no
copy). `agent()`'s Claude body becomes `drivers/claude.ts`. `engine.ts` keeps
`accountEnv`, the concurrency gate, and the `driverFor` dispatch.

## VERIFIER — fix the false provider-agnostic claim

verifier.ts:4 ("Built on the provider-agnostic `agent()` primitive") and
providers.ts:3 are **false today**: `agent()` is Claude-only. The Verifier is
not backend-neutral — it needs, **per provider**:

- **Claude:** `extraMcpServers` stdio Playwright entry + `restrictTools` +
  `disallowedTools` denylist (the read-only guarantee).
- **Codex:** Playwright `mcp_servers` written into the run `CODEX_HOME`;
  `sandbox:"read-only"` + `approvalPolicy:"never"` as the wall; `emit_result`
  via the single mechanism prove-run 1 selects. The sandbox is the guarantee for
  write/exec, but NOT for subagent spawn (the denylist's `Agent` entry) — so the
  Verifier is only expressible on Codex once spawn-denial is proven, else
  `supports()` refuses the account at charter (see the wall gap above).
- **Both:** a resolvable Playwright MCP binary and a reachable app URL.

Correct the comments to "runs on whichever driver the account's provider
selects; the read-only guarantee is enforced per-backend (tool-availability
filter on Claude, OS sandbox on Codex)." `supports()` must confirm the
Playwright-MCP + read-only-wall combination is expressible before a web loom
charters on a given account.

## ROLLOUT — branch + sandbox, no runtime switch

1. **Branch** off `ui-v2` (e.g. `codex-driver`). All work here; `main` untouched.
2. **Sandbox project + Codex account.** Register a throwaway project whose
   default account is the seeded `codex` profile (accounts.ts:34).
3. **Cheapest real charter (mirrors M11 Run 4, m11-prove-run.md §Run 4):** a
   greenfield `bun test` library — non-web, so it exercises the full build +
   derived test-gate path *without* needing the Verifier's browser wall on the
   first run.
   - **Expected artifacts:** a worktree with committed code; `events.ndjson`
     carrying normalized Codex events bridged to `EngineEvent`; a
     Telar-*derived* test gate (not a prose gate); each `agent()` leaf returning
     a valid Zod-parsed typed result via whichever emit mechanism Q6 selects;
     `spentUsd > 0` (costUsd populated from tokens×price — Open Q4); loom reaches
     autonomous `ready`; the independent suite green; a human accept to `done`.
   - **Acceptance:** every leaf produced a typed result on Codex (zero `null`-
     from-missing-emit); Q6's emit mechanism is chosen and the other deleted;
     the spend guard is live (a synthetic low `maxCostUsd` clamps fan-out);
     the fail-closed top gate held; `ready → done` stayed a human click; no
     false green. Then a **second** sandbox charter — a small
     web feature — to prove the Verifier wall + Playwright MCP on Codex, or to
     prove `supports()` **refuses at charter** if that combination can't be
     expressed on the account (the honest-degradation path).
4. **Single-engine cutover.** Once both prove-runs pass, the driver dispatch
   *is* `agent()` for everyone — no flag, no opt-in. A project on a Codex
   account simply works; git branch history is the only "rollout switch" (§1).

## RISKS + OPEN QUESTIONS (each with a proposed answer)

1. **app-server is upstream-experimental (`-32601` fallback exists,
   codex-app-server.ts:239).** *Answer:* keep the fallback; the driver treats an
   unsupported method as a capability `supports()` reports, so a missing feature
   refuses at charter rather than half-running. Pin the tested `codex` binary
   version as a project FACT is out of scope — it's a machine fact, not engine.
2. **`emit_result` guarantee weaker than the SDK's forced tool.** *Answer:*
   prove-run 1 (Open Q6) picks ONE of `telar-emit` MCP / fenced-JSON block,
   empirically; the driver body then contains only that mechanism. Both are
   Zod-validated and preserve "no emit = failure"; the loser is deleted from the
   tree, not kept as a live fallback (a runtime auto-switch would be the
   forbidden hidden dual path).
3. **No fine-grained tool wall on Codex (spawn/webSearch can't be selectively
   denied).** *Answer:* the walls Telar relies on are read-only (Verifier) and
   workspace-write (builder). Workspace-write is a clean 1:1. Read-only covers
   write/exec but NOT subagent spawn (the Verifier's `Agent` denial,
   verifier.ts:244); until prove-run 2 shows read-only denies
   `collabAgentToolCall`, `supports()` must refuse the Verifier on Codex at
   charter. `supports()` refuses any other selective wall too, so there is never
   a silent weaker wall.
4. **`costUsd` — Codex reports tokens, not dollars** (codex-app-server.ts:575-
   591; the SDK gives `total_cost_usd`, engine.ts:217). This is a
   **runaway-spend guard hole**, not a cosmetic gap: budget.ts is dollars-only.
   `budgetLeftUsd` is driven by `spentUsd` (budget.ts:27), and `fanoutClamp`
   sets `capByBudget = Infinity` whenever the budget is not finite
   (budget.ts:49-52). If the Codex driver leaves `result.costUsd` undefined,
   `spentUsd` never accumulates, `maxCostUsd` never bites, and the spend guard
   doctrine §3 exists to enforce ("guards exist to stop WASTE — runaway spend")
   is *silently unbounded* on every Codex loom. *Answer — single path, no
   escape hatch:* the Codex driver MUST populate `EngineEvent.result.costUsd`
   from `tokens × per-model price`, where the price table is a **provider
   FACT** (same status as `providerOf`'s env map), so the existing dollar-
   denominated budget accounting works unchanged for Codex. The earlier "or
   leaves it undefined / budget keys on tokens for Codex" wording is deleted:
   a token-denominated cap is not a thing budget.ts has, and inventing a second
   accounting axis would be a per-backend behavior fork. Prove-run 1's
   acceptance adds: `spentUsd > 0` after the run and a synthetic low `maxCostUsd`
   demonstrably clamps fan-out on Codex. (Only if budget.ts is *actually*
   extended with a proven token-denominated cap — out of scope here — could the
   dollar conversion be dropped; until then, dollars is the one path.)
5. **`maxTurns` has no Codex analogue** (a Codex turn runs to its own
   completion). *Answer:* advisory only on Codex; the app-server governs turn
   termination. Not a correctness risk for the typed-result contract.
6. **Open: does the tested `codex app-server` reliably offer a config-registered
   MCP tool inside a `turn/start`?** *Answer:* prove-run 1 answers it and, in
   doing so, **decides the single emit mechanism** (Open Q2). If MCP reliably
   offers the tool, `telar-emit` ships and the JSON-block path is dropped; if
   not, the fenced JSON block is the one shipped path and `telar-emit` is
   dropped. The driver commits to exactly one — never both live with a runtime
   auto-switch.
