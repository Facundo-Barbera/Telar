---
title: 'vNext session workspace UI rebuild'
type: 'feature'
created: '2026-08-11'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'de7267fd'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-vnext-web-extraction.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-vnext-session-cockpit.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The standalone vNext app is now structurally correct, but its session view is a minimal functional cockpit rather than the focused, visually strong workspace the previous Telar session screen provided. It does not yet make a durable project conversation feel like the product's primary working surface.

**Approach:** Rebuild the vNext project-session screen as an independently owned, responsive conversation workspace. Recreate the legacy screen's visual hierarchy—project/session identity, calm reading lane, differentiated user and assistant turns, legible active work, and elevated composer—using only existing engine-owned session data and vNext-local components/styles.

## Boundaries & Constraints

**Always:** Keep `apps/vnext-web` independent of `apps/web` UI, state, CSS, routes, and packages; preserve the existing engine API contract, authenticated loopback client, journal hydration/tailing serialization, one-active-turn rule, stable client run IDs, stop behavior, and explicit ambiguous retry/discard semantics; use vNext-owned CSS and accessible native controls; retain root-relative vNext routes; keep the transcript chronological and avoid forcibly scrolling a reader on polling updates.

**Ask First:** Adding engine endpoints or persisted session fields, introducing attachments/provider or account controls, adding a workflow/subagent panel without real vNext engine records, changing the projectless-composer roadmap, or changing the legacy application.

**Never:** Import or copy legacy `SessionView`, Conversation shell, shadcn/Tailwind primitives, legacy state stores, or legacy styles; fabricate workflow/tool/activity information the vNext journal does not provide; reinterpret durable execution state in the UI; automatically retry ambiguous work; add a global client-state library or modify engine/worker behavior.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Open a settled session | Hydrated user/agent turns | A centered readable transcript differentiates the human prompt from agent output; session title/project are primary and ID secondary | Existing typed hydration error remains visible without replacing the screen shell |
| Active turn | Queue/journal reports queued, claimed, or running | A text-labelled live state is visible; composer explains why it is unavailable and Stop targets the active run | No new turn can be submitted while active; failure remains a typed inline state |
| Ambiguous recovered turn | Durable turn state is `ambiguous` | Local, clearly labelled Retry as new run and Discard controls remain available beside that turn | Retry preserves discard-before-fresh-run behavior; no replay or implied success |
| Narrow viewport or long content | Phone-width layout, long IDs, multiline output | Transcript remains readable; metadata/secondary panels collapse below the reading flow; keyboard focus is visible | No horizontal overflow, obscured composer, colour-only state, or layout-dependent action |

</frozen-after-approval>

## Code Map

- `apps/vnext-web/components/session-cockpit.tsx` -- owns the existing engine-backed state machine and will be split into local presentational seams without changing it.
- `apps/vnext-web/app/globals.css` -- standalone vNext style vocabulary; add session-specific responsive workspace rules here.
- `apps/vnext-web/app/projects/[projectId]/sessions/[sessionId]/page.tsx` -- thin route boundary that continues to provide route identity to the cockpit.
- `apps/vnext-web/lib/vnext/{journal,session-sync,client}.ts` -- durable transcript projection, hydration and command contracts to preserve.
- `apps/vnext-web/lib/vnext/{journal,client,session-sync}.test.ts` -- existing regression coverage for events, retry, and snapshot/tail reconciliation.
- `apps/web/components/session/session-view.tsx` and `apps/web/components/ai-elements/message.tsx` -- visual reference only; never an import or code donor.

## Tasks & Acceptance

**Execution:**

- [x] `apps/vnext-web/components/session-cockpit.tsx` -- refactor the rendered session surface into vNext-local header, transcript/turn, active-state, recovery, and composer seams while retaining the current hydration, tail, submit, stop, discard, and retry functions unchanged in behavior.
- [x] `apps/vnext-web/app/globals.css` -- establish a responsive session-workspace layout with an identity masthead, calm constrained transcript lane, compact human bubbles, full-width agent output, subdued inline state/recovery actions, elevated composer, visible focus styles, and reduced-motion-safe live feedback.
- [x] `apps/vnext-web/components/session-cockpit.test.ts` and existing `apps/vnext-web/lib/vnext/*.test.ts` -- add focused structural/pure presentation coverage for session states and extend journal coverage only if a safe display projection is needed; retain existing retry and cursor-race tests.
- [x] `apps/vnext-web/lib/vnext/source-boundary.test.ts` -- extend the standalone contract to prevent the rebuilt session UI from reintroducing legacy component, Tailwind, or activity-panel imports.

