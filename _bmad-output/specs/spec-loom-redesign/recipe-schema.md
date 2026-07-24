# Verification Recipe — Parameter Grid

Companion to `SPEC.md` (CAP-4). The 16 parameters of a verification recipe, each with its closed option set, validated against five real fleet archetypes. The machine-readable draft is `recipe.schema.yaml` in the verification brainstorm folder; this file is its source of truth for *what the fields mean and why they exist*.

A recipe is a **map region** (source of truth) that compiles to `servers.yaml` plus prepare / carry / verify sections (what the lane consumes). Today's `servers.yaml` (`packages/core/src/schemas.ts` `ServersConfig` / `ServiceConfig`) is a narrower ancestor of `services[]` — the recipe is deliberately broader, because it answers a bigger question than "how do I start dev".

## The grid

Columns are real fleet archetypes; no column broke the schema.

| Parameter | Option set | ozom-gv (gold) | orchestrator (polyglot) | bixkuOS (multi-svc) | happy-path (greenfield) | no-server |
|---|---|---|---|---|---|---|
| **strategy** | server-lane · test-gate · cli-harness · sandbox-eval · artifact-assert (combinable) | server-lane + test-gate | server-lane + test-gate | server-lane | server-lane | artifact-assert / cli-harness |
| **prepare.install** | detected PM, declared explicitly (bun · npm · uv · maven · mixed) | `bun install` | `bun install` + `uv sync` ×2 | `bun install` | `bun install` | none / `bun install` |
| **prepare.generate** | none · migration-compose · codegen | `db:compose` (before reset, or stale) | none | none | none | none |
| **prepare.migrate** | none · alembic · supabase-reset · liquibase · raw-sql | `supabase db reset` | `alembic upgrade head` (via venv) | `supabase db reset` | none | none |
| **prepare.seed** | none · script · synthetic-fixtures · real-ingest · template-stamp | vault reseed + `db:populate`; degraded → synthetic | `seed.py` via venv (docker path broken — recipe uses the working path) | `seed.sql` MISSING → recipe flags the gap | none | none |
| **carry** (worktree files) | file list, per project | `supabase/.env.keys`, `.env.local` | `.env.local` ×3 (mcp has no template — must carry) | `.env.local` (or re-derive via script) | — | — |
| **services[]** | name · direct wrapper-free command · cwd · env (templated) · portInject (env/arg/file) | supabase (CLI-managed) · `next dev` | pg (compose) · uvicorn:8000 · uvicorn:8001 · vite:5173 — no portless, no sudo | supabase · `next dev` · sidecar (node) | `next dev` | — |
| **scope** (per service) | project · loom · ephemeral | supabase=**project**, next=**loom** | pg=**project**, apis+vite=**loom** | supabase=**project**, next+sidecar=**loom** | next=**loom** | — |
| **readiness** (per service) | http · tcp · exec · log-regex · delay · status-cmd | status-cmd (`supabase status -o env`) + http `/login` | exec `pg_isready` + http `/docs` + http `/health` + http `/` | status-cmd + http `/` + tcp `:7681` | http `/` | exit-code (n/a) |
| **isolation** (data) | tenant-db · schema · mutex · none | mutex v1 (supabase gateway rigid) | **tenant-db** (plain pg — template stamp) | mutex | n/a | n/a |
| **data class** | disposable · shared-dev · production (**refuse surface-verify**) | disposable | disposable | disposable | n/a | n/a |
| **update strategy** (warm lane) | hmr · restart · clean-restart + trigger paths | hmr; clean-restart on `package.json` / `next.config` | uvicorn `--reload` + vite hmr; restart on `pyproject` | hmr | hmr | n/a |
| **verify entrypoints** | ingest project-owned · telar-authored | **INGEST** `bun run verify` (align `PORT` + `reuseExistingServer` → lane owns server) | AUTHOR (existing `bun test` gate is wrong; adopt CI pytest + `CI_REQUIRE_DB`) | AUTHOR (no tests exist) | AUTHOR render probe | AUTHOR artifact/stdout check |
| **requirements** | machine tools · pre-provisioned credentials · secrets | docker, supabase CLI; dotenvx key via carry | docker; portless NOT required (direct cmds) | docker, supabase CLI | none | none / python3 |
| **teardown** | stop signal+grace · lease GC · tenant-db drop · project-scope refcount release | lane stop; supabase stop on last refcount | lane stop; compose down on last refcount | same | kill dev server | n/a |
| **evidence targets** | urls · api endpoints · stdout · artifacts | `:3000` UI (seeded users) | `:5173` UI + `:8000/docs` API | `:3000` UI + ws `:7681` | `:3000` render | dist file content |

## Notable resolutions

- **`carry`** is the one genuinely novel field, absent from all prior art surveyed: gitignored-but-required files to propagate into worktree and lab checkouts (e.g. `supabase/.env.keys`). It is a **lab-checkout property, not a loom property** — ephemeral preview lanes need it too.
- **Prepare is first-class.** install → generate → migrate → seed are run-once steps with their own requirement checks, **validated by actual execution, not by reading docs** — docs lied in multiple surveyed projects.
- **Data classification.** `disposable | shared-dev | production`. `production` means **refuse surface-verify, fail closed**. Not hypothetical: a surveyed project's documented dev path pointed at live production Supabase.
- **No silent strategy.** At least one strategy must be declared; strategies combine.
- **Lane owns the server.** Project-owned e2e suites (Playwright and friends) reuse it via `PORT` + `reuseExistingServer` rather than launching a nested `webServer`. The alternative — letting the suite own the server and telar merely observe — was rejected: it loses lane supervision and leases.
- **Fleet port strategy.** v1 **serializes** (project-scope lease queue, one such stack at a time, others wait). Remapping committed port config is a later optimization; refusing concurrency outright was rejected.
- **Where the recipe lives.** The recipe is conceptually a **map region**, with the existing two-tier `servers.yaml` as its on-disk projection.

## Untried combinations the grid surfaced

Worth exercising early — each is a real archetype the schema permits but no surveyed project runs today:

- **test-gate + tenant-db** — a CI pattern (pytest + `CI_REQUIRE_DB=1` + real Postgres) brought local against a stamped tenant DB: DB-backed test gates without touching shared state.
- **cli-harness + lane** — a CLI tool that needs a live DB. Strategies compose; the lane is not only for `server-lane`.
- **artifact-assert + server-lane** — verify build outputs *and* the running UI in one contract.
- **ephemeral + carry** — "preview this thread" lanes need the carry set too.
