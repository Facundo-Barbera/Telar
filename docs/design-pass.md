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
  Round 6 landed c70fa7a; probe re-run CONFIRMS: light-panel spans now
  compute oklch(0.145), dark-shell spans lab(98.26). Closed.

- **view:** sidebar-account-wheels compact strip — hover regressions (owner)
- **verdict:** polish
- **items:** (a) hover GripVertical icon must NOT appear over compact wheels —
  grab the wheel directly (cursor-grab only); (b) the hover tooltip stopped
  opening after the round-4 WheelTip rewrite — restore; (c) remove the hover
  lift (wheel animates upward). Expanded rows may keep their grip handle.
- **round:** demo-gallery round 7 — landed c07d297, probe-verified (0 grip
  icons, 0 lift classes, tip opens on-screen via pointerover). Root cause of
  (b): the round-3 hover-lift transform made the ancestor the containing
  block for the fixed-position tip — hover re-based its coords off-screen.
  LESSON: no transforms on ancestors of fixed-position overlays.

- **view:** sidebar-account-wheels compact strip — hover halo offset (owner)
- **verdict:** polish
- **items:** "shadow below the circle" on hover = the rounded-full wrapper
  lays the wheel out as inline content, reserving descender space, so the
  hover:bg-sidebar-accent halo is taller than the wheel and pokes out below.
  Fix: flex-center the wrapper (kill baseline gap) so the halo is concentric.
- **round:** demo-gallery round 8 — landed 0946174, probe-verified: wrapper
  34px = svg 30px + p-0.5 padding exactly, display:flex; halo concentric.
  Rail wrapper had the same gap and got the same fix.

- **view:** chat-subagent-lifecycle / chat-subagent-tray (1.1)
- **verdict:** mock-alternative (owner request)
- **items:** build a full SESSION BLOCK with the 1.1 treatments in context —
  a realistic agent turn (message, thinking, tool steps) where sub-agent
  tasks spawn mid-turn, complete, and dismiss; variant A (graceful dismiss →
  done pill) and variant B (docked tray) switchable in place; replayable.
- **round:** demo-gallery round 9 (in flight)

- **view:** chat-session-cost session bar (1.6 + CTX)
- **verdict:** polish
- **items:** (a) CTX and cost pills sit at different heights — align them
  (same height/baseline in the bar); (b) both breakdowns are hover-triggered
  now, so the expand chevron (down arrow) on the pill(s) is a stale
  affordance — remove it wherever it appears on the CTX/cost pills.
- **round:** rounds 10+12 — chevron removed 9f0cd3d; alignment fixed bb74aa5
  (round 10 audited badge classes and missed it — the offset lived in the
  WRAPPERS' cross-axis alignment; round 12 fixed from probe measurements,
  re-probe confirms both badges at identical top/height).

- **view:** 1.1 REFRAME (owner): target is the AGENT TAB STRIP, not chips
- **verdict:** rework (re-purpose, don't rebuild)
- **items:** 1.1's "lingering sub-agent tasks" = the top bar of agent tabs
  (Main | <task> | <task> …) that stays cluttered after sub-agents complete.
  Re-purpose the built treatments onto that strip: running sub-agents appear
  as tabs (switchable, live); on completion a tab gracefully dismisses into
  an expandable "N done" pill at the strip end (variant A) or an overflow
  tray (variant B). Transcripts stay reachable via the pill/tray — tabs are
  navigation, not ephemera. Session block gets the strip in its header so
  the in-context judgment targets the right surface.
- **round:** demo-gallery round 11 — landed c9d3b65. SubagentTabStrip mirrors
  production agent-tabs.tsx anatomy (Main first, truncated titles, roving
  tabIndex); running tabs live/switchable, done tabs collapse into the
  strip-end pill (A) or overflow tray (B), FAILED tabs stay pinned; session
  block header now carries the strip, A/B switch swaps strip treatment.

- **view:** 1.1 tab strip (post-round-11) — owner feedback
- **verdict:** polish + new variant
- **items:** (a) the strip lost the previous chips' informative animations —
  a regression in feel ("not bad, but could be a bit better"): bring the chip
  choreography into the tabs (spawn animation, pulsing status mark, live
  elapsed, settle→collapse dismiss into the pill); (b) NEW VARIANT C: a
  session SIDEBAR for sub-agents — right rail with rich animated cards
  (status, title, elapsed, activity), completed settle into a history
  section, click → transcript; add to session block switch as A/B/C.
- **round:** demo-gallery round 13 (in flight)

- **view:** 1.1 DECISION (owner): variant C — SESSION SIDEBAR wins
- **verdict:** keep (C chosen; strip variants A/B retired for 1.1)
- **items:** one gap: no simple way back to the MAIN chat from a sub-agent
  transcript. Add a pinned "Main" row at the top of the rail (always visible,
  highlighted when active) + a back affordance on the transcript view itself
  (banner/breadcrumb "viewing <agent> — back to main", Esc returns).
- **round:** demo-gallery round 14 (queued behind round 13 — same lane)

- **view:** loom-started notification banner (session view) — owner request
- **verdict:** rework (proposals wanted)
- **items:** the persistent "Loom started … View god-view [×]" banner solves a
  momentary event with permanent chrome and never reflects the loom's actual
  state. Variants to judge: A) live loom PILL in the session bar (hover =
  status overlay w/ threads/gates + god-view link; tone follows state —
  amber on park, green on ready = doctrine touchpoints surfaced); B) inline
  event row in-stream at the start turn (scrolls away); C) docked live card,
  collapsible to the pill, re-expands highlighted on escalation/ready.
  Recommendation: A (+B as the historical record).
- **round:** demo-gallery round 15 (queued behind round 14 — same lane)
