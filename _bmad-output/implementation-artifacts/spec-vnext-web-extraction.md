---
title: 'Standalone vNext web app extraction'
type: 'refactor'
created: '2026-08-11'
status: 'done'
review_loop_iteration: 0
baseline_commit: '8ff5262e597246fbd577dea5cef53736f68201b5'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-vnext-session-cockpit.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-vnext-standalone-shell.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The first vNext cockpit is isolated from legacy state and shell providers, but it still lives inside `apps/web`. Its `/vnext` route compiles the inherited application, so legacy routing, instrumentation, CSS, and build failures can still prevent vNext from loading. The user wants vNext to become the product that owns `/`, while preserving the existing application during the transition.

**Approach:** Extract the existing engine-backed vNext cockpit into a first-class `apps/vnext-web` Next app. Give that app root-relative routes (`/`, `/settings`, and its current project session route), its own layout, CSS, API adapters, tests, and launcher target. Keep the legacy app intact; a production host/domain cutover and the later projectless composer are separate work.

## Boundaries & Constraints

**Always:** Keep `apps/web` and all existing legacy routes and state behavior unchanged; preserve the current engine, authenticated loopback client, dedicated `TELAR_HOME`, worker supervision, and typed error semantics; use only `@telar/engine-client` as the vNext runtime package boundary; make vNext root-relative inside its own app; give it independently owned styles and UI primitives; include the new workspace in root verification.

**Ask First:** Changing production hosting/domain routing, switching desktop packaging from `apps/web`, deleting the temporary `/vnext` cockpit from the legacy app, moving legacy state, or altering the engine contract to allow projectless sessions/a projectless worker cwd.

**Never:** Import legacy layouts, ThemeProvider, instrumentation, `@telar/core`, legacy API routes, state stores, account/provider configuration, or legacy global CSS into `apps/vnext-web`; fake a projectless composer by inventing a project id or cwd; weaken the engine's legacy-home guard.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|----------------------------|----------------|
| Launch vNext | `bun run dev:vnext` with dedicated absolute `TELAR_HOME` | Engine, worker, and `apps/vnext-web` start; browser door is `http://127.0.0.1:<port>/` | Existing launcher refuses unavailable port, legacy home, engine, or worker |
| Open root cockpit | `/` in standalone app, engine available | Current project/session cockpit renders without legacy layout, CSS, or API prefix | Existing typed unavailable-engine state is rendered |
| Open current session | `/projects/<projectId>/sessions/<sessionId>` | Existing durable vNext transcript UI and polling operate through root-relative API routes | Invalid/unavailable engine responses remain typed |
| Run legacy app | `apps/web` on its normal route tree | Existing routes, dependencies, and desktop packaging remain unchanged | No new vNext build/runtime dependency is introduced |

</frozen-after-approval>

## Code Map

- `apps/web/app/vnext/**`, `apps/web/components/vnext/**`, `apps/web/lib/vnext/**` -- the current vNext UI, adapters, and focused tests to relocate.
- `apps/web/app/api/vnext/**` -- thin Next route adapters to relocate under the standalone app's `/api/**` tree.
- `apps/engine/**`, `packages/engine-client/**` -- already-isolated runtime and contract; preserved, not redesigned.
- `scripts/vnext-dev.mjs`, `scripts/vnext-dev-lifecycle.mjs` -- supervises the engine/worker and currently starts `apps/web` at `/vnext`.
- `package.json`, `bun.lock` -- monorepo workspace verification and dependency resolution.

## Tasks & Acceptance

**Execution:**

- [x] `apps/vnext-web/{package.json,tsconfig.json,next.config.ts,postcss.config.mjs,eslint.config.mjs}` -- create an independent Next workspace with only the vNext browser/runtime dependencies and a clean local verification surface.
- [x] `apps/vnext-web/app/{layout.tsx,globals.css,page.tsx,settings/page.tsx,projects/[projectId]/sessions/[sessionId]/page.tsx}` -- move the vNext page tree to root-relative URLs and replace inherited document/style ownership with vNext-owned equivalents.
- [x] `apps/vnext-web/{components,lib}/**` and `apps/vnext-web/app/api/**` -- relocate the cockpit, engine adapter, browser client, durable-session helpers, and API routes; change `/api/vnext/*` calls to `/api/*` without changing engine requests/contracts.
- [x] `apps/web/app/{vnext,api/vnext}/**`, `apps/web/{components,lib}/vnext/**` -- remove the duplicated in-app vNext surface after its standalone replacement is covered, leaving legacy routes solely legacy.
- [x] `scripts/vnext-dev{,-lifecycle,-lifecycle.test}.mjs`, `README.md` -- launch `apps/vnext-web` and advertise `/`; retain worker/engine ownership rules and document the two-app boundary.
- [x] `package.json`, `bun.lock`, `apps/vnext-web/**/*.test.ts` -- include vNext app typecheck/test/lint in root verification and test URL/API-prefix migration, launcher target, and source isolation.

