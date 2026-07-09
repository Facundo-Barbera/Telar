<!-- Planning doc. Drafted 2026-07-08 via an understand→research→draft workflow, then
     anchor-verified by hand against the real tree (engine.ts agent() wiring, schemas.ts
     Verdict/ProjectManifest, runs.ts RunKind, route.ts send() vocab, session-view ToolStepRow
     + event switch, executor/gates/dispatcher). Two grounding readers (tool-perms, evidence-sse)
     failed on a structured-output cap; their territory was re-verified manually before publishing. -->

# Telar Verifier (QA) Agent — Implementation Spec

Status: implementation-ready. Every claim below is anchored to a real symbol in `/Users/facundo/Projects/personal/telar`. Where a seam does not yet exist, it is called out as **NEW** with the exact file to touch.

---

## 1. Goal & non-goals

**Goal.** Make a Telar loop *walk-away-trustworthy* by terminating it on **executable evidence** produced by an **independent agent** that drives the running app through its accessibility tree, judges a feature's acceptance criteria, and emits a per-criterion evidence bundle (`{criterion, verdict, evidence[], repro[]}`). A successful exploratory run is then **distilled** into a deterministic Playwright `.spec.ts` that guards the flow forever and can be pointed at deployed URLs for synthetic monitoring.

The Verifier closes the one gap Telar's existing loop cannot: `executeRun` (`packages/core/src/executor.ts`) today terminates on `runGates` — sequential *shell* commands decided by exit code (`packages/core/src/gates.ts:runGate`) — plus the builder's own self-reported `Verdict` (`packages/core/src/schemas.ts:Verdict`). Neither exercises the UI. "Green" currently means "the process the builder wrote exited 0," which the builder can trivially satisfy. The Verifier makes green mean "a *different* agent drove the real app and saw it work."

**Non-goals.**
- Not a generic test framework. It judges **one feature's acceptance criteria** per run, not a suite.
- Not a replacement for `runGates`. Shell gates (typecheck, `bun test`) stay as the cheap first ring; the Verifier is the **UI ring** that runs when a feature has UI acceptance criteria.
- Not a builder. The Verifier **cannot edit app source** (Section 3). If it could, its verdict would be worthless.
- Not a vision/pixel model. Driving is **accessibility-tree-first** (`browser_snapshot` ref model); screenshots are *evidence*, never a *driving signal*.
- Not a scheduler by itself. It rides Telar's run/dispatch machinery (`packages/core/src/dispatcher.ts:startRun`); durable scheduling is an explicit later milestone, not baked into the agent.
- Not a hand-patchable spec surface. A flaky distilled spec is **kicked back to exploration** to re-derive; it is never hand-edited.

---

## 2. Design principles

1. **Independence is the moat.** The Verifier is a *separate* agent with a *different toolset* than the builder. It has **zero** `Write`/`Edit`/`Bash`-against-source capability (enforced, Section 3). A verdict is only worth acting on because the thing that produced it could not have caused it.

2. **Evidence-terminated, never say-so.** The loop terminates on the **evidence bundle**, not on a chat sentence or the builder's `Verdict.ok`. `agent()` in `packages/core/src/engine.ts` already embodies the discipline: it forces a structured result through a required `emit_result` MCP tool and returns `null` if the agent never emitted — *"null = never emitted — caller treats as failure, never infers success."* The Verifier reuses that exact contract, upgrading the payload from `Verdict` to `VerifierReport` (Section 6).

3. **Accessibility-first driving.** The drive loop is `snapshot → reason → act → re-snapshot`. The primary tool is `browser_snapshot`, returning the ARIA tree with a stable `ref` + role + accessible name per node. Targets are chosen by **role/label/text**, never CSS/nth-child. This is resilient by construction: the agent adapts to a moved button instead of hard-failing on a selector.

4. **Two modes, one origin.**
   - **(A) Exploratory verification** — the live, agentic, flake-resistant front line. Drives via Playwright MCP, judges criteria, emits the bundle.
   - **(B) Distilled regression spec** — a cheap deterministic `.spec.ts` *generated from* a successful (A) run using `browser_generate_locator` role-based locators, run headless in CI/cron.
   
   (A) discovers and verifies a flow once; (B) guards it forever. A flaky (B) is quarantined and re-derived by (A).

5. **Anti-flake lives in the harness, not the agent's discretion.** Role/text locators only, no sleeps (auto-wait on conditions), frozen env (seeded data, `storageState`, mocked clock/3p), retry-in-isolation quarantine, trace-on-everything. These are **enforced** by config, lint gates, and the MCP server's launch flags (Section 5) — the agent cannot opt out.

---

## 3. The Verifier agent — definition for Claude (SDK) and Codex

### 3.1 The architectural fork (decided)

The grounding is unambiguous: **there is no provider-neutral persona seam in the chat path.** The Claude SDK `agents: Record<string, AgentDefinition>` option (the real "custom persona with own prompt/tools/model/permissionMode" mechanism, `sdk.d.ts:1327`) is **never used** — `apps/web/app/api/chat/route.ts` builds its `query({ options })` (route.ts:679–739) with `systemPrompt:{type:"preset",preset:"claude_code"}` and no `agents` key. Codex has **no symmetric config surface at all**: a Codex spawn's only "persona" signal is the model name (`route.ts:589`, `agent:{type:nev.model,…}`).

Therefore the Verifier is **NOT** a model-spawned subagent. It is a **Telar-orchestrated verification pass** built on the provider-agnostic `agent()` primitive in `packages/core/src/engine.ts`. This is the recommendation in the grounding and it is correct because:

