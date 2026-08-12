---
title: 'vNext legacy visual-system integration'
type: 'feature'
created: '2026-08-11'
status: 'in-review'
review_loop_iteration: 0
baseline_commit: '2718824d47d194c3ec5f47d33e0ae745b2adc6fc'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-vnext-web-extraction.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-vnext-session-cockpit.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** vNext is operationally independent, but its current UI replaced Telar's established desktop experience with a generic cockpit. That discarded the high-quality shell, session navigation, chat workspace, and settings language the user explicitly wants to retain.

**Approach:** Recreate the original app's visual system locally inside `apps/vnext-web`, using the running legacy UI and its composition as the design reference—not as an import or copy source. Keep vNext engine data and execution semantics intact; only the overview, project, Looms, and Workspace product surfaces remain candidates for intentional redesign.

## Boundaries & Constraints

**Always:** Keep `apps/vnext-web` standalone: no imports, copied source, Tailwind/shadcn dependency, legacy stores, legacy CSS, or legacy routes. Use the original desktop UI at 1440×900 as the primary visual reference and separately preserve responsive behavior. Rebuild the familiar sidebar, session/chats presentation, session workspace geometry, right-side utility panel treatment, and settings layout from vNext-local components/CSS and only real engine state. Preserve journal hydration/tailing, active-turn gating, stable run IDs, stop, explicit ambiguous retry/discard, root-relative routes, and the engine/client contract.

**Ask First:** Adding engine endpoints or persistence, showing provider/account/context/attachment/tool/subagent data that the engine does not expose, changing engine execution behavior, bringing back legacy product state, or deciding the future information architecture/content of overview, project, Looms, or Workspace views.

**Never:** Reuse legacy React/CSS source verbatim or import it; build a lookalike from a screenshot alone; make vNext pages mount the legacy app; fabricate controls/data; replace the existing engine-owned safety states; or change the legacy application.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Desktop session | 1440×900 engine-owned project/session | Persistent familiar sidebar, compact workspace heartbeat, readable transcript lane, elevated composer, and optional utility panel match the legacy visual hierarchy while using vNext data | Hydration/engine errors retain the same shell and typed alert |
| No engine project/session | Empty vNext state or unavailable engine | Sidebar and root shell remain useful; only controls supported by the engine are enabled | Clear, local empty/unavailable explanation; no invented legacy records |
| Live or recovered turn | queued/claimed/running/ambiguous journal state | Original-style inline work/recovery treatment preserves exact durable labels and explicit actions | No duplicate submit, retry, discard, or automatic replay |
| Settings and narrow screen | `/settings`, 390×844 viewport | Settings remains recognizably part of the same app; sidebar/surfaces collapse without hidden actions or horizontal overflow | Focus, reading, and composer actions remain reachable |

</frozen-after-approval>

## Code Map

- `apps/vnext-web/app/layout.tsx` -- replace the generic top bar with the vNext-local persistent application shell.
- `apps/vnext-web/components/vnext-app-shell.tsx`, `vnext-sidebar.tsx`, and `vnext-session-list.tsx` (new) -- engine-backed project/session navigation and familiar sidebar interaction/layout; no legacy state imports.
- `apps/vnext-web/components/session-cockpit.tsx` -- retain engine state ownership while replacing the generic masthead/transcript/composer with the legacy-derived workspace structure.
- `apps/vnext-web/components/right-panel.tsx` (new) -- local shell for only supported workspace utilities; it must not imply browser, Git, agent, or Ultra data exists.
- `apps/vnext-web/components/projects-cockpit.tsx` and `app/page.tsx` -- place the existing, intentionally-new overview/project surface inside the shared shell without treating it as the visual reference.
- `apps/vnext-web/app/settings/page.tsx` -- make the existing runtime guide use the shared settings visual language while retaining its current read-only contract.
- `apps/vnext-web/app/globals.css` -- replace the generic vNext style vocabulary with locally owned shell, sidebar, conversation, panel, settings, responsive, focus, and motion rules.
- `apps/vnext-web/components/*.test.ts` and `apps/vnext-web/lib/vnext/source-boundary.test.ts` -- protect local composition, real-state-only UI, source isolation, and responsive/accessibility seams.

## Tasks & Acceptance

**Execution:**
- [x] `apps/vnext-web/app/layout.tsx`, `components/{vnext-app-shell,vnext-sidebar,vnext-session-list}.tsx`, and `app/globals.css` -- established a vNext-local desktop-first application shell: sidebar header/nav/search/project/session list/filter/footer, resilient sidebar collapse, and content inset. Derived its hierarchy and proportions from the inspected original, not copied code.
- [x] `apps/vnext-web/components/session-cockpit.tsx`, `components/right-panel.tsx`, and `app/globals.css` -- recomposed the engine-backed session around the original's compact identity bar, centered conversation column, transcript treatment, normal-flow elevated composer, and optional right utility panel. Renders only engine-backed records and preserves all current state transitions/actions.
- [x] `apps/vnext-web/app/settings/page.tsx`, `components/projects-cockpit.tsx`, and `app/page.tsx` -- placed settings and the existing intentional-new overview/project screen in the shared visual system without redesigning Looms/Workspace or adding fake routes/data.
- [x] `apps/vnext-web/components/{app-sidebar,session-cockpit,right-panel}.test.ts` and `lib/vnext/source-boundary.test.ts` -- covered shell/session visual-state decisions, live/recovery behavior, resilient IDs/empty states, and legacy source/style import isolation.

**Acceptance Criteria:**
- Given a user opens vNext at desktop width, when they move between the root, a session, and settings, then they recognize Telar's established application/sidebar/session visual language rather than a separate generic product.
- Given a user opens an engine-backed session, when it is settled, live, failed, or ambiguous, then its durable session behavior stays correct while its visual hierarchy follows the original workspace's composition.
- Given a vNext route has no supporting engine data, when it renders, then the interface is honest about the absence and does not show legacy-only controls or fictional activity.
- Given source checks run, when vNext is built, then all visual code remains owned by `apps/vnext-web` with no legacy component, state, stylesheet, or package dependency.

## Design Notes

The target is the system, not a pixel-for-pixel copy: left session inbox, quiet workspace heartbeat, centered reading lane, composer that belongs to the conversation, and a separate edge utility surface. The original has richer provider, context, browser, Git, loom, and agent contracts; vNext must preserve their spatial restraint without pretending it has those capabilities. The reference at 1440×900 placed a 264px sidebar beside the conversation, a 44px heartbeat, a 768px fresh-session composer, and a 480px optional right panel.

## Verification

**Commands:**
- `bun run --cwd apps/vnext-web typecheck && bun run --cwd apps/vnext-web lint && bun run --cwd apps/vnext-web test` -- expected: vNext state, local visual composition, and isolation checks pass.
- `bun run --cwd apps/vnext-web build` -- expected: standalone routes compile without legacy application imports.
- `bun run --cwd apps/web typecheck && bun run --cwd apps/web test` -- expected: the original app remains unchanged and independently healthy.

**Manual checks:**
- Run the original UI at `http://127.0.0.1:43126` and vNext at its dedicated port; compare the root shell, a fresh/settled/live session, right-panel open state, and settings at 1440×900.
- Recheck vNext at 390×844: no horizontal overflow, an operable collapsed sidebar, readable long IDs/output, and reachable composer/recovery controls.