**Acceptance Criteria:**

- Given the vNext launcher, when it starts successfully, then its announced browser URL is root `/` of `apps/vnext-web`, not `/vnext` of `apps/web`.
- Given the standalone app, when it renders or calls an adapter, then it depends on no legacy UI/state/runtime module and reaches only `/api/*` owned by itself.
- Given a durable vNext project session, when it is opened through the standalone route, then the existing transcript/turn/recovery behavior continues unchanged.
- Given the legacy app, when it is built or launched independently, then its routes and desktop packaging have no new dependency on `apps/vnext-web`.
- Given repository verification, when it runs, then both engine client/engine and both web workspaces are typechecked and tested, and `apps/vnext-web` lints cleanly.

## Design Notes

This is a runtime extraction, not a host cutover. `apps/vnext-web` owns `/` within its own server now; choosing which deployed server owns a shared public hostname is deliberately deferred. The future empty composer needs an explicit engine increment because every existing engine session requires `projectId` and the worker needs a project's cwd. The current root page therefore carries forward the working project/session cockpit only until the projectless session contract is designed.

## Verification

**Commands:**

- `bun run dev:vnext` -- expected: engine, worker, and standalone app announce a root URL and respond on `/`.
- `bun run --cwd apps/vnext-web typecheck && bun run --cwd apps/vnext-web lint && bun run --cwd apps/vnext-web test` -- expected: standalone workspace passes independently.
- `bun run verify` -- expected: root verification covers the new workspace with no regression in legacy, engine, or desktop suites.
- `bun run --cwd apps/vnext-web build` -- expected: standalone routes and adapters build without loading legacy app code.

**Manual checks:**

- Open `/`, `/settings`, and an existing vNext project session in the standalone server; expect no legacy navigation or stylesheet.
- Launch `apps/web` separately; expect its existing legacy route tree to remain available without the vNext cockpit.

## Implementation Notes

- Extracted the engine-backed cockpit into `apps/vnext-web` with root-relative routes, local styles, and local API adapters.
- Preserved durable journal hydration, ambiguous-turn recovery, and multiline transcript rendering while replacing inherited UI primitives.
- Updated the launcher to start only `apps/vnext-web` at the dedicated default port `43125`.
- Review fixed the default-port collision, retry-state refresh, multiline transcript rendering, generated TypeScript build-info output, and outdated README wording.
- `bun run verify` remains blocked at the existing core test-typecheck ceiling; standalone vNext, launcher, and legacy web checks pass.

## Suggested Review Order

**Standalone boundary**

- Start with the standalone document shell and root navigation.
  [layout.tsx:1](../../apps/vnext-web/app/layout.tsx#L1)

- Confirm forbidden legacy imports and non-root routes are mechanically guarded.
  [source-boundary.test.ts:7](../../apps/vnext-web/lib/vnext/source-boundary.test.ts#L7)

**Durable session behavior**

- Follow serialized hydration, tailing, recovery decisions, and turn submission.
  [session-cockpit.tsx:38](../../apps/vnext-web/components/session-cockpit.tsx#L38)

- Verify the local API client uses only root-relative adapter endpoints.
  [client.ts:1](../../apps/vnext-web/lib/vnext/client.ts#L1)

**Launch and verification**

- Check the launcher binds the standalone workspace to the deterministic root URL.
  [vnext-dev-lifecycle.mjs:13](../../scripts/vnext-dev-lifecycle.mjs#L13)

- Confirm root verification includes both independently typechecked web applications.
  [package.json:21](../../package.json#L21)

- Review the independent TypeScript cache location and Next workspace boundary.
  [tsconfig.json:1](../../apps/vnext-web/tsconfig.json#L1)