- `agent()` already works identically for Claude and Codex (routed by `accountEnv`/`providerOf`, engine.ts:47).
- It already forces a structured result and treats non-emission as failure — the exact "must verify, cannot fake success" contract we need. Leaving the *model* to decide whether to spawn a verifier (the `agents`-definition path) has **no enforcement it runs** (grounding gap #3).
- It already scopes tools and honors `disallowedTools` where "an explicit SDK disallow always wins over any allow rule, incl. repo settingSources" (engine.ts comment).

The chat-path `agents` option is explicitly **rejected** as the primary mechanism: it is Claude-only, unenforced, and asymmetric. (It remains a *possible* future ergonomic path for an in-chat "verify this" subagent, tracked in Section 10.)

### 3.2 Where it plugs in

A new module **`packages/core/src/verifier.ts`** exports `verify(feature, opts)` built on `agent()`. It is invoked as a distinct phase inside the run loop (Section 7), between the builder's attempt and `runGates` — or as a standalone verify-only run (new run kind, Section 8). It gets its own Claude/Codex account via the existing `opts.accounts?.[…]` plumbing (executor.ts:110), so **independence extends to billing/session isolation**: the Verifier can run on a *different account* than the builder, guaranteeing no shared session state.

### 3.3 Toolset (allow / deny) and how "no app-source writes" is ENFORCED

`agent()` sets `allowedTools: [...(opts.tools ?? ["Read","Grep","Glob"]), "mcp__out__emit_result"]` and passes `permissionMode:"bypassPermissions"`. The Verifier's tool grant is:

```ts
// packages/core/src/verifier.ts
const VERIFIER_TOOLS = [
  "Read", "Grep", "Glob",                    // read app source to map criteria → UI, never write
  "mcp__playwright__browser_navigate",
  "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_click",
  "mcp__playwright__browser_type",
  "mcp__playwright__browser_fill_form",
  "mcp__playwright__browser_select_option",
  "mcp__playwright__browser_hover",
  "mcp__playwright__browser_press_key",
  "mcp__playwright__browser_wait_for",       // {text|textGone} only — never {time}
  "mcp__playwright__browser_verify_text_visible",
  "mcp__playwright__browser_verify_element_visible",
  "mcp__playwright__browser_verify_value",
  "mcp__playwright__browser_take_screenshot", // evidence only
  "mcp__playwright__browser_console_messages",
  "mcp__playwright__browser_network_requests",
  "mcp__playwright__browser_evaluate",        // state assertions/extraction, not clicking
  "mcp__playwright__browser_generate_locator", // the distillation bridge
  "mcp__playwright__browser_storage_state",
  "mcp__playwright__browser_set_storage_state",
  "mcp__playwright__browser_tabs",
  "mcp__playwright__browser_handle_dialog",
];
```

**Enforcement of "no app-source writes" is defense-in-depth, all inside Telar's existing machinery:**

1. **Availability restriction (primary).** The Verifier passes `restrictTools: true`, which sets the SDK's `Options.tools` — the *availability* control ("the base set of available built-in tools") — to exactly `VERIFIER_TOOLS`' built-ins. So `Write`/`Edit`/`Bash`/`NotebookEdit`/`Agent` and the rest of the claude_code preset are **never loaded into the turn**. This is the real wall.

   > **M1 audit correction.** An earlier draft named allowlist omission as primary. That is wrong: under `permissionMode:"bypassPermissions"`, `allowedTools` only *auto-approves without prompting* — it does **not** gate availability (SDK `sdk.d.ts:1329-1331`: *"To restrict which tools are available, use the `tools` option instead"*). With `allowedTools` alone the full preset — including the `Agent` subagent-spawn tool, an escalation path to a writing child — stayed reachable. `restrictTools` → `Options.tools` is what actually restricts; the allowlist is now just the auto-approve convenience on top.

2. **Explicit disallow (defense-in-depth).** Pass `disallowedTools: ["Write","Edit","MultiEdit","Bash","NotebookEdit","Agent", ...manifest.guardrails.disallowedTools]`. Per engine.ts's own comment, an explicit SDK `disallowedTools` **wins over any allow rule, including repo `settingSources`**. Redundant with `restrictTools` but kept for clarity and forward-compat as new write/spawn tools land.

   *Residual (accepted for v1):* `Options.tools` governs built-ins only; MCP tools come via `mcpServers`. The Playwright server's non-allowlisted tools (`browser_take_screenshot` is needed; `browser_pdf_save`) can splat image/PDF **bytes** to an absolute path, but cannot author chosen source — so the real invariant (can't forge a passing state by rewriting code) holds. Tightening MCP tool exposure is a later milestone.

3. **No settingSources escalation.** Unlike the builder pass, the Verifier passes **`settingSources: []`** (or omits it). The builder needs the repo's CLAUDE.md/skills; the Verifier must not inherit repo-defined tool grants or hooks that could re-enable writes. The judgment must be uncontaminated by the repo under test.

4. **The MCP browser tools cannot touch app source.** They act on a browser page, not the filesystem. `browser_evaluate` runs JS *in the page*, not in Node — it cannot write files. So even the "escape hatch" tool is confined to the DOM.

This is strictly *stronger* than the chat path's subagent story, where `canUseTool` "fails closed for subagent tool requests" (grounding gap #2) — we never rely on interactive approval at all.

### 3.4 The actual system prompt

This text is the `promptText` passed to `agent()` (prepended to the per-feature task). It is deliberately imperative about evidence, adaptation, and the ban on self-certification.

