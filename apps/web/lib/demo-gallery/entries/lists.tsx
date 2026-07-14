// LANE: lists — OWNED by the lists redesign lane. Overwrites ONLY this file.
// Demo components live under apps/web/lib/demo-gallery/lists/**.
// Scope: the three index surfaces at scale — Dashboard, Projects, Looms
// (concerns 2 + 5). Search-first headers, grouping, collapsible groups,
// dense status-rich rows, filters + sort, sticky toolbars — scroll radically
// reduced against generous fixture volume (16 projects, 34 sessions, 24 looms).
import type { DemoEntry } from "../registry";
import { DashboardCommandCenterDemo } from "../lists/dashboard-command-center";
import { DashboardActivityFeedDemo } from "../lists/dashboard-activity-feed";
import { ProjectsIndexDemo } from "../lists/projects-index";
import { LoomsIndexDemo } from "../lists/looms-index";
import { CommandPaletteDemo } from "../lists/command-palette";

export const listsEntries: DemoEntry[] = [
  {
    id: "lists-dashboard-command-center",
    title: "Dashboard — Command Center",
    concern: "2",
    variant: "Variant A: command center",
    summary:
      "Current dashboard is one long full-width scroll (Active / Needs attention / Recent / Sessions / Projects / Usage stacked) with nothing prioritized. This replaces it with a running-now command center: a KPI hero (running, needs-you, threads weaving, spend, plan) answers 'what needs me?' above the fold, then a two-column deck puts live looms + what's waiting on the left and today's sessions / hot projects / plan usage on the right — triage in one screen.",
    Component: DashboardCommandCenterDemo,
  },
  {
    id: "lists-dashboard-activity-feed",
    title: "Dashboard — Activity Feed",
    concern: "2",
    variant: "Variant B: activity feed",
    summary:
      "A structurally different take for the same scale problem: instead of parallel section lists, one unified reverse-chronological stream of everything that happened — loom state changes, gate results, session replies, accepts — grouped into time buckets with a type-filter rail and a sticky Needs-you + plan column. Answers 'what changed while I was away?' in a single scan.",
    Component: DashboardActivityFeedDemo,
  },
  {
    id: "lists-projects-index",
    title: "Projects — dense grouped index",
    concern: "2",
    summary:
      "Current projects page is a uniform 3-col grid of tall cards with no search, sort, or activity signal — at 16 repos you hunt visually. This is a search-first sticky toolbar (account filters + sort) over a dense status-rich row list grouped Pinned / Active / Idle, each row surfacing live signal (running looms, sessions today, open work, last active). Busy repos float up; the long tail folds into a collapsed Idle group. Pinning is interactive.",
    Component: ProjectsIndexDemo,
  },
  {
    id: "lists-looms-index",
    title: "Looms — grouped, filterable index",
    concern: "5",
    summary:
      "Current looms page is one flat divide-y list sorted by nothing — at 24 looms you scroll past nine finished runs to reach the two that need you. This adds a search-first sticky toolbar (kind filter + sort) and three collapsible groups — Running now / Needs you / Recent — with the terminal noise folded away by default, per-loom state rails, thread-progress on woven looms, and cost/attempts/age dense on the right. What's live or waiting sits above the fold.",
    Component: LoomsIndexDemo,
  },
  {
    id: "lists-command-palette",
    title: "Global quick-switcher (⌘K)",
    concern: "extra",
    summary:
      "There is no fast path to a specific thing today — you navigate to a list and scan. This is the ⌘K palette that ties the search-first redesigns together: one fuzzy field over every project, session, and loom, results grouped by kind with state rails and relative times, full keyboard navigation. Type-to-jump instead of scroll-to-find.",
    Component: CommandPaletteDemo,
  },
];
