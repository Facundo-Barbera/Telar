# Review — reality check on committed decisions

**Lens** (configured `finalize_reviewers[0]`): verify every committed decision was web-researched or reality-checked rather than asserted from training data — current versions, that each named technology exists and fits, live starter defaults. Flag anything that could be out of date and was not confirmed against the web, the existing project, or the current starter.

**Verdict:** PASS on the stack — CHANGES REQUIRED on two decisions asserted without checking what the repo already has.

---

## Stack — confirmed against the project (the strongest available source)

Every Stack row was read from the actual `package.json` files at review time, not recalled. Greenfield-starter verification does not apply: this is brownfield, and the repo is the authority on its own pins.

| Row | Confirmed in | Match |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk ^0.3.204` | `packages/core`, `apps/web` | exact |
| `zod ^4.4.3` · `yaml ^2.9.0` | both workspaces | exact |
| TypeScript `^6.0.3` (core) / `^5` (web) | respective `package.json` | exact — the non-unification is real, not a typo |
| `next ^16.3.0-canary.80` | `apps/web` | exact |
| `react` / `react-dom` `19.2.4` | `apps/web` | exact, unranged pin |
| `@base-ui/react ^1.6.0` · `shadcn ^4.13.0` | `apps/web` | exact |
| `ai ^7.0.17` · `streamdown ^2.5.0` | `apps/web` | exact |
| `electron ^43.1.1` · `electron-builder ^26.15.3` | `apps/desktop` | exact |
| Bun workspaces, `bun.lock` v1 | root `package.json`, lockfile | exact |

**Note, not a finding:** `next` is pinned to a canary. That is a deliberate, documented project choice (`project-context.md` instructs reading `node_modules/next/dist/docs/` because APIs differ from training data). The spine ratifies it rather than proposing an upgrade — correct for a spine, which does not own dependency currency.

## R1 — AD-18 invents a ledger the repo already has (critical)

AD-18 committed a new root-level `spend.ndjson`. The repo already ships `~/.telar/usage.ndjson` — an append-only ledger written by `logUsage()` in `apps/web/lib/store.ts`, with `UsageEntry = {ts, account, model, sessionId, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, costUsd}`, plus `usageSummary()` and `plan-usage.json` reading from it.

This was asserted from the SPECs rather than checked against the code. The irony is exact: an AD written to stop three counters from disagreeing would have created a fourth. **Fix: AD-18 extends `usage.ndjson` with owner attribution; it does not create a second file.**

## R2 — `store.ts` does not honor `TELAR_HOME` (high, pre-existing)

The spine states as invariant that "`TELAR_HOME` is the entire state root." Every module checked honors it via `process.env.TELAR_HOME ?? path.join(os.homedir(), ".telar")` — `manifest.ts`, `looms.ts`, `session-log.ts`, `permissions.ts`, `vcs.ts`.

`apps/web/lib/store.ts:8` alone hardcodes `path.join(os.homedir(), ".telar")`. So `chats.json`, `usage.ndjson` and `plan-usage.json` do **not** isolate when the web `dev` script points `TELAR_HOME` at `~/.telar-dev`.

This is a pre-existing defect, not something the spine introduced — but it becomes load-bearing the moment AD-18 builds the spend ledger on `usage.ndjson`, because dev runs would then write spend into production state. **Fix: record as a named open item bound to AD-18's story.**

## R3 — `MAX_CONCURRENT = 4` verified, and it is process-wide (informational, already acted on)

Checked rather than assumed: `engine.ts:89` is a module-private process-wide gate every schema'd `agent()` call joins; `ultra/executor.ts` stacks a separate run-local cap of 3 on top; `schemas.ts:341` defaults `Budget.maxAgents` to 12. The collision AD-17 addresses is real and confirmed in code, not inferred from the SPEC's prose.
