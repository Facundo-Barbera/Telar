---
title: 'Finish t3code convergence'
type: 'feature'
created: '2026-08-01'
status: 'in-progress'
baseline_commit: 'ff9f4274d26626e2a8a0a206700be81cecc1bfd2'
review_loop_iteration: 0
context:
  - 'docs/t3code-convergence-plan.md'
  - 'docs/phase-2-sidebar-design.md'
  - '_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The prior agent completed palette and extraction groundwork but left the visible convergence unfinished: the live sidebar is not resizable, the shell still has two left rails, Phases 3–7 are mostly unimplemented, and Codex dynamic moat tools have an uncovered approval path.

**Approach:** Complete the convergence plan in walkable, sequential slices: repair and mount sidebar geometry; collapse to one session sidebar; add the right panel; normalize composer options; move project detail into a dialog; then unify approval/lifecycle contracts and migrate to session-scoped harness adapters behind a strangler.

## Boundaries & Constraints

**Always:** Preserve the human-accept moat; rewrite structural invariants before moving pinned mechanisms; host existing surfaces rather than fork them; use Bun; use `useSyncExternalStore` for persistent UI state; keep client runtime imports free of `@telar/core`; keep `EngineEvent` separate; make every phase independently walkable; retain legacy chat compatibility and interruption semantics.

**Ask First:** Any permanent Codex-verification limitation; weakening verifier/read-only walls; deleting `/projects` rather than redirecting it; moving Loom acceptance away from `/looms`; changing the approved Phase-2 product defaults below; native browser compositing; removing the strangler before both paths pass the full gate.

**Never:** Add a global state library; duplicate Git/project/approval surfaces; make `full-access` bypass loom acceptance; treat `stopSession` as the composer stop button; equate session-scoped approval with persisted project-wide `always`; mutate the verifier path to gain an interactive approval responder.

### Approved implementation defaults

- Keep Dashboard and `/projects` index; project detail becomes a dialog and legacy detail URLs redirect compatibly.
- Sidebar includes a global Needs-you band, creation-ordered sessions, a three-day settled shelf, no project pins, no loom-born steerer/escalation sessions, per-session cost, session-local project scope, and a project picker for unscoped New session.
- The Looms badge remains global. Demo-gallery harvest is an accepted non-blocker, but cited visual rationale is preserved.
- The right panel and subagent rail must not force an unusable four-column layout; narrow-width behavior collapses one auxiliary surface deterministically.
- Panel storage uses schema versioning and deterministic bounded eviction; the exact cap is chosen and pinned by tests in the store slice.
- Phase 4 converges the whole composer bar on the inspected T3 Code Nightly pattern: one elevated rounded surface with a growing input above an integrated model/traits/Access/mode/Send strip, plus a thinner attached workspace/branch rail. Preserve Telar's `auto` default, Ultra affordance, and human-accept moat rather than copying Nightly's current values.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Sidebar resize | Desktop drag, narrow viewport, remount | Visible width tracks final pointer, keeps 640px main floor, persists with collapse state | Invalid/stale width falls back; shrinking is always possible |
| Sidebar search/scope | Query, project scope, active/settled session | Flat keyboard-navigable results; active session never hides | Missing project resets scope; empty states explain cause |
| Right panel | Git/browser tabs per session | Versioned session-local tabs, deterministic close selection, live Git refresh | Bad state migrates/resets; iframe policy failure is explained |
| Composer access | Provider switch, old chat, traits | One four-row runtime mode defaulting to `auto`; compatible traits only | Stale traits reset; legacy permissions migrate |
| Project update | Edit/clear manifest fields | All supported fields persist without clobbering unknown YAML | Validation is field-specific and non-destructive |
| Approval request | Claude/Codex moat tool, verifier path | Interactive card gates both harnesses; verifier cannot accept-for-session | Decline/cancel resolves exactly once; no automatic grant |
| Session lifecycle | Legacy/v2 session, interrupt, reconnect | Ordered lifecycle events, Telar-owned ID, provider cursor, replay continuity | Process exit cancels requests; legacy path remains selectable |

</frozen-after-approval>

## Code Map

