// LANE: project (NEW) — the per-project hub view (route /projects/<id>) that no
// redesign lane covered. Rounds 17 A/B were competing takes; the owner picked a
// HYBRID (Variant C) as the direction. C leads; A and B are kept for reference
// as retired candidates. Demo components live under
// apps/web/lib/demo-gallery/project/**.
import type { DemoEntry } from "../registry";
import { ProjectHubHybrid } from "../project/variant-c";
import { ProjectHubWorkFirst } from "../project/variant-a";
import { ProjectHubCommandView } from "../project/variant-b";
import { GitUnifiedDemo } from "../project/git-unified";

export const projectEntries: DemoEntry[] = [
  {
    id: "project-git-unified",
    title: "Project · Git tab (unified)",
    concern: "extra",
    variant: "RECOMMENDED · one dense Git tab inside the hub-c tab strip",
    summary:
      "RECOMMENDED. ONE unified Git tab — the fourth hub tab (Sessions | Looms | Git | Settings) — because AI-assisted work makes git state load-bearing. It merges the three earlier takes (worktrees, remote, files) into a single dense view with a slim section-jump row under the header. HEADER STRIP glances branch, ahead/behind, dirty count, last commit. WORKTREES is the CENTERPIECE, full width: each row shows basename (path on hover), branch, HEAD subject, age, ~disk size, an OWNER chip (loom short-id when the registry created it, else 'manual') and state chips (active-loom / merged / dirty / stale). Because Telar knows loom lifecycle, a done+merged loom tree renders RECLAIMABLE with no reverse-engineering; a '~N GB reclaimable across M worktrees' headline sits on top. Bulk 'Clean up' is destructive: a confirm modal lists exactly what's removed (dir + optionally its merged branch); default selection is merged+clean+no-active-loom only, and dirty/un-merged rows demand a per-row typed force. BRANCHES + ACTIVITY sit in a two-column band (merged chips + delete-merged; a data-light commit log). REMOTE shows Issues | PRs with a small sub-toggle and, first-class, the 'GitHub not connected (gh CLI)' empty state — kept read-only-first with a subtle 'future · read-only preview' tag in-section. FILES is a collapsible section at the bottom (collapsed by default; header shows file + dirty counts), revealing a git-aware tree with M/A/? badges, heat dots and a last-touched-by toggle. ONE replay timeline drives it all: finish the running loom → its worktree flips reclaimable AND a pending PR check flips green in the same tick. DATA HONESTY: worktrees = `git worktree list --porcelain` (vcs.ts) joined to the loom registry by telar-wt-<loomId> naming — real, server-side today; sizes = du estimates (the ~ is honest); branches/commits = git plumbing (real). Issues/PRs = `gh` CLI, AUTH-GATED — future, read-only, no write path. The file tree + status are real (fs walk + git status), but 'last touched by' is a GAP: the store records filesTouched as a COUNT, not the paths a session changed (executor.ts), so per-node attribution needs a schema that records paths — shipped as toggleable design intent with an inline caveat, not a claimed fact. Both themes; select, force, dialog, sub-toggle, gh empty state, collapse, and replay all interactive.",
    Component: GitUnifiedDemo,
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
