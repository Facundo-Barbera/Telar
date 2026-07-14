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
- **round:** demo-gallery polish (in flight)

- **view:** chat-session-cost (1.6)
- **verdict:** rework
- **items:** (a) breakdown must open on HOVER as a floating anchored overlay —
  click-to-expand inline reflows the whole bar/UI, rejected; click may pin.
  (b) same light-panel washout on the breakdown rows as 1.4 — fix legibility.
- **round:** demo-gallery polish (in flight)

- **view:** sidebar-full / account wheels (3)
- **verdict:** keep + polish ("love it, great UI" — owner)
- **items:** account wheels: (a) grab-and-drop reorder so the owner chooses
  display order (real persistence = settings fact when it ships); (b) COMPACT
  mode as DEFAULT — only the wheels, horizontal row; expand reveals per-account
  detail; reorder works in compact too.
- **round:** demo-gallery polish (in flight)