- `apps/web/components/ui/sidebar.tsx`, `apps/web/lib/sidebar-width.ts` -- resize primitive, persistence, final-frame repair.
- `apps/web/components/app-sidebar.tsx`, `apps/web/components/session/sessions-rail.tsx` -- one-sidebar migration.
- `apps/web/app/projects/[name]/sessions/[id]/page.tsx`, `apps/web/components/session/session-view.tsx` -- shell, refresh, composer integration.
- `apps/web/components/right-panel/**`, `apps/web/lib/right-panel-store.ts` -- new panel host and per-session state.
- `apps/web/components/projects/git-tab*.tsx`, `apps/web/lib/server/git-tab.ts` -- hosted Git surface and invalidation.
- `apps/web/lib/provider-options.ts`, `packages/core/src/runtime-mode.ts` -- provider traits and canonical access mode.
- `apps/web/components/projects/settings-view.tsx`, `apps/web/app/api/projects/[name]/route.ts` -- project dialog fields.
- `packages/core/src/harness-port.ts`, `apps/web/lib/codex-app-server.ts`, `apps/web/app/api/chat/route.ts` -- lifecycle and adapters.
- `apps/web/lib/permissions.ts`, `packages/core/test/invariants.test.ts` -- shared human gate and structural proofs.
- `apps/web/lib/store.ts`, `apps/web/lib/session-log.ts`, `apps/web/lib/chat-runs.ts` -- identity, replay, strangler, interruption.

## Tasks & Acceptance

**Execution:**
- [x] Repair `SidebarRail` final-frame handling; add interaction coverage; mount offcanvas app resize with shared key, external trigger, 256px minimum, and 640px main floor.
- [x] Finish Phase 2a persistence extraction; add pure session-list derivation, save refresh, cost summary, scope/search/Needs-you/shelf UI; remove `SessionsRail` and legacy project tree atomically with successor affordances.
- [x] Extend INV-8 first; add versioned/evicting right-panel store, tab chrome, browser iframe, Git host and same-commit mutation refresh; remove Git duplication from project detail.
- [ ] Rebuild the composer as one T3 Code-shaped input bar; wire provider option groups and canonical runtime mode through its integrated controls, persistence, route and adapter boundaries; migrate legacy chats and remove presentation-layer provider forks.
- [ ] Build project dialog, expose `charterPolicy`, `devCommand`, `verifyCommand`, `designRules`, remove unwired `adapter`, and replace detail-route navigation with compatible redirects.
- [ ] Generalize INV-1g and gate Codex dynamic moat tools; add lifecycle/request schemas, `ApprovalDecision`, structured input and INV-2i without changing verification capabilities.
- [ ] Introduce Telar-owned session identity and provider cursors; replace `runTurn` with session-scoped adapter operations; persist Codex processes, extract Claude adapter, and run legacy/v2 behind immutable per-session strangler selection.
- [ ] Delete legacy execution only after adversarial review and complete dual-path verification; update convergence/design documents to built status.

**Acceptance Criteria:**
- Given the production app at desktop width, when the sidebar edge is dragged and the page is reloaded, then the final chosen width is visible and restored, while collapse/reopen remains keyboard-accessible.
- Given any route, when the sidebar is open, then there is one left region containing session search/scope/navigation and no separate `SessionsRail`.
- Given a session, when panel tabs are opened or Git mutates, then state is isolated to that session and Git refreshes without a duplicate project-page instance.
- Given either provider, when access or trait options are changed, then the same generic composer controls persist canonical values and adapters receive correct native options.
- Given the chat composer, when it is empty, multiline, focused, or carrying active options, then input and controls remain one coherent rounded surface with an attached workspace/branch rail and no disconnected toolbar.
- Given project settings, when the newly surfaced fields are edited or cleared, then validated manifest data round-trips without losing unrelated keys.
- Given Claude or Codex requests a moat tool, when no human decision exists, then execution cannot proceed; verification code has no capability to grant session approval.
- Given a v2 session, when turns are sent, interrupted, reconnected and stopped, then adapter lifecycle events remain ordered, replayable and provider-neutral while legacy sessions continue to work.
- Given each phase boundary, when its focused and regression suites plus lint/type checks run, then the phase is walkable in the browser before the next phase begins.

## Spec Change Log

## Design Notes

The implementation follows dependency order, not visual priority. Phase 2 creates the three-column shell prerequisite; Phase 3 relocates Git before Phase 5 deletes its route; Phase 6 establishes safety vocabulary before Phase 7 moves execution ownership. The first implementation slice must reproduce the user-observed resize failure in the real mount, because the current pure tests only prove unused arithmetic.

## Verification

**Commands:**
- `bun test` -- all repository tests pass without updating snapshots to hide drift.
- `bun run lint` in `apps/web` -- no new lint errors.
- `bunx tsc --noEmit` in each affected workspace -- no type errors.
- Focused Bun suites for sidebar, panel store, provider/runtime mode, project route/store, permissions, harness conformance and invariants -- each phase's contract passes before integration.

**Manual checks:**
- Walk localhost at desktop, constrained desktop and mobile: resize/reload/collapse, search/scope/new session, panel/subagent coexistence, Git mutation refresh, iframe failure, composer provider switching, project dialog round-trip, approval/decline/interruption/reconnect on both strangler paths.