```
You are the Telar Verifier: an INDEPENDENT quality agent. You did NOT write this
code and you CANNOT edit it. Your only job is to determine, from EXECUTABLE
EVIDENCE, whether each acceptance criterion of the feature under test is met by
the RUNNING application. Your verdict is trusted precisely because you cannot
change the code to make it pass.

You drive the app through its ACCESSIBILITY TREE, not by guessing selectors and
not by looking at pixels. Your loop is: snapshot -> reason -> act -> re-snapshot.

1. Call browser_navigate to the app URL you were given.
2. Call browser_snapshot to read the ARIA tree. Every interactable node has a
   stable `ref`, a role, and an accessible name. Choose targets by ROLE + NAME
   (a "Submit" button, a textbox labeled "Email"), never by position or CSS.
3. Act with browser_click / browser_type / browser_fill_form / browser_select_option
   / browser_press_key, always passing BOTH a human-readable `element` description
   AND the `ref` from your most recent snapshot. After any action that changes the
   page, take a fresh browser_snapshot before acting again — refs from an old
   snapshot are stale.
4. To wait, use browser_wait_for with `text` (appear) or `textGone` (disappear).
   NEVER wait for a fixed time. NEVER assume timing. Every action already
   auto-waits for the element to be actionable.

Judge each acceptance criterion explicitly. For EACH criterion:
 - Establish the state that criterion is about (navigate/act as needed).
 - ASSERT it with an assertion tool: browser_verify_text_visible,
   browser_verify_element_visible (role + accessibleName), or browser_verify_value.
   An assertion that passes is your PROOF the criterion holds.
 - Collect evidence: call browser_take_screenshot (name it after the criterion),
   keep the a11y snapshot you just read, and pull browser_console_messages and
   browser_network_requests to catch client errors and confirm the right API
   calls fired with the right status codes.
 - For every ref you interacted with or asserted on, call browser_generate_locator
   and record the returned getByRole/getByLabel string — Telar distills these into
   a regression spec later. This is not optional.

Be RESILIENT, not brittle. If a label moved, a button was renamed, or the DOM
was restructured, ADAPT: re-snapshot and find the semantically-equivalent node by
role and meaning. Only fail a criterion when the app genuinely does not satisfy
it — a functional failure, a thrown console error on the happy path, a wrong
value, a missing element that should exist. Distinguish that from a criterion you
could not evaluate.

Assign each criterion exactly one verdict:
 - "pass": you drove the flow and an assertion proved the criterion holds.
 - "fail": you drove the flow and the app did not satisfy it — cite the exact
   observation (asserted X, saw Y; console error Z; network 500 on /api/…).
 - "flaky": it passed on one attempt and failed on another within this run, or
   depended on timing/order you could not stabilize.
For a "fail", record the minimal repro: the ordered list of role-based steps that
reproduces it.

You have NO Write, Edit, or Bash tools. Do not ask for them. Do not suggest code
fixes as your result — describe the OBSERVED behavior; repair is someone else's
job. Do not claim a criterion passes without an assertion that proves it: an
unproven pass is a "fail" to evaluate.

When every criterion has a verdict and its evidence, call emit_result exactly
once with the complete VerifierReport. Emitting is the ONLY way your work counts;
if you never emit, Telar records the verification as failed.
```

### 3.5 Codex parity

