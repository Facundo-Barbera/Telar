**Telar Claude harness: cache, latency, accounting, and T3 comparison**

Audit date: September 8, 2026, Mexico City; evidence captured September 9 UTC. Investigation only. The recommendation is to instrument and correct a few specific seams, not replace the harness.

**Finding**

The examined Fable run does **not** support excessive prompt-cache resets as the cause of its long pauses. Across a 41.75-minute journal sample, cache-read tokens increase monotonically through 35 distinct usage snapshots; only the initial snapshot has zero cache reads. The longest gap, 255.715 seconds, is followed by 298,293 cache-read tokens and 2,696 cache-created tokens. A slow response can have an excellent cache hit.

There are nevertheless real harness defects: runtime identity is sensitive to irrelevant key ordering and insensitive to explicit environment deletion; idle eviction disregards background work; cumulative query cost is stored as turn cost; retry/rate-limit/output-usage signals are discarded; and per-delta persistence backpressures stream consumption. These are reproduced or directly traced below. Their existence does not prove they caused this particular run's pauses.

**Baselines and scope**

| Baseline | Exact revision / status |
| --- | --- |
| T — Telar current remote main | `79370cb44d458d93e818409ff76b0fbab5a92395`, verified twice with `git ls-remote origin refs/heads/main`; [pinned source](https://github.com/Facundo-Barbera/Telar/tree/79370cb44d458d93e818409ff76b0fbab5a92395). This audit worktree started clean at that SHA. |
| Installed baseline supplied by root | `79370cb4`, matching T. No source delta from that supplied baseline to current remote main. This does **not** independently attest the installed bundle or running CLI binary. No installed application was launched/restarted or altered. |
| Local branch named `main` | `892ce396`, stale. It was **not** used as current main. Dirty `dev/local-dogfood` files were not used as the baseline or edited. |
| Fable future work | `session_014be402e6cc4fc5bc49b83c8205bb9a`, branch `telar/fix-session-pause-message-attribution-an-014be4`, based on T. Session diff and later read-only Git status both showed zero changes. No future patch can be credited yet. Its pause/provenance/context changes and heavy gate remain its responsibility. |
| R — current official T3 Code | `1862686f9e42bf1d77e7f2ad03e24d7b0c7908f1`; [pinned source](https://github.com/pingdotgg/t3code/tree/1862686f9e42bf1d77e7f2ad03e24d7b0c7908f1). Fresh shallow clone in `/tmp/telar-claude-audit-t3-20260908`; remote main rechecked at the same SHA. Existing `/tmp/t3code-ref` has no Git metadata and was not trusted. |
| Agent SDK dependency | Telar lock: **0.3.257**, `bun.lock:117`; T3 lock: **0.3.260**, `pnpm-lock.yaml:1072`. Both use a selected external Claude executable, so wrapper version alone does not establish running CLI version. |

Official npm distributions were inspected without executing the SDK or provider: [0.3.257](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.257.tgz), SHA-256 `ccc63d1abbf816d30a242f8c76e006b082180910c2220916c47d44e53c8426c0`; [0.3.260](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.260.tgz), SHA-256 `6c504878a2acd478f3ece4e20771ac840d6acf7942da209149d6d3f0f94349b7`. Extracted under `/tmp/telar-claude-audit-sdk/`. SDK line references below refer to the exact 0.3.257 `package/sdk.d.ts` unless stated otherwise.

Relevant earlier investigation `session_b9ff824fd6054512934e7ac06a667c52` was inspected read-only, without resuming it. Its context/default-model and settling findings are already reflected in T (`driver.ts:525–545`, `2464–2504`). Its later popup work is unrelated. The paused #191/#198 sessions were not resumed, messaged, or modified. Root receives this completed report through the existing subscription workflow; no `sessions_send` was used.

**Measured timing and cache evidence**

The sanctioned `connectEngine(process.env.TELAR_HOME + "/engine")` client read only authorized session snapshots/events. Persisted evidence excludes prompts, assistant/reasoning text, tool arguments/results, raw frames, credentials, and configuration secrets. See [metrics-summary.json](metrics-summary.json), [the frozen sanitized Fable sample](session_014be402e6cc4fc5bc49b83c8205bb9a-sanitized.json), and [follow-up](fable-followup-sanitized.json).

Frozen sample: `2026-09-09T02:13:55.035Z`, through event **503**. Session model: `claude-fable-5-1[1m]`, effort `medium`. One engine turn remains running; a second submitted message was steered into it. Its `user_message` representation is not evidence of human authorship.

| Measurement | Result | Interpretation |
| --- | --- | --- |
| Journal span | 2,504.913 seconds / 41.7486 minutes | From first to last event, not an already completed task duration. |
| Accepted → started | 88 ms | Initial worker queue/claim is not the minute-scale bottleneck here. |
| Started → first visible item | 8,973 ms | Combined launch/initialization/provider/observation interval; no split is available. |
| Steer accepted → acknowledgement | 37 ms | Delivery acknowledgement, not proof of when the model acted on it. |
| File reads | 68; median 4 ms, p95 32 ms, max 137 ms; sum 720 ms | Engine item-envelope durations, not a process-level CPU benchmark. |
| Commands | 34; median 78 ms, p95 175 ms, max 937 ms; sum 3,238 ms | Consistent with the supplied 85/93 ms examples. |
| Recorded reads + commands | 102; summed 3.958 seconds | Under 0.2% of the sample span, but intervals can overlap and exclude time before the SDK delivers envelopes. |
| Quiet journal gaps >30 seconds | 19, totaling 2,187.689 seconds | 36.46 minutes of journal silence. Silence is not a classification of provider compute, retries, network wait, or backpressure. |
| Longest gap | Events 403→404: 255,715 ms | Next usage, event 405: input 32, read 298,293, create 2,696, output placeholder 6. |
| Other large gaps | 174,982; 167,513; 157,100 ms | Followed by cache reads 296,975; 276,311; 300,989 respectively. |
| Visible output | 41 reasoning items, 6 assistant items; 38 content deltas | Most reasoning rows contain no reasoning text. Their brief item duration cannot measure hidden/model thinking duration. |
| Permission waits | Four recorded requests, all resolved at their opening timestamp | Follow-up at 02:20:06Z found no pending request. No recorded human-approval wait explains the sample. |
| Diagnostic read latency | Snapshot 11.14 ms; event fetch 4.10 ms | A cheap read at capture time; does not prove historic writes/UI rendering were equally fast. |
| File edits / compaction | No file-change or context-compaction items in the frozen sample | Separate from earlier bare-Opus workers' compaction at 166–172k. |

Usage findings:

- **149 usage events, 35 distinct tuples.** All usage events lack provider message/request references. Identical tuples are useful to describe this sample but cannot replace API-message-ID deduplication for accounting.
- First tuple: input 2, cache read 0, cache create 98,333, output 7; reported occupancy 98,342. Last: input 32, read 319,610, create 2,964, output 3; occupancy 322,609. Cache-read values never decrease across the consecutive distinct tuples.
- The supplied event is present at event 431: `309592 / (309592 + 1868 + 32)` = **99.390% input-token cache reuse for that observation**. Its occupancy arithmetic, `32 + 309592 + 1868 + 2 = 311494`, matches Telar's implementation exactly. Output `2` is not the final response output count.
- Summing each distinct tuple once gives a **95.892% weighted cache-read proxy**, including initial warmup. This is not a verified request count, billing total, or precise hit-rate ledger. Summing all 149 events would count repeated envelopes.
- The first visible occupancy is already ~98k; later growth is ~224k. The submitted initial user message was 4,205 UTF-8 bytes. The available journal cannot attribute the initial prefix or later growth to individual instruction files, skills, tool definitions, tool results, or SDK helpers.

The command detail strings total 122,238 bytes, but Telar truncates displayed command/MCP output to 4,000 characters and does not retain file-read output in those items (`driver.ts:2998–3030`). Thus those bytes are **not** the provider's actual tool-result input size. Inferring prompt bloat from UI previews would be wrong.

**End-to-end Telar versus T3**

All T paths below are relative to Telar at the pinned T SHA; all R paths to T3 at R. `D` means `apps/engine/src/driver.ts`; `A` means T3 `apps/server/src/provider/Layers/ClaudeAdapter.ts`.

| Area | Telar T: concrete source | T3 R: actual Claude path | Finding |
| --- | --- | --- | --- |
| Driver ownership | `apps/engine/src/drivers.ts:83`, worker `driverFor` at `worker.ts:1043` | `provider/Drivers/ClaudeDriver.ts`; `A:1947–1977` | Both hold provider objects across turns; Telar does not construct a new driver per tool call. |
| Process/query lifetime | `D:2039–2149`; `claude-runtime.ts:39–76` | `A:4205–4215,4742–4780,4850–4870` | Open async input feed and one query per live session in both. |
| CLI launch discovery | `D:1138–1144`; `cli-resolution.ts:328–349,648–655` | `provider/Drivers/ClaudeExecutable.ts`; `A:4673` | Telar's uncached version probe is synchronous, capped at 10 seconds and cached by executable/mtime. It can affect startup/embedded-engine responsiveness, but cannot explain repeated minute gaps inside this already running turn. No live version probe was intentionally invoked by the audit. |
| Output ownership | `D:2265–2780,2797–2980`; shared pending iterator promise | `A:3976–4004` single `runSdkStream` fiber | Telar switches between foreground and idle pumps and duplicates normalization. T3 has one session consumer. |
| Warm continuation / history | `worker.ts:487,656`; `D:2073,2185–2240` | `A:4689–4691,4985–5010` | Pushes only the new message. No application replay of the whole Telar journal per call. Cold resume is CLI-owned history loading. |
| Config identity | `D:1888–1919,2149–2174` | `orchestration/Layers/ProviderCommandReactor.ts:767–820` | Telar uses raw JSON fingerprint; T3 explicitly checks cwd/runtime mode/instance/model selection. |
| Model switch | `D:2154–2173` | `A:4902–4911`, plus reactor `:782–795` | Both adapters support `setModel`; T3's upstream reactor nevertheless restarts Claude for a changed requested model selection. Adapter capability alone is misleading. |
| Effort / speed | `D:1891–1894,2066–2069` | `A:4626–4690`; reactor `:782–820` | Changes can cause process recreation in both. SDK 0.3.257 already exposes live `applyFlagSettings` (`sdk.d.ts:2671`), but changing effort still changes provider prompt-cache identity. |
| Stop | `D:2246–2258,2755–2775` | `A:5021–5028,4039–4116` | Telar tries interrupt, then destroys after 10s; T3 Stop closes the whole session. These are different user contracts. |
| Idle resource policy | `claude-runtime.ts:286–301,315–322` | `provider/Layers/ProviderSessionReaper.ts:17–18,65–96` | Telar prunes on new adoption; ignores background work. T3's 30-minute inactivity sweep skips active turns and background liveness. |
| MCP selection/order | `state.ts:6257–6274`; `protocol/common.ts:563`; `D:488–510,1936–2032` | `A:4660,4702–4714`; `mcp/McpProviderSession.ts:12–23` | Telar registers user servers, browser HTTP server, and in-process toolkits; T3 uses its per-thread HTTP MCP server plus native settings. No proof either transmitted a changing tool list in the Fable sample. |
| Browser URL/token | `worker.ts:570–591`; `D:2006–2020` | `A:4704–4714` reads stored per-thread endpoint/header | Telar's browser lease is stable per session. Per-turn callback replacement does not itself rotate its token. Header/URL changes are transport config, not automatically model-visible prefix changes. |
| Settings / environment | `provider-instances.ts:124–132`; `D:2078–2085` | `A:4674–4680,4699`; `A:1416–1420` | Telar preserves native configuration; T3 explicitly lists user/project/local. Omitting `settingSources` **does load all three in SDK .257** (`sdk.d.ts:2051–2061`); this is not a Telar bug. |
| System prompt | `D:2055–2057`; `browser/briefing.ts:2` | `A:4674–4678`; `provider/RuntimeInstructions.ts:2–12` | Telar selects Claude's full preset only when browserSocket exists; otherwise SDK minimal default. T3 always selects the preset with a short runtime note. Conditional behavior deserves a small consistency fix, not attribution of this run's pauses. |
| Attachments/results | `D:401–419,2690–2706,3015–3030` | `A:1470–1535,4662–4669` | Both inline image bytes; T3 reads them asynchronously, Telar synchronously. Non-image Telar attachments are paths. Preview truncation does not constrain what Claude saw. |
| Compaction | `D:2365–2439,2464–2469`; `D:535–543` | `A:3420`, `A:5133`; `packages/shared/src/claudeCompaction.ts` | CLI owns compaction. Telar forces the 1M eligibility env and a 1M meter floor for recognized families; its max-based meter can contradict actual limits. #200/Fable overlap, not evidence of cache resets. |
| Usage scope | `D:1077–1125,2469,2591–2603`; `state.ts:7849`; web `lib/engine/journal.ts:310` | `A:2676–2691,2617–2624` | Telar's UI replaces usage snapshots, not sums them. It drops `message_delta` usage and stores query cumulative USD with turn tokens. T3 retains separate result/model usage and handles message-delta usage. |
| Retry / limits | No `api_retry` or `rate_limit_event` handler in D | `A:3675–3688,3858–3898` | Telar makes SDK wait/retry states invisible. T3 surfaces retry heartbeat and rejected-limit state. Neither means an application should add another retry loop. |
| Persistence/backpressure | `D:1658–1671,2568–2572`; `worker.ts:783–790`; `state.ts:8060–8090` | `A:1959–1977` unbounded event queue; `A:3991` consumer | Telar awaits HTTP observation persistence per delta; journal append/chmod is synchronous. T3 decouples downstream ingestion via a queue, which still has memory/backlog tradeoffs. |
| UI delivery | `session-cockpit.tsx:1130–1178,1683–1685` | `orchestration/Layers/ProviderRuntimeIngestion.ts:1671–1700`; contracts `settings.ts:925–931` | Telar polls each second and prevents overlapping tails. T3 **defaults to buffered assistant delivery**, with legacy token streaming opt-in. Neither source establishes T3 is empirically faster. |
| Usage-report cache | `apps/engine/src/usage.ts:129–164,679–700` | `usage/usageTranscripts.ts:94–148`; `usage/usageAggregation.ts:116–121` | Both scan provider transcripts and deduplicate message/request pairs, separately from prompt caching. Both keep first duplicate; synthetic updated-later usage is therefore lost. |

**What actually changes a cached prefix**

Three unrelated caches must stay separate: Telar's live-process pool; its transcript/usage/UI caches; and Anthropic's server-side prompt-prefix cache. Restarting a local process does not issue a provider cache-clear operation. Conversely, keeping a process alive cannot preserve a prefix after a material prompt/configuration change or cache expiry.

The documented prefix order is tools → system → messages. Altering tool definitions affects all subsequent content; altering system content affects it and messages. Message edits or changed image presence affect message caching. Stable appended turns/tool results can extend an existing prefix. Matching is exact, subject to model, breakpoint, minimum-length, TTL, and account/workspace boundaries. A new cache creation count may simply be the newly appended suffix. [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Thinking configuration and resolved effort are rendered into the model prompt; changing either can invalidate more than the message portion, depending on model. Keeping them fixed permits reuse. Saving a process launch with live settings controls therefore does not promise a cache hit after effort changes. [Anthropic thinking and caching](https://platform.claude.com/docs/en/about-claude/models/extended-thinking-models).

MCP definitions are deferred by default in current Claude Code, so serialized catalog bytes are not automatically input tokens. Compaction and tool-result clearing rewrite conversation content and can create expected cache rebuilds. [Claude Code context management](https://code.claude.com/docs/en/how-claude-code-works). Native `/usage` distinguishes expected rebuilds and cache misses in CLI 2.1.251+; likely-cause diagnostics require 2.1.260+. This audit did not invoke commands in the active session. [Claude Code usage diagnostics](https://code.claude.com/docs/en/costs#prompt-cache-statistics).

Neither harness constructs the final Anthropic request or chooses its breakpoints here; the SDK/CLI does. Native settings, hooks, CLAUDE.md, auto-memory, plugins, server instructions, and provider routing remain possible contributors. Their live contents were intentionally not read. Telar's raw fingerprint neither proves equality of the fully rendered provider prefix nor detects every on-disk settings change. Some settings can hot-load inside Claude without any Telar fingerprint change.

**Confirmed defects and limitations, in priority order**

1. **P1 — observability gap prevents defensible diagnosis.** Fake SDK frames for `system/api_retry`, `rate_limit_event`, final `message_delta.usage`, and result duration fields produce no timing/limit/usage observations. The live sample cannot distinguish hidden thinking, provider queue/prefill, network/retry sleep, or delayed ingestion. Add sanitized per-request IDs and monotonic lifecycle timings before tuning cache TTL or replacing the provider layer. Preserve final output usage, retry attempt/status/delay, context-reset markers, query generation, and explicit scope of token/cost snapshots. Do not persist raw prompts or headers.

2. **P1 — fingerprint is not semantic process identity.** Fake turns differing only in environment/header key order create **two** queries; the same order-sensitive issue exists for server arrays. Re-stamped `createdAt`/`updatedAt` and labels correctly reuse one query. Conversely, `env:{}` and `env:{AUDIT_DELETE:undefined}` serialize identically; the fixture retains the inherited synthetic value despite the requested deletion. Canonicalize objects, preserve meaningful array order such as command arguments, sort unique server entries only after resolving precedence, and explicitly encode deletion. Live incidence is unmeasured. The opt-in runtime debug line at `D:2152` prints the whole fingerprint, including environment values and browser credentials; replace it with redacted changed-field names/digests before enabling it in a live diagnostic run.

3. **P1 — idle pool can destroy useful background work.** Five sequential fixture sessions leave four idle runtimes and evict the oldest despite its running background task. The declared cap of three is enforced only on adoption, before the newcomer becomes idle; release does not enforce it, so concurrent releases can exceed it further. An idle-pump provider wake also does not mark `busy=true`. Protect both active consumers and background liveness, then enforce a documented resource policy. This cannot explain the sampled foreground turn's repeated gaps because it remains busy.

4. **P2 — query cost masquerades as turn cost.** In one live fake query, successive cumulative result costs `$0.10` and `$0.30` become two turn costs whose naive sum is `$0.40`, although total query spend is `$0.30`. Tokens remain per-turn. SDK .257 explicitly documents this difference (`sdk.d.ts:4884–4894`). Track query generation/reset epochs and cost/model-usage deltas, preserving prior totals on crash-zero results. Do not attribute this to actual provider overbilling: the main Usage page scans transcripts independently, and no cumulative-cost summation defect was established in that page. A running turn's repeated assistant envelopes are also not a spend ledger. [SDK accounting scopes](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

5. **P2 — stream consumption is coupled to observation latency.** Forty synthetic text deltas generate 41 sink batches. Near-zero sink cost completes in under 1 ms; a 5 ms delayed sink takes about 250 ms. This proves backpressure, not a measured 250 ms production overhead. The Fable sample has only 38 emitted deltas, so a normal few-ms sink is insufficient to explain dozens of minutes. Add bounded coalescing and sink timing; keep tool/permission/terminal events ordered and prompt. A slow engine could also delay SDK permission callbacks, so measure both channels.

6. **P2 — incomplete normalization across two pumps.** The idle `pumpFrame` omits the foreground pump's usage/compaction handling. Provider-initiated wake completion closes with text/failure only. Its generation's cost baseline and context state can be lost even if foreground accounting is repaired alone. Consolidate normalization around a single session consumer after Fable's provenance/stop patch is available; preserve tested turn/request ownership semantics.

7. **P2/P3 — context and footprint issues need narrower fixes.** The current 1M meter floor and output placeholders are presentation/accounting concerns already overlapping #200/Fable. There is no sampled compaction, no model/effort switch, and no repeated user-history replay. A synthetic normal toolkit registration (spool/sessions/display/warp) is 35 tools / **39,693 JSON bytes**; adding data-science and LaTeX yields 66 / **58,830 bytes**, before browser/user tools. These are catalog bytes, not token estimates or live Fable configuration. Shrink redundant tool prose and bound large tool responses where useful; do not delete capabilities based on these numbers alone. A browser-less session's minimal system prompt is an independent behavior inconsistency. [SDK system-prompt defaults](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts).

The transcript fixture also shows first-wins deduplication ignoring a later output update for the same message/request pair (2 → 100 stays 2). Both projects share this policy. This is a **conditional limitation**, not proof that installed Claude writes such updated rows or that its real Usage report undercounts output. Equal repeated cache-read/create counters are correctly counted once by the scanner. Live transcript contents were not inspected for this case.

**Smallest optimization plan**

1. Keep Fable's current lane isolated; do not layer competing pause/provenance/context edits on its unfinished work. Review its eventual diff against T and update overlap explicitly.
2. First small patch: safe diagnostic metadata, typed usage scopes, API-message identity, final output usage, retry/limit state, and timings around query creation/feed submission/SDK receive/observation send/ACK. Capture only whitelisted scalar values. Browser/UI adds received/painted timestamps and event IDs. Avoid the existing raw fingerprint debug output.
3. Second small patch: canonical effective fingerprints with explicit deletion; protect background/provider-wake runtimes; fix cap enforcement. Keep genuine cwd/instance/MCP/toolset changes as cold-resume boundaries.
4. Correct cumulative USD/model totals using per-query baselines and reset epochs; ensure autonomous wake turns pass through the same accounting. Preserve per-call inputs/cache counts and authoritative final output separately from context occupancy.
5. If measured sink time is material, coalesce text deltas on a short interval (e.g. 20 ms) or byte threshold, with a bounded queue and immediate ordered barriers for tool/request/result events. Do not copy T3's unbounded queue blindly or confuse its default buffered UI with provider performance.
6. Only after measurement, consider live `applyFlagSettings` for effort/fast-mode changes (SDK compatibility tested), asynchronous image reads, stable explicit full system preset, and shorter toolkit descriptions. More 1M context is not inherently a latency optimization; task-scoped reads and smaller outputs may matter more than increasing cache TTL. No blanket compaction suppression, cache warming loop, or speculative harness rewrite is justified.

**Regression and benchmark protocol**

The fake-SDK [harness-fixtures.ts](harness-fixtures.ts) calls the actual pinned Telar driver, with fake executable resolution and fake provider output. [fixture-results.json](fixture-results.json) contains 16 result groups: continuity/cost, ten configuration cases, idle eviction, two sink-speed cases, tool catalog sizes, and transcript deduplication. No paid provider was invoked.

Reproduction requires only Zod 4.4.3, installed under `/tmp/telar-claude-audit-deps`; diagnostic tsconfig maps it and the worktree engine-client source. Run from this audit worktree:

```sh
bun --tsconfig-override diagnostics/claude-audit/tsconfig.json diagnostics/claude-audit/harness-fixtures.ts
bun test --tsconfig-override ./diagnostics/claude-audit/tsconfig.json ./apps/engine/test/driver.test.ts --test-name-pattern 'two turns of one session|a re-stamped MCP|a model change on a live|usage and cost are reported|the meter moves DURING'
```

The selected existing tests passed: **5 pass, 0 fail, 79 filtered, 16 assertions, 72 ms**. Fixture assertions passed. They document current defects, so corrected code should intentionally change those expectations. Bun 1.3.11 emits a tsconfig “directory mismatch” warning but executes successfully.

Execution exception: an earlier command placed the tsconfig flag before `test`, which Bun resolved to the root package's test script. The unintended core suite exited in **4.56 s**, with 407 passes, 104 failures and 96 errors, principally missing dependencies; it never reached the engine gate. A stop was issued, and the process was already exited. It is not a valid full-gate result. No full gate, T3 build, GUI acceptance, production changes, commit, PR, deploy, application restart, or paid-provider benchmark is claimed.

For proposed fixes, extend the fixtures with semantically identical key permutations, explicit deletion, changed CLI identity, token rotation, model-control failure, config changes during steering, clean/unclean interrupt, pending iterator handoff, background wake during eviction, duplicate assistant IDs, cumulative cost across three turns, cold resume resetting cost, `/clear` reset, crash-zero result, compaction followed by new usage, slow/erroring sinks, and content-byte accounting. Assert exact query counts, no lost/doubled frames, one normalized usage record per API response, correct cost deltas, bounded buffering, ordered completion, and prompt delivery of non-text events. Use injected clocks/delays; compare baseline and candidate under identical sinks. Heavy repository gates remain with the assigned worker/root.

**Paid-provider pilot proposal — NOT executed; root approval required before any calls.** A later separate scratch experiment could compare actual Telar driver, actual T3 Claude adapter, and bare SDK at the same selected CLI/model, each with two short user turns on one query: **three query processes, six top-level turns**, no tools/subagents/hooks, no existing session resume, one fixed synthetic document, identical system/config, and exact same inputs. Set `maxTurns:1` for each turn and a **$0.25 cumulative SDK budget per query**, with a **$0.75 estimated total allocation**, 60-second wall limit per turn and one overall run only. No `/clear`, auto-retry by the harness, or follow-up probes. SDK/network retries can still create more wire attempts, and budget checks can overshoot by the final request; root must accept that bounded uncertainty or decline the pilot. SDK cost estimates are not invoices. If safe output/request limits cannot be confirmed for the selected CLI, do not run.

That pilot measures startup, warm-turn latency, cache reuse and facade overhead at a fixed small context; it does not reproduce a 300k-context coding task. A second paid test for context-size effects or cold-resume/TTL behavior needs a separately priced, explicitly approved scope. Capture request/response IDs, read/create/input/final-output usage, SDK retry timings, query duration, sink ACK and UI paint latency where applicable. Report medians only across genuinely repeated comparable samples; six turns are a smoke comparison, not a statistically reliable performance ranking.

**Evidence boundaries**

The actual running Claude binary version, provider endpoint, native prompt/settings/MCP expansion, per-request wall timings, retry counts, network timings, real provider tool-result sizes, hidden thinking duration and bill remain unknown. The sample supports strong cache reuse, rapid recorded tool completion and long unexplained intervals; it cannot assign those intervals to one cause.

Official Anthropic pages above were accessed through the web tool on the audit date. They are moving, unversioned documentation, not immutable versioned source. Direct `.md` downloads returned 403, recorded in [official-docs-manifest.json](official-docs-manifest.json); no document hash or historic revision is invented. SDK behaviors with immutable version support were cross-checked against the downloaded .257/.260 package declarations. No third-party explanation is used as evidence.

All intentional audit artifacts are under `diagnostics/claude-audit/` in this isolated worktree, with dependencies/reference sources in the named scratch directories. Existing installed data, credentials, source checkouts, paused workers, and Fable's worktree were not edited.
