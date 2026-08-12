# FROZEN — READ-ONLY DESIGN SOURCE. DO NOT EDIT THIS TREE.

This is the legacy Telar cockpit. It was renamed `apps/web` → `apps/web_old` and
retired from verification deliberately. **All new work belongs in
`apps/vnext-web`.**

**Retired from verification.** This tree has no typecheck, no lint gate, and no
test suite in `bun run verify` or in CI. `scripts/lint-ceiling.mjs` was deleted
with its gate. The invariants that scanned it (INV-1a/b/g, INV-4, INV-5c,
INV-6c/e, INV-7c, INV-8, INV-10, INV-11c/e/g) were retired in
`packages/core/test/invariants.test.ts`, each with a note saying what stopped
being checked and what has to come back. **Nothing here is checked by anything** —
an edit that breaks it will not turn anything red.

**Why it is kept.** It is the richest design source in the repo, and the vNext
rebuild ports from it — `components/looms/`, `components/session/`,
`components/workspace/`, and especially the fixture-driven galleries under
`lib/demo-gallery/` and `lib/gallery-fixtures/`. **Read it freely. Copy from it
freely. Do not change it.**

**What still points here.** Desktop packaging and the legacy launchers were
repointed rather than retired, so `apps/desktop` (main.js, dev-runner.js,
package.json), `scripts/build-desktop.sh`, `scripts/package-desktop.sh`,
`scripts/telar` and `scripts/backfill-tool-detail.ts` all resolve `apps/web_old`.
The legacy app remains independently runnable.

**There is no git history here.** This checkout is an orphaned worktree: `.git`
points at `/Users/bixku/Projects/Telar/.git/worktrees/telar-vnext`, and that
parent repository is gone from disk. Nothing in this tree is recoverable if it is
deleted or overwritten. Treat every edit as permanent.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
