// LANE: project (NEW) — the per-project hub view (route /projects/<id>) that no
// redesign lane covered. Rounds 17 A/B were competing takes; the owner picked a
// HYBRID (Variant C) as the direction. C leads; A and B are kept for reference
// as retired candidates. Demo components live under
// apps/web/lib/demo-gallery/project/**.
import type { DemoEntry } from "../registry";
import { ProjectHubHybrid } from "../project/variant-c";
import { ProjectHubWorkFirst } from "../project/variant-a";
import { ProjectHubCommandView } from "../project/variant-b";
import { GitTabDemo } from "../project/git-tab";
import { GitRemoteDemo } from "../project/git-remote";
import { FilesTabDemo } from "../project/files-tab";

export const projectEntries: DemoEntry[] = [
  {
    id: "project-git-tab",
    title: "Project · Git tab (worktree cleanup)",
    concern: "extra",
    variant: "RECOMMENDED · the Git tab body inside the hub-c tab strip",
    summary:
      "RECOMMENDED. A fourth hub tab — Sessions | Looms | Git | Settings — because AI-assisted work makes git state load-bearing. A header strip glances current branch, ahead/behind, dirty count and last commit. The CENTERPIECE is WORKTREES: Telar and its looms spin up many, so each row shows basename (path on hover), branch, HEAD subject, age, ~disk size, an OWNER chip (loom short-id when the registry created it, else 'manual') and state chips — active-loom / merged / dirty / stale. Because Telar knows loom lifecycle, a done+merged loom tree renders as RECLAIMABLE with no reverse-engineering; an aggregate '~N GB reclaimable across M worktrees' headline sits on top. Bulk 'Clean up' is destructive: it opens a confirm dialog listing exactly what's removed (worktree dir, optionally its merged branch); default selection is merged+clean+no-active-loom only, and dirty/un-merged rows demand a per-row typed force. TIMELINE REPLAY (toolbar): finish the running loom → its worktree flips to reclaimable → the headline grows → bulk-clean. Compact Branches (merged chips + delete-merged) and a data-light Activity mini-log round it out. DATA: worktrees = `git worktree list --porcelain` (vcs.ts) joined to the loom registry by the telar-wt-<loomId> dir naming — real, server-side today; sizes = du estimates (the ~ is honest); branches/commits = git plumbing. Both themes; interactive select, force, dialog, replay.",
    Component: GitTabDemo,
  },
  {
    id: "project-git-remote",
    title: "Project · Git tab — Issues & PRs (future)",
    concern: "extra",
    variant: "FUTURE · read-only-first · gh-CLI, auth-gated",
    summary:
      "A section of the Git tab, split Issues | Pull requests. Dense rows: number, state chip, title, author, age; issues also carry labels, PRs also carry branch, a checks chip and a linked-loom chip when a loom wove that branch (the registry knows the mapping). HONESTY — this is AUTH-GATED FUTURE work, so the 'GitHub not connected' empty state is designed as a first-class surface ('Telar reads via the gh CLI when available… nothing is written — read-only'), reachable from the toolbar's connected/not-connected toggle. DATA: issues/PRs come from the `gh` CLI when installed and authenticated — future, read-only-first; there is no write path. Both themes; sub-tab switch and the honest empty state are interactive.",
    Component: GitRemoteDemo,
  },
  {
    id: "project-files-tab",
    title: "Project · Files tab (loom-aware, may reject)",
    concern: "extra",
    variant: "PROPOSAL · orientation surface, not an editor — owner may reject",
    summary:
      "A git/loom-AWARE Files tab, offered as a PROPOSAL the owner may reject (stated plainly). Positioned as an orientation surface, never an editor: a slim tree with folders collapsed by default, git-status badges (M/A/?), subtle heat dots on recently-churned paths, and a per-node 'last touched by' annotation (session/loom short-id + relative time). DATA HONESTY / GAP: the tree and status are REAL (fs walk + `git status`), but 'last touched by' is NOT wired — the session/loom store records how MANY files a session changed (filesTouched persisted as a count in executor.ts), not WHICH paths, so per-node attribution needs a schema that records paths. The tab ships that caveat inline and the annotation is toggleable, so the honest read is 'design intent, pending a store change' rather than a claimed fact. Both themes; collapse + toggle interactive.",
    Component: FilesTabDemo,
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
