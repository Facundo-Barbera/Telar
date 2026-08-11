---
title: 'vNext standalone cockpit shell'
type: 'refactor'
created: '2026-08-11'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'adc13a1f9405bd47405e83f2df7266453f8465c4'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-vnext-session-cockpit.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The vNext engine and cockpit are isolated at the data and execution layers, but `/vnext` still renders inside the old app shell. Its inherited sidebar exposes Loom, Workspace, legacy project state, and global product behavior, making a supposedly new cockpit look coupled to the surfaces it deliberately excludes.

**Approach:** Move the existing legacy shell behind a URL-transparent route group and give `/vnext` a deliberately small, standalone shell. Preserve global document/theme concerns while ensuring vNext neither mounts nor imports legacy shell providers, state reads, or navigation.

## Boundaries & Constraints

**Always:** Keep legacy URLs and behavior unchanged; keep the vNext engine as the only project/session/transcript writer; retain the current global document, font, and theme initialization; make the vNext shell client-state-free except for existing local component state; preserve API route locations and contracts.

**Ask First:** Changing the normal legacy shell’s information architecture, introducing vNext account/provider settings, creating a separate theme-preference system, moving an API endpoint, or changing the vNext engine contract.

**Never:** Use pathname conditionals, middleware, or header tricks to hide the legacy shell; import legacy `app-shell-data`, sidebar, dock, Loom, Workspace, Ultra, account, desktop-host, or notification modules into the vNext route tree; port those surfaces into vNext; change legacy user state or the dedicated dogfood root.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Open vNext | `/vnext` with engine available | A full-height vNext header and cockpit render without legacy sidebar or navigation | Engine errors remain the existing typed cockpit state |
| Open legacy route | `/`, `/projects/**`, `/looms/**`, `/workspace/**`, `/settings/**`, or demo gallery | The existing legacy shell, providers, data seeds, and URLs behave as before | No vNext shell appears |
| Navigate vNext session | `/vnext/projects/<id>/sessions/<id>` | Session cockpit remains inside the vNext-only shell | Invalid IDs continue through current typed engine errors |
| Build route graph | API and non-UI routes | No URL changes or accidental provider wrapping | Typecheck/build catches invalid moves |

</frozen-after-approval>

## Code Map

