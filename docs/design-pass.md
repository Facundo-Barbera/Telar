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

_(entries appended as the walkthrough proceeds)_
