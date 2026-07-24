# Research 6 — Deep-Dive: Focaltec/orchestrator & Ozom/ozom-gv

> Scout report, 2026-07-18. The two most-active projects, surveyed as loom-standup targets. file:line refs verified by the scout.

## Focaltec/orchestrator (the polyglot stress test)

- **Topology**: 5 units — FastAPI backend :8000 (Python 3.12, uv, uvicorn), Vite dashboard :5173, FastMCP service :8001, Postgres :5432 + pgAdmin :5050 via docker-compose. Bun workspaces + Turborepo fan-out.
- **`portless` + `sudo` hard dependency**: root AND per-workspace dev scripts all route through the machine-global portless proxy (needs sudo for :80/:443). No runnable no-portless fallback documented anywhere — a lab recipe must hand-assemble direct commands (`uvicorn … --port 8000`, `vite`) bypassing the wrappers.
- **The documented seed path is BROKEN**: docker-compose's `db-setup` container lacks `cryptography` + `ENCRYPTION_KEY`; `seed.py` calls `encrypt_credentials()` mid-seed → raises → **partially-seeded DB**. The working path (`cd apps/backend && bun run db:setup` using the uv venv + `.env.local`) is absent from the README quickstart. Seeded creds: admin@focaltec.com/admin123.
- **The existing telar.yaml gate is wrong**: `run: bun test` (Bun native runner) picks up 96 dashboard *.test.tsx but never touches 130+ Python pytest files. CI has a proper `backend-mcp-tests` job w/ Postgres service + `CI_REQUIRE_DB=1` — the right template for a DB-backed gate.
- **Readiness is polyglot**: pg via `pg_isready` healthcheck; backend has NO /health (poll /docs or /openapi.json); mcp-service HAS /health; vite = stdout line or 200 /. No aggregate signal — supervisor polls 4 endpoints independently.
- **Env**: backend has example templates with fake dev-only values (incl. dev RSA PEMs); **mcp-service has NO env template at all** (only a gitignored real .env.local). Worktrees don't carry .env.local or .venv.
- **No Playwright anywhere** — surface verification would be added fresh (dashboard :5173, proxies /v1 to :8000).
- **Live externals with no mocks**: Bedrock (AI chat), WS/PDP/SAP connectors — blank creds = degraded/hanging flows; smoke recipes must scope around them.
- Risk ranking: (1) portless+sudo, (2) broken documented seed, (3) env.local absent in worktrees / no mcp template, (4) live-external features.

## Ozom/ozom-gv (the gold standard)

- **Already a recipe in shell form**: `bun run kickstart` — idempotent, **non-interactive-safe** (all prompts default when stdin isn't a TTY): preflight `docker info` + `supabase --version` → `supabase start` (553xx ports) → db reset + vault reseed → **write .env.local from `supabase status -o env`** → create owner user → `db:populate` → dev. A `.telar/runbook.md` from a prior run confirms behavior.
- **Three-layer verification exists**: `bun test` (unit) + `supabase test db` (pgTAP RLS tests) + Playwright e2e (24 specs, webServer auto-launch, reuseExistingServer:!CI). Aggregate: **`bun run verify` = lint && typecheck && test && test:db && test:e2e**.
- **Risk #1 — the worktree-secrets wall**: `supabase/.env.keys` (dotenvx private key) is gitignored, non-reconstructible, and **missing from every one of 20+ existing worktrees checked** — any fresh-worktree standup fails at `supabase start` (smtp.pass decryption). Recipes must declare gitignored-but-required files to carry into worktrees.
- **Docs lie (third confirmation)**: README says GITHUB_TOKEN needed to install; bun.lock proves modules are vendored workspace packages with zero npm.pkg.github.com entries — plain `bun install` works. Derive from lockfiles, not READMEs.
- **Degraded-data mode is real and graceful**: without the dotenvx key, reset seeds synthetic GV-DEMO fixtures only (no real BigQuery/Creatio ingest) — verification against synthetic data is possible but behaviorally different; the recipe should record which mode the lab is in.
- **Readiness**: no /api/health; `supabase status -o env` is a structured whole-stack ready signal; Next = 200 on /login (what Playwright polls).
- LLM provider keys are runtime-configured in the product DB (not boot env) — boot needs only supabase-printed keys.
- Risks: (1) .env.keys wall, (2) Docker+supabase CLI hard prereqs, (3) synthetic-vs-real data mode, (4) Next 16 preview quirks + :3000 collisions.

## What the deep-dive adds to the recipe schema

1. **`carry` field**: gitignored-but-required files to propagate into worktrees/lab checkouts (.env.local, supabase/.env.keys, .venv or a rebuild step). Neither prior art nor our draft schema had this — it's telar-specific because telar builds in worktrees.
2. **Lab commands ≠ human commands**: recipes declare direct, wrapper-free, sudo-free service commands (uvicorn/vite/next) even when humans use portless/turbo wrappers. The setup agent must derive the runnable equivalent, not parrot package.json.
3. **Prepare phase is first-class**: install (uv sync + bun install), compose/generate migrations, migrate, seed — run-once steps with their own requirement checks, validated by actually running them (orchestrator's broken seed would be caught by validate-and-teardown, never by reading docs).
4. **Degraded modes declared**: "without secret X: features Y unavailable / data synthetic" — contract narrows explicitly instead of flows hanging.
5. **Adopt project-owned verify entrypoints**: ozom-gv's `bun run verify` and Playwright suite should be *ingested* as gates (with PORT/reuseExistingServer aligned so telar's lane owns the server), not duplicated.
