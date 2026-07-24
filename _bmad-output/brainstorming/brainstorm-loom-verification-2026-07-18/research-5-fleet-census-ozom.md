# Research 5 — Fleet Census (Ozom group, ozom-gv excluded)

> Scout report, 2026-07-18. Read-only census for the loom-verification brainstorm.

## Summary table

| Project | Type | Boot complexity | DB | Secrets | Verify surface |
|---|---|---|---|---|---|
| client-enginecx | consultancy repo, static HTML + python build | `python3 serve.py` (:8765) or open file | none | 0 | static output diff |
| ozom-fespatch | Next.js app | 1 cmd (needs Supabase reachable) | local/remote Supabase (STOCK ports) | ~6+5 | UI :3000 + edge fns + **Vitest suite** |
| ozom-foundry | framework monorepo + 2 example apps | multi-step: GITHUB_TOKEN install → db:compose → supabase → dev; apps can't run concurrently | local Supabase per-app (553xx, collides) | ~2+2 + GITHUB_TOKEN | UI :3000 per app |
| ozom-hub | Next.js prototype | 1 cmd | mock data now; Supabase wired but unused (docs drift) | ~1+2 | UI :3000 |
| ozom-linden-dashboard | Vite SPA | 1 cmd | **README defaults to REMOTE PROD Supabase** | 2 + CI secrets | UI :8080 |
| ozom-rent | Vite SPA SaaS | 1 cmd, strictPort :8080 | local Supabase, STOCK ports, **698 migrations** | ~8+2 | UI :8080 |
| ozom-tesis | Next.js (foundry-generated) | multi-step (token → compose → supabase → dev) | local Supabase 553xx (collides w/ foundry) | 1+2 + GITHUB_TOKEN | UI :3000 |
| ozom-website | Vite SPA + AI chat | 1 cmd but wrapped in global `portless` proxy | local Supabase STOCK ports + pgvector | ~7+6 | UI via portless URL + **Vitest suite** |

## Cross-cutting standup risks (verbatim class list)

1. **Default Supabase port collisions**: fespatch, hub, rent, website all on stock 54321-54329 — at most ONE of these local stacks can run at a time without config edits. Fleet-level port planning is required, not just per-loom.
2. **Private package registry gate**: foundry + tesis need pre-provisioned `GITHUB_TOKEN` (read:packages) — standup fails at INSTALL, before boot. Recipes need an install/prepare phase with its own requirement checks.
3. **Non-standard dev entrypoint**: ozom-website's `bun dev` requires the machine-global `portless` proxy daemon (Homebrew, own CA) — recipe must either doctor-check the machine tool or bypass the wrapper (`vite` directly for a plain port).
4. **Docs/reality drift** (again): ozom-hub CLAUDE.md says "no Supabase" while a real supabase/ + .env.local exist.
5. **Remote-by-default PROD DB**: ozom-linden-dashboard's documented dev path points at the LIVE cloud project — an automated verifier could read/write real business data. Recipes must classify data stores as disposable vs shared-production and refuse surface verification against production. Fail closed.
6. **Mixed lockfiles** (bun + npm side by side) in fespatch and linden — package-manager detection is ambiguous from files alone.
7. **698 sequential migrations** (ozom-rent) → `supabase db reset` is slow/flaky — template-DB stamping amortizes this exactly once.
8. Same hardcoded :8080 across linden/rent/website (rent with strictPort → hard fail on collision).

## Notable singletons
- foundry/tesis: migrations are GENERATED (`db:compose` from module manifests) — recipe must run compose before reset or migrations silently stale.
- fespatch + website are the only two with real test suites (Vitest).
- client-enginecx: static/no-server shape — verification = build + output check, no lab.