**Acceptance Criteria:**

- Given an engine-owned vNext session, when it loads, then its screen reads as a dedicated conversation workspace rather than an administrative form, with title/project hierarchy and a comfortably constrained transcript.
- Given human and agent content, when rendered, then their roles, multiline text, failure state, and durable status are distinguishable without relying on colour alone.
- Given an active or ambiguous turn, when a user views or acts on it, then every current engine safety behavior remains available and no visual change can cause duplicate execution or automatic replay.
- Given a narrow viewport, keyboard navigation, or reduced-motion preference, when the rebuilt screen is used, then transcript, composer, recovery actions, and focus states remain reachable and readable.
- Given source-boundary and standalone checks, when they run, then the session rebuild remains entirely inside `apps/vnext-web` and uses only root-relative vNext adapters.

## Design Notes

The visual target is the older session screen's workspace geometry, not its dependency graph. The session title and project context should carry orientation; a mono identifier is supporting metadata. A quiet status chip and text communicate live/terminal state. The transcript deliberately has two reading modes: a compact, right-aligned human prompt and a broad agent response lane. Only real engine state is shown; an activity dock, attachments, provider controls, and projectless composer are deferred because their contracts do not exist in vNext yet.

## Verification

**Commands:**

- `bun run --cwd apps/vnext-web typecheck && bun run --cwd apps/vnext-web lint && bun run --cwd apps/vnext-web test` -- expected: standalone UI, boundary, and engine-adapter contracts pass.
- `bun run --cwd apps/vnext-web build` -- expected: rebuilt session route compiles without the legacy app.
- `bun run --cwd apps/web typecheck && bun run --cwd apps/web test` -- expected: legacy app remains independently intact.

**Manual checks:**

- Run `bun run dev:vnext`, open a session at `/projects/<projectId>/sessions/<sessionId>`, and inspect loading, empty, completed, active, failed, and ambiguous states.
- At 320px width and keyboard-only navigation, verify readable long output, visible focus, reachable recovery controls, and an unobscured composer.

## Implementation Notes

- Rebuilt the session screen entirely inside `apps/vnext-web` with local masthead, transcript, recovery, and composer seams.
- Preserved serialized journal hydration/tailing, active-turn gating, stable run IDs, stop, explicit discard, and retry behavior.
- Review fixed a recovery defect so retries submit the original durable prompt rather than streamed agent output.
- Review also hardened focus visibility, long-ID wrapping, durable state labels, and unavailable-session composer behavior.
- Verified standalone typecheck, lint, test, production build, live desktop/mobile routes, and the legacy web suite.

## Suggested Review Order

**Session semantics and recovery**

- Start with the component that preserves engine-owned state while reshaping presentation.
  [session-cockpit.tsx:142](../../apps/vnext-web/components/session-cockpit.tsx#L142)

- Verify ambiguous retries re-submit the durable user prompt, never provider output.
  [session-cockpit.tsx:84](../../apps/vnext-web/components/session-cockpit.tsx#L84)

- Check local recovery actions retain an explicit human decision at the affected turn.
  [session-cockpit.tsx:67](../../apps/vnext-web/components/session-cockpit.tsx#L67)

**Workspace presentation and accessibility**

- Follow masthead, differentiated transcript lanes, and the elevated normal-flow composer.
  [session-cockpit.tsx:36](../../apps/vnext-web/components/session-cockpit.tsx#L36)

- Review responsive wrapping, focus visibility, motion reduction, and narrow-screen rules.
  [globals.css:74](../../apps/vnext-web/app/globals.css#L74)

**Boundary and regression proof**

- Confirm labels and retry-input mapping protect durable state meaning.
  [session-cockpit.test.ts:5](../../apps/vnext-web/components/session-cockpit.test.ts#L5)

- Confirm the visual rebuild cannot import legacy UI or an invented activity panel.
  [source-boundary.test.ts:9](../../apps/vnext-web/lib/vnext/source-boundary.test.ts#L9)