Because the Verifier is built on `agent()` (not the chat `agents` option), Codex support is **free and identical**: `agent()` routes to the Codex provider via `accountEnv`/`providerOf` with the same MCP servers, same `emit_result` contract, same prompt. No `route.ts` Codex spawn-handler changes, no `agent.type` synthesis (grounding gap #6) — those only mattered for the model-spawned-subagent path we rejected. The Codex asymmetry is designed around, not fought.

---

## 4. Browser substrate & the drive loop

### 4.1 Substrate: two layers

- **Layer 1 (exploration):** the official **`@playwright/mcp`** server (`npx @playwright/mcp@latest`). Portable, headless-capable, ships with a distributable Telar. Its core primitive `browser_snapshot` returns the ARIA tree with per-node `ref`. This is the **dependency**.
- **Layer 2 (regression + monitoring):** raw **`@playwright/test`** (`.spec.ts`, run by the Playwright runner) distilled from Layer 1. This is *not* the MCP session frozen — it is generated, deterministic, headless.

**cmux browser tools are explicitly NOT the dependency.** They are a convenient *local-only* driver. Telar ships on `@playwright/mcp` so a distributed/CI Telar works with no cmux.

New dependency (grounding: repo has **zero** browser automation today): add `@playwright/mcp` and `@playwright/test` to `apps/web/package.json` (Bun-managed, per global config). Playwright Test gets its own runner — it does **not** run under `bun test`; the existing `bun test` gate (`telar.yaml`) stays untouched for unit tests.

### 4.2 The snapshot/ref model (the loop, concretely)

```
browser_navigate({ url })
loop until every criterion has a verdict:
    snap = browser_snapshot()                       // ARIA tree: [{ref:"e17", role:"button", name:"Submit"}, ...]
    reason over snap: which ref matches the criterion's target by role+name
    act: browser_click({ element:"Submit button", ref:"e17" })   // auto-waits actionability
         or browser_fill_form({ fields:[{element,ref,type,value}, ...] })
    settle: browser_wait_for({ text:"Saved" })       // condition, never sleep
    assert: browser_verify_element_visible({ role:"status", accessibleName:"Saved" })
    evidence: browser_take_screenshot({ filename:"<criterion>.png" })
              browser_console_messages({ level:"error" })
              browser_network_requests()
    distill:  browser_generate_locator({ ref:"e17" }) -> "getByRole('button', { name: 'Submit' })"
```

Refs are **snapshot-scoped**: after any page-changing action the agent must re-snapshot before the next act (enforced only by prompt discipline; the MCP server returns a stale-ref error if it doesn't, which the resilient agent recovers from by re-snapshotting).

### 4.3 How the MCP server is wired into a turn

`agent()` already registers an in-process SDK MCP server (`createSdkMcpServer({name:"out", …})` for `emit_result`) and passes `mcpServers: { out }`. The Verifier adds a **second** entry — the Playwright MCP server as an external stdio server:

```ts
// verifier.ts — extend agent()'s options (add an optional mcpServers passthrough to AgentOpts)
mcpServers: {
  out,                                   // existing emit_result server
  playwright: {
    command: "npx",
    args: ["@playwright/mcp@latest",
           "--isolated",                 // ephemeral profile; browser_close discards it
           "--save-trace",               // trace bundle per session (evidence)
           ...(storageStatePath ? ["--storage-state", storageStatePath] : []),
           ...(headless ? ["--headless"] : [])],
  },
}
```

This requires a **small additive change to `AgentOpts`** in engine.ts: today `agent()` hardcodes `mcpServers: { out }`. Add an optional `extraMcpServers?: Record<string, McpServerConfig>` merged in as `mcpServers: { out, ...opts.extraMcpServers }`. That is the only engine.ts change; everything else (tool allowlist, disallow, structured result) already exists.

The tools then surface to the model as `mcp__playwright__browser_*` and must appear in `allowedTools` (they do, Section 3.3). Because `permissionMode:"bypassPermissions"` and they're explicitly allowlisted, there is no approval gap — the "subagent canUseTool fails closed" problem (grounding gap #2) never applies since we're not in a subagent.

---

## 5. Anti-flake harness — enforcement, not recommendation

Each rule below states **the mechanism that makes the agent unable to violate it.**

1. **Role/text locators only; brittle selectors banned.**
   - *Exploration:* enforced by the substrate — `browser_snapshot` only ever exposes `ref` + role + name; the agent has no CSS/XPath affordance to begin with. `browser_generate_locator` emits `getByRole`/`getByLabel`/`getByText` for free.
   - *Distilled specs:* enforced by a **lint gate on the diff**. **NEW** `packages/core/src/spec-lint.ts` rejects any `.spec.ts` under the distilled directory containing `page.locator(`, `.nth(`, `xpath=`, CSS-string selectors, or `getByText(...).nth(...)`. Wired as a **manifest gate** (`ProjectManifest.gates`) `{ name:"spec-lint", run:"bun run telar:spec-lint" }`, so it runs inside the existing `runGates` ring and blocks the loop on violation. A generated spec that fails lint is discarded and re-derived, never committed.

2. **Never sleep.**
   - *Exploration:* the agent's tool grant includes `browser_wait_for` but the prompt forbids its `{time}` form; and there is no `sleep`/`Bash` tool to call. Actions auto-wait on Playwright actionability (attached, visible, stable, enabled, receives events).
   - *Distilled specs:* `spec-lint` also bans `page.waitForTimeout(` and bare `setTimeout(`. Web-first assertions (`expect(locator).toBeVisible()`, `.toHaveText()`) auto-retry to a single global timeout set in `playwright.config.ts`, never per-step.

3. **Auth via `storageState`, logged in exactly once.**
   - A dedicated **setup phase** (Section 7) drives the login UI once, then calls `browser_storage_state` to persist cookies+localStorage to `~/.telar/verifier/<project>/<role>.json`. Every subsequent Verifier run and every distilled spec loads it (`browser_set_storage_state` / config `storageState`). Enforced by the workflow script: the setup phase is a hard prerequisite; the verify phase receives the path and no verify step re-drives the login form. One file per role (`admin.json`, `user.json`).

4. **Deterministic environment.**
   - Frozen clock: distilled specs call `page.clock.install()` / `setFixedTime()`; exploration passes `--isolated` for a clean profile per run.
   - Third-party mocking: `page.route()` + `route.fulfill()` in specs (MCP `--mock` during exploration) stub nondeterministic external calls, while the **app-under-test's own API stays real** (that's what we're verifying).
   - Pinned timezone/locale/viewport/color-scheme via `playwright.config.ts` `use:{}` and `--device`. Enforced because the config, not the agent, sets these.

5. **Retry-in-isolation quarantine.**
   - Distilled specs run with `retries: 2`, `fullyParallel: true`, **fresh browser context per test**. A test that fails then passes on retry is reported **`flaky`**, not green. Persistently unstable specs are tagged `@flaky` and excluded from the *blocking* gate while still running/tracking (HTML + JUnit reporters make the rate visible). Fresh-context isolation is what makes the retry a real signal rather than hidden shared-state leakage.
   - In the run loop, a `flaky` verdict on any criterion (Section 6) does **not** count as `pass` and does **not** count as a hard `fail` — it routes the flow back to exploration for re-derivation (grounding principle: "a flaky spec is kicked back to exploration, never hand-patched").

6. **Trace on everything.**
   - Exploration: MCP `--save-trace` writes a Playwright trace per session into the evidence dir.
   - Specs: config `trace:'on-first-retry'`, `video:'retain-on-failure'`, `screenshot:'only-on-failure'`. The trace (`npx playwright show-trace trace.zip`) bundles action timeline, before/after DOM, network, console, source — the self-contained artifact a human or the repair agent replays without reproducing.

---

## 6. Evidence & verdict schema + persistence + render

### 6.1 TypeScript / Zod types (NEW in `packages/core/src/schemas.ts`)

Defined alongside the existing `Verdict` so the Verifier's structured-result contract lives with the rest. `VerifierReport` is the `schema` passed to `agent()` (replacing `Verdict` for the verify pass).

```ts
// packages/core/src/schemas.ts  (NEW, additive)

export const EvidenceKind = z.enum([
  "screenshot", "a11ySnapshot", "console", "network", "trace",
]);

export const Evidence = z.object({
  kind: EvidenceKind,
  // Relative path under the run's evidence dir, OR inline text for small blobs
  // (a11ySnapshot / console line). Large binaries (png/trace) are always paths.
  path: z.string().optional(),
  text: z.string().optional(),
  label: z.string().default(""),        // e.g. "after submit", "POST /api/save -> 200"
});
export type Evidence = z.infer<typeof Evidence>;

export const CriterionVerdict = z.enum(["pass", "fail", "flaky"]);

export const ReproStep = z.object({
  action: z.string(),                   // "click", "fill", "navigate", "assert"
  target: z.string(),                   // role-based description: "button 'Submit'"
  value: z.string().optional(),
  locator: z.string().optional(),       // getByRole(...) from browser_generate_locator
});

export const CriterionResult = z.object({
  criterion: z.string(),                // the acceptance-criterion text, verbatim
  verdict: CriterionVerdict,
  observed: z.string(),                 // what the agent saw ("asserted 'Saved' visible")
  evidence: z.array(Evidence).default([]),
  repro: z.array(ReproStep).default([]),// present on fail; ordered minimal repro
  locators: z.array(z.string()).default([]), // generated role-locators touched (for distillation)
});
export type CriterionResult = z.infer<typeof CriterionResult>;

export const VerifierReport = z.object({
  feature: z.string(),
  url: z.string(),                      // the app URL that was driven
  ok: z.boolean(),                      // true iff every criterion === "pass"
  summary: z.string(),
  criteria: z.array(CriterionResult).default([]),
  // Session-wide evidence not tied to one criterion (the trace, full console dump).
  sessionEvidence: z.array(Evidence).default([]),
});
export type VerifierReport = z.infer<typeof VerifierReport>;
```

**Relationship to existing `Verdict`.** `VerifierReport.ok` is the drop-in replacement for `Verdict.ok` in the run-decision logic (executor.ts:150 `if (verdict?.ok)`). Where the executor stores `attempt.verdict: Verdict`, the Verifier pass stores a `VerifierReport`. `AttemptRecord` (`packages/core/src/runs.ts:17`) gains an additive optional field `verifierReport?: VerifierReport` (keep `verdict` for the builder pass; do not overload it — the two are semantically different: builder self-report vs. independent evidence).

### 6.2 Persistence

- **Structured report:** written into the Run's existing on-disk home. Runs persist to `~/.telar/runs/<id>/` as `run.json` (`saveRun`) + `events.ndjson` (`appendEvent`) — see `packages/core/src/runs.ts`. The `VerifierReport` lands inside `run.json` via the `attempt.verifierReport` field (atomic tmp+rename `saveRun`), and a `{type:"verifier"}` event is appended to `events.ndjson` for the live SSE tail.
- **Binary evidence bundle:** screenshots and the trace zip are large; they go to **`~/.telar/runs/<id>/evidence/`** (**NEW** dir). `Evidence.path` values are relative to that dir. This keeps `run.json` small and matches the "files remember; no database" convention (`store.ts` header).
- **For a chat-embedded verify** (Section 7 in-chat variant), the report rides the existing chat persistence: a `Part` of `type:"tool"` (`apps/web/lib/store.ts`) whose `output` is the JSON report. No `store.ts` schema change is required for the minimal path — the report is just tool output. (An optional additive `Part.verifier?: VerifierReport` field is available later for first-class rendering, but is **not** needed for v1; `Part.agent` already demonstrates the additive-optional pattern for back-compat.)

### 6.3 Rendering (tie to the real render path)

**Reuse the existing tool-result render path — do not invent a chat surface.** When the Verifier runs as an `agent()` pass, its browser tool calls and the final `emit_result` flow through the same event vocabulary the chat route already emits and the client already renders:

- The route's SSE `send()` vocabulary (`apps/web/app/api/chat/route.ts`) already has `send("tool", {id,name,input,…})` (route.ts:861) and `send("tool_result", {id,output,isError,…})` (route.ts:919). Each `mcp__playwright__browser_*` call surfaces as a `tool` event; its result as a `tool_result`.
- The client handles these in `session-view.tsx`: the `case "tool"` (L1527) appends a `type:"tool"` `Part`; the `case "tool_result"` (L1553) patches `output`/`isError` onto it by id. Each renders as a **`ToolStepRow`** (session-view.tsx:648) — a collapsible step showing input (the `element`/`ref`/`text`) and output (the a11y snapshot / assertion result). `browser_take_screenshot` output is a path; the collapsed `<pre>` shows it. **This means the drive loop is human-watchable, step by step, with zero new UI.**

**Two justified additions:**

1. **A first-class evidence-bundle card** for the *final* `VerifierReport`. Rather than leaving it as raw JSON in a `ToolStepRow`, render a `VerifierReportCard` (**NEW** component, sibling of `ToolStepRow`) that lists each criterion with a pass/fail/flaky badge (reuse the existing `Badge` used for `auto-denied`), inline screenshot `<img>` per criterion, expandable repro steps, and a "console/network" disclosure. It keys off a **new SSE event**:

   - **NEW SSE event `send("verifier", { report: VerifierReport })`** — justified because the report is a *structured, human-consumed deliverable* (the "diff + proof" the human reviews), not another tool step, and the client needs to route it to the card rather than a generic `<pre>`. Add a `case "verifier"` to the session-view event switch (alongside `case "tool_result"`) that stores the report and renders `VerifierReportCard`. This is the single new event in the whole spec; everything else reuses `tool`/`tool_result`/`session`/`done`.

2. **Run-view surface.** For runs (not chat), the Runs SSE tail (`apps/web/app/api/runs/[id]/events/route.ts`, 400ms poll of `run.json`+`events.ndjson`) already streams snapshots. The `attempt.verifierReport` renders in the run detail view with the same `VerifierReportCard`. No new event needed there — it's a field on the polled snapshot.

Evidence images are served from `~/.telar/runs/<id>/evidence/` via a **NEW** thin static route `apps/web/app/api/runs/[id]/evidence/[...path]/route.ts` (read-only file serve, path-traversal guarded).

---

## 7. Exploratory → distill workflow

The Verifier rides Telar's existing build→verify→repair loop (`executeRun`, executor.ts) but adds a **UI-verify phase** and a **distill phase**. Concretely, a workflow script (the shape below is the contract; it lives as **NEW** `packages/core/src/verified-loop.ts`, orchestrating existing primitives):

```ts
// packages/core/src/verified-loop.ts  (shape)
async function verifiedFeatureLoop(feature: Feature, ctx: LoopCtx) {
  // ---- Phase 0: SETUP (once per project/role) ----
  //   Independent of the feature. Drives login UI, persists storageState.
  const storageState = await ensureStorageState(ctx.project, feature.role);   // browser_storage_state

  for (let attempt = 1; attempt <= ctx.maxAttempts; attempt++) {
    // ---- Phase 1: BUILD (existing) ----
    //   The BUILDER agent (BASE_TOOLS = Read/Grep/Glob/Write/Edit/Bash,
    //   runs.ts) implements the feature. This is today's executor attempt.
    const buildVerdict = await builderAttempt(feature, ctx, attempt);          // agent(), Verdict

    // ---- Phase 2: DETERMINISTIC GATES (existing) ----
    //   Cheap first ring: typecheck / bun test via runGates (gates.ts).
    const gates = await runGates(ctx.manifest.gates, ctx.manifest.root);
    if (!gates.ok) { ctx.repairContext = gateFailures(gates); continue; }

    // ---- Phase 3: UI VERIFY (NEW — the Verifier) ----
    //   INDEPENDENT agent, different account, NO write tools, Playwright MCP.
    const report = await verify(feature, {                                     // agent(schema: VerifierReport)
      url: ctx.devUrl,                     // e.g. http://localhost:3131
      storageState, account: ctx.verifierAccount,
      tools: VERIFIER_TOOLS, disallowedTools: ["Write","Edit","Bash"],
      settingSources: [],
    });

    if (report === null || report.criteria.some(c => c.verdict === "fail")) {
      // ---- REPAIR: feed EVIDENCE (not chat) back to the builder ----
      //   The repair prompt is built from failing criteria: observed + repro
      //   steps + console/network evidence. Resume the builder session
      //   (executor.ts already resumes prior sessionId across attempts).
      ctx.repairContext = repairFromReport(report);
      continue;
    }

    if (report.criteria.some(c => c.verdict === "flaky")) {
      // Kick back to exploration — re-derive, never hand-patch.
      continue;   // (bounded; after N flaky loops -> escalate "needs-review")
    }

    // ---- Phase 4: DISTILL (NEW) ----
    //   Every criterion passed with evidence. Compile the exploratory path
    //   into a deterministic role-based .spec.ts from the recorded locators.
    const spec = distillSpec(feature, report);                                 // uses report.criteria[].locators
    await writeSpec(ctx, spec);            // -> <project>/e2e/<feature>.spec.ts
    const lint = await runGates([{name:"spec-lint", run:"bun run telar:spec-lint"}], ctx.manifest.root);
    if (!lint.ok) { discardSpec(spec); continue; }   // bad locators -> re-derive
    await runSpec(spec);                   // headless proof it's green deterministically

    return { state: "done", report, spec };
  }
  return { state: "needs-review", /* exhausted */ };
}
```

**Builder vs. Verifier split (hard boundary):**

| | Builder | Verifier |
|---|---|---|
| Tools | `BASE_TOOLS` = Read/Grep/Glob/**Write/Edit/Bash** (`runs.ts`) | Read/Grep/Glob + `mcp__playwright__browser_*` (NO write) |
| Account | `manifest.account` | `ctx.verifierAccount` (independent) |
| settingSources | `["project","local"]` | `[]` |
| Result schema | `Verdict` | `VerifierReport` |
| May edit source | yes | **no (enforced, §3.3)** |

**Repair loop.** Reuses the executor's existing mechanic: build a retry prompt from the failure and **resume the previous session** (executor.ts already does `resume: run.attempts[last].sessionId`). The difference: the repair context is `repairFromReport(report)` — the failing criterion's `observed`, `repro` steps, and console/network evidence — not a shell tail. The builder gets **executable evidence of the UI defect**, which is far more actionable than "gate exited 1."

**Distillation step.** `distillSpec` translates the recorded path to `@playwright/test`, cheapest-first per the substrate research: each MCP action → runner equivalent (`browser_navigate`→`page.goto`, `browser_click`→`locator.click`, `browser_type`→`locator.fill`, `browser_verify_*`→`expect(...).toBeVisible()/toHaveValue()`), every `element/ref` replaced by the `report.criteria[].locators` (already role-based via `browser_generate_locator`), every observation replaced by an auto-retrying web-first `expect`. Then harden: login lifted into a `storageState` setup project, origin parametrized via `baseURL` + relative `page.goto('/path')`, tagged `@smoke`/`@regression`, committed.

---

## 8. Deployed / synthetic monitoring

**Same agent, same specs, different origin.** Two layers, matching the two modes:

- **Distilled-spec monitoring (primary).** The distilled `.spec.ts` use relative `page.goto('/…')` and read `baseURL` from `PLAYWRIGHT_TEST_BASE_URL`. A Playwright *project per environment* (`local` / `preview` / `prod`) sets `use:{ baseURL }`. On merge, run the `@smoke` subset against the preview URL as a deploy gate; on a schedule, run `@prod-safe` against prod.
- **Exploratory monitoring.** The *same* Verifier `agent()` pass, pointed at a preview/prod URL instead of `localhost:3131`, on a schedule — catches regressions the frozen specs don't assert.

**The scheduling hook it rides.** Grounding is explicit: **no scheduler exists** anywhere in Telar (`dispatcher.ts` fire-and-forgets; every `setInterval` is UI polling). So:

1. **v1 (external trigger):** a cron (GitHub Actions `schedule:`, or a system cron) **POSTs `/api/runs`** (`apps/web/app/api/runs/route.ts`) with a **new run kind `verify` (read-only)**. This is the lowest-friction durable path and it owns its own retries, avoiding the in-memory-orphan problem (`dispatcher.ts` `active` Map has no rehydration — grounding gap).
2. **The new read-only run kind.** `RunKind` (`runs.ts:13`) is `quickfix|story|custom` and executor gives *every* run `BASE_TOOLS` (Write/Edit/Bash) expecting code changes. Add **`verify`**: mapped to `VERIFIER_TOOLS` (no write), invokes `verify()` not the builder, decides on `VerifierReport.ok`. This is the clean way to model "verify a deployed URL" — it is *not* a normal run.
3. **Project URL config (NEW).** `ProjectManifest` (`schemas.ts:67`) has no URL field. Add optional `urls?: { dev?: string; preview?: string; prod?: string }`. Persist through the three edit sites the grounding names: `schemas.ts` (`ProjectManifest`), `apps/web/app/api/projects/[name]/route.ts` (add to the raw `merged` object, lines ~66–75, so it survives the round-trip), and `apps/web/components/projects/settings-view.tsx` (`Form`/`formFromManifest` inputs). `:3131` is a pure external convention (zero repo footprint) — `urls.dev` makes it first-class.

**Prod guardrails (enforced, not advisory):**

- **Read-only journeys only against prod.** Tag prod-eligible criteria `@prod-safe`/`@smoke`; the `verify` run against `urls.prod` runs only those. They assert, never mutate.
- **Dedicated test accounts + teardown for any mutation.** Mutating journeys run against `urls.preview`/staging, or against prod only via seeded test-tenant accounts with uniquely-suffixed, namespaced data. `test.afterEach`/`afterAll` + `request.newContext()` (APIRequestContext) deletes anything created. MCP sessions run `--isolated` (`browser_close` discards the ephemeral profile) with a fresh context per test.
- **Secrets from the CI store**, never committed; a distinct `storageState` per environment.
- **Alerting.** Terminal run state `failed`/`needs-review` on a scheduled `verify` run fires a notification (**NEW** hook on the run terminal transition in `executor.ts`; grounding notes there is no alerting today). The attached trace+evidence bundle is the alert payload.

---

## 9. Integration map — files to create / touch

**Create (NEW):**
- `packages/core/src/verifier.ts` — `verify(feature, opts): Promise<VerifierReport|null>`, built on `agent()`; holds `VERIFIER_TOOLS`, the system prompt, and the Playwright MCP wiring.
- `packages/core/src/verified-loop.ts` — the build→gates→UI-verify→repair→distill orchestrator (Section 7).
- `packages/core/src/distill.ts` — `distillSpec(feature, report)`; MCP-action → `@playwright/test` translation using `report.criteria[].locators`.
- `packages/core/src/spec-lint.ts` — bans CSS/xpath/nth/`waitForTimeout` in distilled specs; run via a `spec-lint` gate.
- `apps/web/components/session/verifier-report-card.tsx` — `VerifierReportCard` (evidence bundle render; sibling of `ToolStepRow`).
- `apps/web/app/api/runs/[id]/evidence/[...path]/route.ts` — read-only static serve of the evidence dir (traversal-guarded).
- `playwright.config.ts` (per project, or template written by distill) — anti-flake config: `retries:2`, `fullyParallel`, `trace/video/screenshot`, per-env `baseURL` projects, `storageState` setup project.

**Touch (existing):**
- `packages/core/src/engine.ts` — add optional `extraMcpServers` to `AgentOpts`; merge into `mcpServers: { out, ...opts.extraMcpServers }`. (Only engine change.)
- `packages/core/src/schemas.ts` — add `Evidence`/`CriterionResult`/`VerifierReport`/`EvidenceKind`/`ReproStep`; add `ProjectManifest.urls?`.
- `packages/core/src/runs.ts` — add `verify` to `RunKind`; add `verifierReport?` to `AttemptRecord`; map `verify` kind to `VERIFIER_TOOLS` (not `BASE_TOOLS`).
- `packages/core/src/executor.ts` — insert the UI-verify phase between builder attempt and decision; branch `verify`-kind runs to `verify()`; add the terminal-state alert hook. (`maxAttempts` already exists on `ExecuteOpts` — `executor.ts:13`, defaults to `3` at `:68` — it is simply not threaded from `dispatcher.ts:27`'s `executeRun(...)` call yet; surface it through `StartRunInput` below.)
- `packages/core/src/dispatcher.ts` — thread `maxAttempts`/`verify` kind through `StartRunInput`.
- `apps/web/app/api/runs/route.ts` — accept `kind:"verify"`, `maxAttempts`, and a target env in `StartRunInput` validation.
- `apps/web/app/api/chat/route.ts` — add `send("verifier", {report})` in the verify pass; add `case "verifier"` client-side.
- `apps/web/components/session/session-view.tsx` — add `case "verifier"` to the event switch; render `VerifierReportCard`.
- `apps/web/app/api/projects/[name]/route.ts` — add `urls` to the raw `merged` object (lines ~66–75).
- `apps/web/components/projects/settings-view.tsx` — dev/preview/prod URL inputs in `Form`/`formFromManifest`.
- `apps/web/package.json` — add `@playwright/mcp`, `@playwright/test` (Bun-managed).
- `telar.yaml` (dogfood) — add `urls.dev: http://localhost:3131` and a `spec-lint` gate.

**Explicitly NOT touched:** the chat `query({options})` `agents:` seam (rejected, Section 3.1); the Codex spawn handler (`route.ts:589`) and `agentMetaFromInput`/`ParentFlattener` (`transcript.ts`) — the Verifier is not a model-spawned subagent, so the whole capture/bucketing path is untouched.

---

## 10. Open decisions & risks

1. **Playwright-MCP-as-external-stdio-server vs. a thin in-process driver.** *Decided: MCP server.* It gives the agent semantic role-based driving with zero bespoke tool code and matches the portable substrate thesis. **Risk:** spawning `npx @playwright/mcp` per verify run adds cold-start latency and a browser process; and `agent()`'s `bypassPermissions` means the MCP tools run unprompted (acceptable — they can't touch source). *Fork left open:* a future in-process `createSdkMcpServer` wrapper over the Playwright *library* (no separate process) if MCP overhead proves painful — but that loses the `browser_snapshot` ref ergonomics unless we reimplement them. Ship MCP first; measure.

2. **Codex sandbox × launching a browser.** Codex runs in its own app-server sandbox. Launching a real browser (or `npx @playwright/mcp`) from inside a Codex-provider `agent()` run may be blocked by that sandbox's process/network policy. **Mitigation:** run the Playwright MCP server as a Telar-managed sibling process (started by `verified-loop.ts`, not by the agent subprocess) and expose it to the agent as an already-running MCP endpoint; the agent only *calls* tools, never *spawns* the browser. This sidesteps both the Codex sandbox and the Claude subprocess restrictions. **Open:** confirm the Codex app-server passes MCP server configs through `agent()` identically to Claude (the grounding says `agent()` is provider-agnostic, but MCP passthrough on the Codex path needs a read of `providers.ts`/`codex-app-server.ts` before milestone 1 closes).

3. **Independence of the Verifier account.** Using a *different* account than the builder is the strongest independence guarantee but doubles account requirements. *Fork:* require a distinct `verifierAccount`, or allow same-account-different-session. **Decision:** same-account-different-session is acceptable for v1 (the tool boundary is the real guarantee); recommend a distinct account in prod config.

4. **`maxAttempts` unbounded flaky loops.** Kicking `flaky` back to exploration can loop. **Mitigation:** bound flaky re-derivations separately from build repairs; after N, escalate to `needs-review` with the flaky evidence attached.

5. **Where the dev server comes from.** The Verifier needs the app *running* at `urls.dev`. Telar does not manage the dev server today (`dev` script is plain `next dev`). **Open:** either require the user to have it running (v1) or add a Telar-managed `dev` lifecycle. v1: require running; verify with a pre-flight `browser_navigate` + health check, fail fast with a clear message if unreachable.

6. **The chat-embedded `agents` path, revisited.** We rejected it as *primary*. It remains attractive for an in-chat "verify this feature" affordance (the model spawns `subagent_type:"verifier"`). If pursued later, it needs the additive `Part.agent` role field and the `allowedTools` widening caveat (grounding gap #2/#4). Tracked, not scheduled.

7. **Trace/screenshot storage growth.** Evidence bundles accumulate under `~/.telar/runs/<id>/evidence/`. Need a retention policy (keep last N runs, or last failure per feature). Not v1-blocking.

---

## 11. Phased build plan

Each milestone is independently shippable and has its own **verifiable** done-conditions. The plan dogfoods the thesis: "done" is executable evidence, not a claim.

### M0 — Substrate spike (prove the drive loop)
Wire `@playwright/mcp` into a throwaway `agent()` call; drive Telar's own UI at `localhost:3131`.
- **Deps added** to `apps/web/package.json`; `AgentOpts.extraMcpServers` merged in engine.ts.
- **Acceptance:** an `agent()` run navigates to `localhost:3131`, calls `browser_snapshot`, clicks a real button by `ref`, and prints the resulting a11y snapshot. Confirmed by the tool-step trail rendering as `ToolStepRow`s. No source was edited (grep the working tree — clean).

### M1 — `VerifierReport` + `verify()` (independent, read-only, one feature, local)
`packages/core/src/verifier.ts` with the system prompt, `VERIFIER_TOOLS`, `disallowedTools`, `settingSources:[]`, and `VerifierReport` schema.
- **Acceptance:**
  1. Given one Telar feature's acceptance criteria and `urls.dev`, `verify()` returns a `VerifierReport` with a `pass`/`fail`/`flaky` verdict + ≥1 evidence item per criterion.
  2. **Independence proof:** a test that grants the Verifier a task requiring a source edit shows it *cannot* — the run produces no filesystem change and the report says it could not edit (asserts §3.3 enforcement).
  3. Report persists in `run.json` under `attempt.verifierReport`; a `send("verifier")` event fires and renders as `VerifierReportCard` with an inline screenshot.

### M2 — Verified loop (build → gates → UI-verify → repair)
`verified-loop.ts` inserts the Verifier phase into the executor; repair prompt built from `repairFromReport`.
- **Acceptance:** seed a deliberately broken UI feature (button does nothing). The loop: builder implements → gates pass → **Verifier fails the criterion with a repro** → builder repairs from that evidence → Verifier passes → run `done`. The transcript shows the repair was driven by the Verifier's `observed`/`repro`, and the final state is reached *only* after a passing `VerifierReport`, never on builder say-so.

### M3 — Distillation (exploration → deterministic spec)
`distill.ts` + `spec-lint.ts` + generated `playwright.config.ts`.
- **Acceptance:**
  1. A successful M2 run emits `e2e/<feature>.spec.ts` using only `getByRole`/`getByLabel`/`getByText` locators.
  2. `spec-lint` gate passes on it; a hand-injected `page.locator('.foo')` makes the gate fail (proves enforcement).
  3. `npx playwright test` runs the distilled spec green headless in <2s with `retries:2`, and its trace opens in `show-trace`.
  4. Injecting a flake (remove an `await`) makes it report `flaky`, not `pass`, and the loop kicks it back to re-derive.

### M4 — Deployed / synthetic monitoring (read-only `verify` run kind)
New `RunKind:"verify"`, `ProjectManifest.urls`, external-cron POST to `/api/runs`, terminal-state alert hook.
- **Acceptance:**
  1. `urls.preview` set in settings-view persists through the PATCH round-trip.
  2. The same distilled `@smoke` spec runs green against `urls.preview` by swapping `baseURL` — one suite, two origins, zero spec edits.
  3. A cron POST launches a `verify`-kind run that grants **no** write tools (verified by attempting an edit → refused) and decides purely on `VerifierReport.ok`.
  4. A forced red against prod fires the alert with the trace+evidence bundle attached; `@prod-safe` tagging means only read-only journeys ran (no data mutated — verified by a before/after prod-state check).

### M5 — Hardening & scale (out-of-band, not v1-blocking)
Retention policy for evidence, distinct Verifier account default, Telar-managed dev-server lifecycle, flaky-rate dashboard from JUnit reporters, durable scheduler replacing external cron (owns retries; solves the `dispatcher.ts` orphan gap).
- **Acceptance:** flaky-rate trend visible per project; evidence dir bounded; a server restart mid-verify does not strand the run (scheduler re-drives). 

---

*Grounding anchors used throughout: `engine.ts:agent()`/`createSdkMcpServer`, `schemas.ts:Verdict`/`ProjectManifest`/`ModelPolicy`, `executor.ts:executeRun`, `gates.ts:runGates`, `runs.ts:RunKind`/`AttemptRecord`/`BASE_TOOLS`, `dispatcher.ts:startRun`/`active`, `route.ts` `send()` vocabulary (`tool`/`tool_result`/`session`/`done`) + `query({options})` + `allowedTools`/`disallowedTools`/`canUseTool`, `session-view.tsx:ToolStepRow`/event switch, `store.ts:Part`, `projects/[name]/route.ts:PATCH` merge, `settings-view.tsx:Form`.*
