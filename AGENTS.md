# Telar

A local engine that drives the coding agents installed on the machine, and the cockpit that controls it from a browser, the desktop shell or a phone.

The plan being carried out is `docs/migration/plan.md`. Read it before a structural change.

## Workspaces

- `apps/engine`: the local daemon (Bun, TypeScript). Owns projects, sessions, the turn journal, providers, permissions and the MCP tools agents call.
- `apps/web`: the cockpit (Next.js). UI plus the `/api/**` routes that proxy the engine.
- `apps/desktop`: the Electron shell. Hosts the cockpit, the integrated browser, terminals, packaging and self-update.
- `apps/ios`: the native SwiftUI client. Talks to the cockpit's `/api/**`, never to the engine directly.
- `packages/engine-client`: the engine's v2 protocol schemas (zod) and the typed HTTP client, shared by engine, web and desktop.
- `workers/push-relay`: a Cloudflare Worker that signs and forwards push and Live Activity updates to APNs.
- `workers/updates-proxy`: a Cloudflare Worker that gates reads of the private R2 bucket serving desktop updates.

## Commands

Bun only, never npm. Change `package.json` and lockfiles only through `bun add` / `bun remove` / `bun install`.

- Tests for one workspace: `bun run --cwd apps/engine test` (same for `apps/web`, `packages/engine-client`). Desktop: `bun run test:desktop`. Workers: `bun run test:workers`.
- One test file: `bun test path/to/file.test.ts` from inside the workspace.
- Typecheck: `bun run typecheck` (engine-client, engine, web), or `bun run --cwd <workspace> typecheck`.
- Source invariants: `bun run check:source`.
- Lint the web app: `bun run lint`.
- iOS builds with `xcodebuild`; see `apps/ios/README.md`.

Run the tests you touched plus `check:source` and typecheck. CI runs the rest.

## Comments

Comments: none by default. Only allowed: a comment of 3 lines or fewer stating a non-obvious invariant or external quirk, or a 1–3 line usage note on an export whose signature doesn't say how to call it. Never history ("previously", "#490", "the owner reported"), never essays, never CAPITALIZED emphasis, never comments in package.json. When you touch code, delete or trim the stale comments next to it.

## Size

Size: no new file over 800 lines and no new function over 150. When you touch an oversized file, extract the part you changed instead of adding to it.

## Taste

- Do not preserve complexity just because it already exists.
- Delete what you replace in the same PR.
- No compat aliases without a removal date.
- Tests assert behaviour, never source text.
- Don't commit plans, research notes or scratch files; docs/ holds only docs/migration.
- Behaviour-preserving, small PRs. Leave every touched file smaller than you found it.

## Commits

Conventional commit prefixes (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`), one logical change each, with a message that says why.