- `apps/web/app/layout.tsx` -- root document layout currently owns both global and legacy product concerns.
- `apps/web/app/(legacy)/layout.tsx` -- new URL-transparent owner for the current legacy shell tree.
- `apps/web/app/{page.tsx,projects,looms,workspace,settings,demo-gallery}` -- rendered legacy routes to place under the group without URL changes.
- `apps/web/app/vnext/layout.tsx` -- new dedicated vNext header/navigation boundary.
- `apps/web/lib/sidebar-mount.test.ts` -- existing legacy-shell ownership assertion.
- `apps/web/lib/vnext/source-boundary.test.ts` -- vNext isolation contract test.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/app/layout.tsx`, `apps/web/app/(legacy)/layout.tsx` -- split global document/theme concerns from the unchanged legacy shell and its server data reads.
- [x] `apps/web/app/{page.tsx,projects,looms,workspace,settings,demo-gallery}/**` -- move rendered legacy routes into the route group without changing public paths; leave `api/**` and `vnext/**` outside it.
- [x] `apps/web/app/vnext/layout.tsx` -- add a compact vNext-only header with project/session and settings affordances; provide a full-height shell for existing vNext pages.
- [x] `apps/web/lib/{sidebar-mount.test.ts,vnext/source-boundary.test.ts}` -- prove legacy ownership moved to the group and vNext/root layouts cannot mount legacy providers or data reads.
- [x] `README.md` -- clarify that the vNext door is visually as well as operationally isolated.

**Acceptance Criteria:**
- Given `/vnext`, when it renders, then no legacy sidebar, Loom/Workspace navigation, legacy shell data read, dock, notification, account, or desktop-host provider participates.
- Given any existing legacy page URL, when it renders, then it has the same route and legacy shell behavior as before.
- Given a vNext session URL, when it opens or refreshes, then it remains in the standalone vNext shell and retains current engine-backed behavior.
- Given the app is typechecked, tested, and built, when route groups are applied, then no legacy URL or API route is displaced.

## Design Notes

Route groups are the boundary because layouts are inherited: a nested `/vnext/layout.tsx` cannot remove nodes already mounted by the root layout. The root must therefore become document-only, the group owns legacy providers, and vNext remains a sibling route tree. Theme setup stays root-scoped because it is visual preference rather than product state.

## Verification

**Commands:**
- `bun test apps/web/lib/vnext apps/web/lib/sidebar-mount.test.ts` -- expected: structural isolation and legacy shell tests pass.
- `bun run --cwd apps/web typecheck` -- expected: route moves have no TypeScript errors.
- `bun run --cwd apps/web build` -- expected: all legacy, vNext, and API routes compile.
- `bun run test:vnext-operations && bun run test` -- expected: lifecycle and existing repository suites remain green.

**Manual checks:**
- Visit `/vnext` and a vNext session: expect only the vNext header, no legacy sidebar/navigation.
- Visit `/`, `/projects`, `/looms`, `/workspace`, `/settings`, and `/demo-gallery`: expect their existing URLs and legacy shell.

## Dev Agent Record

### Completion Notes

- Moved the legacy rendered route trees behind the URL-transparent `(legacy)` group and kept API and vNext routes outside it.
- Kept document, fonts, and theme initialization at the root; moved all legacy product state seeds and providers into the legacy layout.
- Added the standalone vNext header and a read-only `/vnext/settings` runtime guide. It has no account, credential, or provider mutation surface.
- Kept vNext styling in a compact standalone stylesheet, so the cockpit does not compile or depend on the inherited legacy Tailwind entrypoint.
- Hardened the adapter gate against forged launcher flags and canonical legacy-home aliases; fixed project selection so a prior project's sessions cannot flash during a new selection.
- Verified source ownership, TypeScript, focused lint, production route build, lifecycle tests, repository tests, and live engine-backed vNext routes.

## File List

- `README.md`
- `apps/web/app/layout.tsx`
- `apps/web/app/(legacy)/layout.tsx`
- `apps/web/app/(legacy)/{page.tsx,projects,looms,workspace,settings,demo-gallery}/**`
- `apps/web/app/vnext/layout.tsx`
- `apps/web/app/vnext/vnext.css`
- `apps/web/app/vnext/settings/page.tsx`
- `apps/web/components/vnext/{projects-cockpit,session-cockpit}.tsx`
- `apps/web/lib/sidebar-mount.test.ts`
- `apps/web/lib/vnext/{engine-server,project-selection,source-boundary}.ts`
- `apps/web/lib/vnext/*.test.ts`
- `apps/engine/**`, `packages/engine-client/**`, `scripts/vnext-dev*.mjs`
- `package.json`, `apps/web/package.json`, `bun.lock`

## Change Log

- 2026-08-11: Isolated the vNext visual shell from all legacy product shell providers and routes.
- 2026-08-11: Added the engine-owned vNext runtime, standalone browser shell, and launch-only legacy-state guard.

## Suggested Review Order

1. `apps/web/app/layout.tsx`, `apps/web/app/(legacy)/layout.tsx`, and `apps/web/app/vnext/layout.tsx` — confirm the route-group ownership split and document-level-only root.
2. `apps/web/lib/vnext/source-boundary.test.ts` and `apps/web/app/vnext/vnext.css` — confirm the vNext route never pulls in legacy shell code or stylesheet compilation.
3. `apps/web/lib/vnext/engine-server.ts`, `apps/engine/src/state.ts`, and `scripts/vnext-dev.mjs` — confirm the launcher and both runtime sides reject legacy state homes.
4. `apps/web/components/vnext/projects-cockpit.tsx` and `apps/web/lib/vnext/project-selection.ts` — confirm project/session hydration cannot show stale sessions.
5. `package.json`, the vNext tests, and `apps/web` production build — review the full verification entry points.
