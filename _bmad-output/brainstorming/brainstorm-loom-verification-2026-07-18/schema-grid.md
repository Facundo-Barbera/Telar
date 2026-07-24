# Verification Recipe — Morphological Grid (v1, session working artifact)

> Technique 2 output. Rows = independent parameters of a verification recipe (each with its closed option set, validated by research 1–6). Columns = real fleet archetypes. Cells = how the schema instantiates. Open cells at the bottom are genuine design decisions.

## The grid

| Parameter | Option set | ozom-gv (gold) | orchestrator (polyglot) | bixkuOS (multi-svc) | happy-path (landing/greenfield) | no-server (estudioSam/enginecx) |
|---|---|---|---|---|---|---|
| **strategy** | server-lane · test-gate · cli-harness · sandbox-eval · artifact-assert (combinable) | server-lane + test-gate | server-lane + test-gate | server-lane | server-lane | artifact-assert / cli-harness |
| **prepare.install** | detected PM, declared explicitly (bun · npm · uv · maven · mixed) | `bun install` | `bun install` + `uv sync` ×2 | `bun install` | `bun install` | none / `bun install` |
| **prepare.generate** | none · migration-compose · codegen | `db:compose` (before reset or stale!) | none | none | none | none |
| **prepare.migrate** | none · alembic · supabase-reset · liquibase · raw-sql | `supabase db reset` | `alembic upgrade head` (via venv) | `supabase db reset` | none | none |
| **prepare.seed** | none · script · synthetic-fixtures · real-ingest · template-stamp | vault reseed + `db:populate`; degraded→synthetic | `seed.py` via venv (**docker path broken** — recipe uses working path) | **seed.sql MISSING** → recipe flags gap | none | none |
| **carry** (worktree files) | file list, per project | `supabase/.env.keys`, `.env.local` | `.env.local` ×3 (mcp has NO template — must carry) | `.env.local` (or re-derive via script) | — | — |
| **services[]** | name · direct wrapper-free command · cwd · env(templated) · portInject(env/arg/file) | supabase(CLI-managed) · `next dev` | pg(compose) · uvicorn:8000 · uvicorn:8001 · vite:5173 — **no portless, no sudo** | supabase · `next dev` · sidecar(node) | `next dev` | — |
| **scope** (per service) | project · loom · ephemeral | supabase=**project**, next=**loom** | pg=**project**, apis+vite=**loom** | supabase=**project**, next+sidecar=**loom** | next=**loom** | — |
| **readiness** (per service) | http · tcp · exec · log-regex · delay · status-cmd | status-cmd (`supabase status -o env`) + http /login | exec `pg_isready` + http /docs + http /health + http / | status-cmd + http / + tcp :7681 | http / | exit-code (n/a) |
| **isolation** (data) | tenant-db · schema · mutex · none | mutex v1 (supabase gateway rigid) | **tenant-db** (plain pg — template stamp!) | mutex | n/a | n/a |
| **data class** | disposable · shared-dev · production(**refuse surface-verify**) | disposable | disposable | disposable | n/a | n/a |
| **update strategy** (warm lane) | hmr · restart · clean-restart + trigger paths | hmr; clean-restart on package.json/next.config | uvicorn --reload + vite hmr; restart on pyproject | hmr | hmr | n/a |
| **verify entrypoints** | ingest project-owned · telar-authored | **INGEST** `bun run verify` (align PORT + reuseExistingServer → lane owns server) | AUTHOR (existing `bun test` gate is wrong; adopt CI pytest + CI_REQUIRE_DB pattern) | AUTHOR (no tests exist) | AUTHOR render probe | AUTHOR artifact/stdout check |
| **requirements** | machine tools · pre-provisioned credentials · secrets | docker, supabase CLI; dotenvx key via carry | docker; portless NOT required (direct cmds) | docker, supabase CLI | none | none / python3 |
| **teardown** | stop signal+grace · lease GC · tenant-db drop · project-scope refcount release | lane stop; supabase stop on last refcount | lane stop; compose down on last refcount | same | kill dev server | n/a |
| **evidence targets** | urls · api endpoints · stdout · artifacts | :3000 UI (seeded users) | :5173 UI + :8000/docs API | :3000 UI + ws :7681 | :3000 render | dist file content |

## Untried combinations surfaced by the grid

- **test-gate + tenant-db**: orchestrator's CI pattern (pytest + `CI_REQUIRE_DB=1` + real Postgres) brought local against a stamped tenant DB — DB-backed test gates without touching shared state.
- **cli-harness + lane**: a CLI tool that needs a live DB — strategies compose; the lane isn't only for server-lane.
- **artifact-assert + server-lane**: verify build outputs AND the running UI in one contract.
- **ephemeral + carry**: "preview this thread" lanes need the carry set too — carry is a lab-checkout property, not a loom property.

## Open cells (genuine decisions, user to call)

**A. Playwright webServer ownership (ozom-gv pattern).** Project e2e configs auto-launch their own dev server. Rec: recipe sets `PORT` + relies on `reuseExistingServer` — telar's lane owns the server, project suite reuses it. Alternative: let the suite own it and telar only observes (loses lane supervision + leases).

**B. Fleet port strategy for stock-port Supabase stacks** (4 projects on 54321-9). Options: (1) **serialize** — project-scope lease queue, one such stack at a time, others wait; (2) **remap** — telar rewrites/overrides ports per project (touches committed config.toml or needs CLI overrides); (3) refuse concurrency explicitly. Rec: serialize in v1, remap as a later optimization.

**C. Where the recipe lives.** Options: (1) extend existing `servers.yaml` two-tier (committable + `.telar/` accepted); (2) new `recipe.yaml` artifact; (3) recipe = **map region** (per the redesign) that *compiles to* servers.yaml + prepare + carry + verify sections. Rec: (3) conceptually, with (1) as its on-disk projection — the map region is source of truth, the compiled files are what the lane consumes.
