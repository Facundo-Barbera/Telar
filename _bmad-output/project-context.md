---
project_name: 'telar'
user_name: 'Facundo'
date: '2026-07-17'
sections_completed: ['technology_stack', 'moat', 'design_law', 'core_web_boundary', 'framework', 'data_state_secrets', 'ui_status_tone', 'testing', 'code_quality_workflow']
existing_patterns_found: 14
status: 'complete'
rule_count: 33
optimized_for_llm: true
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

---

## Technology Stack & Versions

**Monorepo** — Bun workspaces (`apps/*`, `packages/*`). **Bun only** — no npm/yarn/pnpm;
`bun.lock` (lockfileVersion 1) is the single lockfile and is protected (mutate only via `bun install`/`bun add`).

| Part | Key tech & exact versions |
| --- | --- |
| `packages/core` (`@telar/core`) | TypeScript `^6.0.3`, ESM (`"type":"module"`), **no build step** (`exports["."] → ./src/index.ts`), `zod ^4.4.3`, `yaml ^2.9.0`, `@anthropic-ai/claude-agent-sdk ^0.3.204`. Tested with `bun test`. |
| `apps/web` | Next.js **`^16.3.0-canary.80`** (App Router), React `19.2.4`, TypeScript `^5`, Tailwind v4, shadcn `^4.13.0` on `@base-ui/react ^1.6.0`, Vercel `ai ^7.0.17`, `streamdown ^2.5.0`, `zod ^4.4.3`. Consumes core via `workspace:*`. |
| `apps/desktop` | Electron `^43.1.1`, electron-builder `^26.15.3`. **mac/arm64 only.** |

- **TypeScript is NOT version-unified**: web pins `^5`, core pins `^6.0.3`. Never assume a single repo-wide TS version.
- **No `"engines"` pin, no `.nvmrc`/`.bun-version`.** No root `scripts` block — every command runs *inside* a workspace dir.

## Critical Implementation Rules

### The Human-Accept Moat (highest-priority invariant)
- Loom lifecycle: `scope → orchestrate → build → verify → (repair) → ready → human accept → done`.
- `ready → done` is a **human-only** transition. There is **no agent-callable `accept` tool anywhere**.
  NEVER add one, and never add an auto-accept path — the moat is structural, enforced twice:
  - `packages/core` enforces it by construction (`looms.ts`, `tick.ts`).
  - `apps/web` re-enforces at the tool layer: `app/api/chat/route.ts`'s `PreToolUse` hook force-routes
    `mcp__loom__start_loom` / `mcp__loom__answer_blocked` (and loom-affecting calls) through an interactive
    permission card in *every* SDK permission mode.
- The **Verifier stack is capability-walled**: no write/edit tools are granted to `verifier.ts` / `verify-thread.ts`
  / `critic.ts` / `panel.ts`. NEVER grant them write tools — a passing verdict must be un-self-issuable.

### Design Law: deterministic control flow in code, intelligence in the leaves
- Scheduling/repair/escalation decisions (`tick()`, `decide()`, `rollupWeave`, `decideRepairContinuation`) are
  **pure functions** over integers, sets, and injected clocks. Keep them pure and deterministic.
- LLM calls are isolated behind schema-forced `agent()` invocations (zod-validated `emit_result`) with explicit
  tool allow/deny lists. Push all non-determinism (clocks, randomness, model calls) to injected seams / agent leaves —
  never inline it into a control-flow function.

### Core ↔ Web boundary (CLIENT-BUNDLE RULE)
- `@telar/core` is **server-side only** (uses `fs`, `child_process`, the Agent SDK). Client components import
  **types only** from `@telar/core` (erased at build); never its runtime code.
- Runtime core code lives only in Route Handlers (`app/api/**/route.ts`), Server Components, and `instrumentation.ts`.
- Server Components that read the on-disk registry/manifest must set `export const dynamic = "force-dynamic"`.

### Next.js (framework)
- This is Next **16 canary** — APIs/conventions differ from training data. Read `node_modules/next/dist/docs/`
  before writing Next-specific code (see `apps/web/AGENTS.md`). Heed deprecation notices.
- **App-Router-as-backend, in-process monolith.** All server surface is `app/api/**/route.ts`. There is
  NO `pages/api`, NO `"use server"` Server Actions, NO `middleware.ts`. `next.config.ts` sets `transpilePackages: ["@telar/core"]`.
