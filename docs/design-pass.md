# Design pass — view-by-view upgrade log

Working session: the product owner walks /gallery entry by entry with the
orchestrator; per view we log what to upgrade. Items are batched into upgrade
rounds (workflow-built, adversarially verified — prod behavior and the moat
never regress). Bigger redesign ideas become MOCK VARIANTS in the gallery
(fixture-backed, clearly labeled) so alternatives can be compared side by side
before any prod change.

Format per entry:
- **view:** gallery entry id
- **verdict:** keep / polish / rework / mock-alternative
- **items:** concrete changes (copy, layout, hierarchy, affordances, states)
- **round:** which upgrade round shipped it (filled when landed)

---

## Round: /demo-gallery walkthrough (UI v2 proposals, 2026-07-13)

- **view:** chat-working-indicator (1.4)
- **verdict:** polish
- **items:** light-theme panel — shimmer labels ("Starting turn", "Thinking",
  "Running Bash") wash out to near-invisible; production Shimmer gradient is
  dark-tuned, not token-driven. Lane-local theme-aware shimmer dispatched;
  production Shimmer needs the same tokenization when the design ships.
- **round:** demo-gallery round 1 — landed fc7d86c

- **view:** chat-session-cost (1.6)
- **verdict:** rework
- **items:** (a) breakdown must open on HOVER as a floating anchored overlay —
  click-to-expand inline reflows the whole bar/UI, rejected; click may pin.
  (b) same light-panel washout on the breakdown rows as 1.4 — fix legibility.
- **round:** demo-gallery round 1 — landed fc7d86c

- **view:** sidebar-full / account wheels (3)
- **verdict:** keep + polish ("love it, great UI" — owner)
- **items:** account wheels: (a) grab-and-drop reorder so the owner chooses
  display order (real persistence = settings fact when it ships); (b) COMPACT
  mode as DEFAULT — only the wheels, horizontal row; expand reveals per-account
  detail; reorder works in compact too.
- **round:** demo-gallery round 1 — landed fc7d86c (new focused entry:
  sidebar-account-wheels)

- **view:** CTX pill (session bar) — new idea (owner)
- **verdict:** new entry
- **items:** Claude Code /context equivalent as a HOVER on the CTX label:
  anchored overlay (same grammar as the 1.6 cost hover — hover opens, click
  pins, zero reflow) showing context-window composition: system prompt, tools/
  MCP, memory files, messages, free space, autocompact threshold — token
  counts + percentages + segmented usage bar.
- **round:** demo-gallery round 2 — landed ae3c97d (new entry:
  chat-context-breakdown; CTX pill in the session-bar demo now carries the
  hover)

- **view:** sidebar-account-wheels (compact row)
- **verdict:** polish
- **items:** keep the production hover effects on the wheels — per-wheel hover
  detail (account · plan, 5h/weekly usage) in ALL modes (compact row, expanded
  list, collapsed rail); must coexist with the grab/drag affordance.
- **round:** demo-gallery round 3 — landed 84c6671 (WheelTip in all three
  modes, hidden while dragging; mirrors production PlanRing tooltip content)

- **view:** sidebar-account-wheels — WheelTip placement ("not ideal", owner)
- **verdict:** polish
- **items:** compact-row tooltip renders ON TOP of the wheel strip and
  collides with the sidebar row above; must float clear of the anchor (above
  the strip with a gap, or outside the sidebar edge), never covering the
  hovered wheel, its siblings, or adjacent sidebar items; no clipping at the
  sidebar boundary.
- **round:** demo-gallery round 4 — landed 2ab4b16 (fixed-position
  collision-aware tip: top-side in compact/expanded, right-side outside the
  rail)

- **view:** chat-working-indicator light panel — REGRESSION ("white mode",
  owner, 2nd report)
- **verdict:** rework (fix must be structural this time)
- **items:** round-1 theme-aware shimmer did NOT hold: light panel still shows
  washed-out shimmer labels while plain text flips fine. The shimmer must
  derive color from the same mechanism as normal text (class-based/
  currentColor; e.g. solid class-colored text + animated mask sweep), never
  from vars resolved outside the panel scope. Legible at every animation
  phase in both panels; audit every chat-lane shimmer usage.
- **round:** demo-gallery round 5 — landed 4c6aec0. TRUE root cause:
  background-clip:text + color:transparent ignores element color AND WebKit
  does not re-resolve inherited inline var overrides inside the clipped
  gradient — mechanism failure, unfixable by token swaps. New shimmer = solid
  class-colored base text + aria-hidden foreground copy revealed by a moving
  mask (additive only; every failure mode legible). Production Shimmer needs
  the same rework at product-wiring time.
  3rd report + live-DOM probe (getComputedStyle): the masked shimmer VERIFIES
  correct; the still-washed elements are un-classed tool-name spans
  ("shrink-0 font-medium") computing lab(98.26) inside the light panel —
  inherited computed white from the dark shell, because theme-panel wrappers
  inject vars but never re-declare `color`. Round 6 = structural: every
  theme wrapper (all lanes) sets text-foreground; probe re-run to confirm.
  LESSON for walkthrough rounds: visual/DOM verification, not tsc, closes
  display bugs.
