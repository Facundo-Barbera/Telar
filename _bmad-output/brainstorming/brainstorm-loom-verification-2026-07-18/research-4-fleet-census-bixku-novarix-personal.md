# Research 4 — Fleet Census (bixkuOS · Novarix · Focaltec/portal · personal)

> Scout report, 2026-07-18. Read-only census for the loom-verification brainstorm.

## Summary table

| Project | Type | Boot complexity | DB | Secrets | Verify surface |
|---|---|---|---|---|---|
| **bixkuOS** | Monorepo web + sidecar + native | High — 3 coordinated processes + env-derivation script | Local (Supabase CLI) | ~8 | HTTP :3000 (UI, /mcp, /api SSE) + WS :7681 |
| **Focaltec/portal-de-clientes** | Legacy Java WAR + Lambdas + CRA SPA | Very high — private CodeArtifact Maven repo, Tomcat, multi-AWS | Remote (MySQL+Mongo) | ~7+ | Spring REST + SPA :3000, only behind full external stack |
| **Novarix/inboxdigest** | Next.js app | Medium — single dev cmd, but live Google OAuth + remote DB | Remote (Supabase cloud via Drizzle) | ~7 | :3000 + Gmail-gated APIs |
| **Novarix/novarix-landing** | Static Next.js i18n site | Low | None | 0 | :3000 render check |
| **Novarix/texassitepreparation** | Vite static + 1 serverless fn | Low-med — fn needs `vercel dev`, not `vite dev` | None | 1 | :5173 render; /api/quote only under vercel runtime |
| **personal/claude-test** | Script sandbox (Agent SDK) | N/A — no server | None | SDK auth | script exit/stdout |
| **personal/estudioSam** | Static-site build tool | Low — build-only, opens via file:// | None | 0 | static file output check |
| **personal/greenfield-demo** | Minimal Next.js (has telar.yaml fixture) | Low | None | 0 | :3000 render check |
| **personal/ticher** | Placeholder (one .py) | N/A | None | 0 | stdout check |

## Load-bearing details

### bixkuOS (the hard local case)
- Topology: Next.js web :3000 · Node sidecar (WS :7681, PTY-wraps `claude` CLI, HMAC token) · Supabase CLI stack (Postgres 17 + Auth + Realtime + Storage + Studio + Inbucket; ports 54320-54329 hardcoded in `supabase/config.toml`) · Apple native app (out of scope).
- `portless.json` = the `portless` dev-proxy (friendly hostnames, cosmetic — not an orchestrator).
- 13 SQL migrations; `config.toml` references `./seed.sql` which is MISSING → fresh reset seeds 0 rows.
- `scripts/setup-mcp-env.sh` derives secrets by shelling into `supabase status` + `docker exec supabase_db_bixkuOS psql` — assumes a specific running container name + specific owner email. Env: ~8 secrets, ~9 config vars.
- No tests, no e2e config.
- **Standup risk:** three coordinated processes + live-derived env; bare `bun dev` boots a web app with no working Supabase, no MCP secret, unseeded DB.

### Focaltec/portal-de-clientes (the wall)
- Maven build gated behind **credentialed private AWS CodeArtifact** — `mvn install` fails without AWS auth, before any server can exist. MySQL + MongoDB + S3 + SES + SQS + Secrets Manager + Finkok + Multipagos + Pusher. No compose file, no local port for the WAR (external Tomcat).
- Verdict class: not locally standable-up without pre-provisioned credentials; remote-first project.

### inboxdigest (the OAuth wall + doc drift)
- Docs say SQLite + Claude CLI; code says remote Supabase Postgres (Drizzle, pooled 6543/direct 5432) + OpenRouter. 30MB stale sqlite db in `data/`. README boot instructions cannot be trusted → recipes must be derived from code/env, not docs.
- Gmail OAuth needs a human-consented test account with a live refresh token (7-day expiry in Testing mode) — not headlessly scriptable.

### texassitepreparation (the runtime-mismatch trap)
- `bun dev` (vite) never boots `api/quote.js` — verifying the form requires `vercel dev` instead of the documented dev command. Recipe must know which runtime hosts serverless fns.

## Cross-cutting patterns
1. Majority happy path: single `next dev`-style command, one port, no DB, zero/low secrets.
2. Two real orchestration outliers: bixkuOS (local multi-service) and Focaltec portal (remote/credentialed).
3. A standup-risk class exists that CANNOT be fully automated: OAuth-consent walls, private-registry credentials. Recipes must be able to say "requires pre-provisioned X" and fail closed at readiness.
4. **Doc/code drift is real** (inboxdigest): recipes must be derived from code + env examples, cross-checked, never trusted from READMEs alone.
5. Non-service shapes exist (build-tool, script sandbox, placeholder): verification = run-to-completion + artifact/stdout check — the `cli-harness`/`artifact-assert` strategies, no lab needed.
