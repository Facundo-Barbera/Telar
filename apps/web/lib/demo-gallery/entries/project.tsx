// LANE: project (NEW) — the per-project hub view (route /projects/<id>) that no
// redesign lane covered. Rounds 17 A/B were competing takes; the owner picked a
// HYBRID (Variant C) as the direction. C leads; A and B are kept for reference
// as retired candidates. Demo components live under
// apps/web/lib/demo-gallery/project/**.
import type { DemoEntry } from "../registry";
import { ProjectHubHybrid } from "../project/variant-c";
import { ProjectHubWorkFirst } from "../project/variant-a";
import { ProjectHubCommandView } from "../project/variant-b";
import { ProjectGithubTab } from "../project/github-tab";

export const projectEntries: DemoEntry[] = [
  {
    id: "project-github-tab",
    title: "Project hub — GitHub tab",
    concern: "extra",
    variant: "RECOMMENDED · avatar-first, constrained, For-you default",
    summary:
      "The project hub reframed around GitHub at the app-standard content width (matching the dashboard column — the hub was the one full-width surface). Tab strip is Sessions | Looms | GitHub | Settings (Git renamed, Files cut). The GitHub tab is avatar-first with four sub-views: FOR YOU (review requested, assigned, mentions, your failing checks — one glance = what needs me), ISSUES and PRS as master-detail (list left with search + Open/Mine/Review-requested chips + j/k, detail right) at full GitHub fidelity (real github.com avatars w/ initials fallback, colored label pills, state glyphs, checks clusters, review chips, head→base mono, rendered markdown + threads), and REPO (worktrees w/ reclaimable + the new conflict-radar chip per branch from a dry git merge-tree, compact branches, cleanup). Bridge actions make it Telar not a mirror: issue → Work-on-this (pre-seeded session sheet) + Weave-loom (charter seed); PR → Check-out (local worktree) + Land (guarded gates→ff-merge→push→delete/reclaim pipeline). Replay: re-running #146's checks flips its red check green so it leaves For-you's failing list. Both themes; retires project-git-unified.",
    Component: ProjectGithubTab,
  },
  {
    id: "project-hub-c",
    title: "Project hub — hybrid (owner spec)",
    concern: "extra",
    variant: "OWNER-SELECTED · tabs + dense sessions list + folded settings",
    summary:
      "The direction chosen off rounds 17 A/B: keep B's TAB structure but drop its command hero, keep A's visually-appealing dense grouped list but stop mixing entities, and fold in the approved project-settings design. A compact project header (name, account/branch, running/needs-you counts, New session as the standing primary action — no sparkline) sits over three tabs. SESSIONS is A's full-width grouped list, sessions only (search-first toolbar, Any/Active/Needs-you/Done state chips, Today/This week/Older collapsible groups, cost/age, a state-toned loom pill on rows that wove a loom — clicking jumps to the Looms tab); no right-side preview, the list gets the whole width. LOOMS is B's state-toned, data-light loom cards grouped Running / Needs you / Ready / Done, searchable and collapsible. SETTINGS embeds the sectioned side-nav over the project FACTS (gates, servers, MCP, guardrails/env, danger) — replacing a separate settings route in the project context. Same UI-v2 language as the applied lists/loom/settings lanes; both themes; interactive tabs, search, filter, collapse.",
    Component: ProjectHubHybrid,
  },
  {
    id: "project-hub-a",
    title: "Project hub — Work-first (retired)",
    concern: "extra",
    variant: "Retired candidate (round 17 A) — superseded by the hybrid",
    summary:
      "RETIRED, kept for reference. Variant A made the session/loom LIST the hero: one dense, search-first rail grouped everything by age (Today / This week / Older, collapsible), entity + state filter chips narrowed it, and selecting a row opened an inline PREVIEW pane. The owner kept its dense grouped list but cut two things into the hybrid (C): it mixed looms and sessions in one list, and the right-side preview was hard to gather context for — so C is sessions-only, full-width, no preview.",
    Component: ProjectHubWorkFirst,
  },
  {
    id: "project-hub-b",
    title: "Project hub — Command view (retired)",
    concern: "extra",
    variant: "Retired candidate (round 17 B) — superseded by the hybrid",
    summary:
      "RETIRED, kept for reference. Variant B led with a compact command strip (name, account/branch, a 14-day activity sparkline, running-now indicators, needs-you count, quick actions) over a two-column Overview plus an Everything tab. The owner kept its TAB structure and its state-toned data-light loom cards for the hybrid (C), but dropped the command hero + sparkline for a compact header and split the two-column body into dedicated Sessions and Looms tabs.",
    Component: ProjectHubCommandView,
  },
];