- **No auth layer, by design** (local single-user cockpit). Do not add auth/session/API-key checks in isolation.
- **No global client-state library** (no Redux/Zustand/Jotai/SWR/React Query). Pattern: `useState`/`useEffect` + `fetch()`
  the app's own API, refetch on mount + on the `window "telar:refresh"` event + a poll interval while something runs.
  UI-only prefs live in `lib/ui-prefs.ts` (`useSyncExternalStore` + `localStorage`) — it must never write engine state.
- **SSE is hand-rolled.** `POST /api/chat` returns a raw `ReadableStream` of `event:/data:` frames consumed via
  `lib/sse.ts consumeSSE()`; GET tail endpoints use the browser-native `EventSource`. Don't introduce an EventSource
  polyfill or the `ai` SDK's `useChat`. In-process MCP servers (`lib/loom-mcp.ts`, `lib/ultra-mcp.ts`) run with no separate transport.

### Data, State & Secrets
- `TELAR_HOME` is the entire state root (`~/.telar` default; the web `dev` script defaults to `~/.telar-dev` for isolation).
  All engine state is filesystem-backed under it.
- **Atomic writes only**: write to `.tmp` → `fs.renameSync` (see `manifest.ts atomicWrite`, `accounts.ts`, `secrets.ts`). Follow this idiom for any state write.
- `credentials.json` — chmod `0600`, re-chmod on every write, holds tokens: never hand-edit, never log or surface a token.
  `accounts.json` is secret-free and safe to read; mutate it via `upsertAccount`/`removeAccount`/`setDefaultAccount`, not by hand.
- **No single global `ANTHROPIC_API_KEY`.** Auth is a multi-provider account system. `accountEnv()` (`engine.ts`)
  **deletes** `CLAUDE_CONFIG_DIR` for an account with no `configDir` (not merely "skips setting it") — an inherited
  ambient value silently leaks the wrong login (the "personal silently resolves to work" bug). Don't set `configDir` on `personal`.
- zod schemas for persisted entities are **owned by `@telar/core`** — reuse them; don't redefine shapes in `apps/web`.

### UI status/tone (unobvious)
- The single status vocabulary is `components/looms/status.tsx`: `Tone = "done" | "attention" | "danger" | "active" | "muted"`,
  rendered via `statusVisual()` / `StatusBadge`. Reuse it — don't invent per-component status colors.
- Color is a **quiet state signal, never a highlighter**: only the icon (and, for a real failure, the label) carries a hue;
  the badge stays a neutral outline. Active build/verify use a neutral spinner, never a saturated hue.

### Testing
- `bun test` (`bun:test`) is the **only** test tooling. Auto-discovers `*.test.ts`. No jest/vitest.
  Core specs in `packages/core/test/` (98 files); web specs colocated in `apps/web/lib/*.test.ts` (9 files).
- Playwright is **Verifier infrastructure, not a dev e2e suite** — there is no `playwright.config.*` and no human-authored `*.spec.ts`.
- `bunfig.toml` `pathIgnorePatterns = ["**/release/**","**/.next-desktop/**"]` keeps stale build-output test copies out of
  discovery — don't remove it.
- **No CI exists.** Run `bun test`, `bun run lint` (web), and `bunx tsc --noEmit` manually before committing.
  Write tests for new core/web logic.

### Code Quality & Workflow
- **ESLint** flat config exists only in `apps/web` (`eslint-config-next` core-web-vitals + typescript); none in core/desktop.
  **No Prettier/Biome** — formatting is not automated, so match surrounding style exactly.
- Non-obvious modules carry **WHY header-comments** (auth/security, atomic-write idioms, isolation guarantees). Follow this
  pattern when adding comparably subtle logic. Use `cn()` (`lib/utils.ts`) for Tailwind class merging.
- Add deps with `cd <workspace> && bun add <pkg>` — never hand-edit the lockfile. There are no root scripts; run everything per-workspace.
- Commits: conventional prefixes (`feat/fix/chore/refactor/docs/test`) with a scope (`fix(core)`, `fix(web)`), explaining WHY.
- Ship the desktop app only from a pristine **origin** snapshot (`scripts/build-desktop.sh`), never the working tree.
  `--smoke` is a fail-closed gate (must print `SMOKE_OK`).

---

## Usage Guidelines

**For AI Agents:**

- Read this file before implementing any code.
- Follow ALL rules exactly as documented. When in doubt, prefer the more restrictive option.
- The Human-Accept Moat and the Verifier capability wall are non-negotiable invariants — never weaken them.
- Update this file if new load-bearing patterns emerge.

**For Humans:**

- Keep this file lean and focused on unobvious, agent-relevant rules.
- Update when the technology stack or a structural invariant changes.
- Review periodically; remove rules that have become obvious.

Last Updated: 2026-07-17

