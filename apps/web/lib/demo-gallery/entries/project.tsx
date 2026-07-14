// LANE: project (NEW) — the per-project hub view (route /projects/<id>) that no
// redesign lane covered. Two competing takes on how a project's sessions + looms
// should live together. Demo components live under
// apps/web/lib/demo-gallery/project/**.
import type { DemoEntry } from "../registry";
import { ProjectHubWorkFirst } from "../project/variant-a";
import { ProjectHubCommandView } from "../project/variant-b";

export const projectEntries: DemoEntry[] = [
  {
    id: "project-hub-a",
    title: "Project hub — Work-first",
    concern: "extra",
    variant: "Variant A: list-as-hero + inline preview",
    summary:
      "The current project page is a fixed layout — a capped sessions list (first 6, then a Show-all toggle), three loom groups, and a manifest rail — with no search, no filtering, and a full page navigation to open anything. Variant A makes the session/loom LIST the hero: one dense, search-first rail groups everything by age (Today / This week / Older, collapsible), entity + state filter chips narrow it (Sessions / Looms / Active / Needs you / Done), and selecting a row opens an inline PREVIEW pane — last exchange, cost, quick open — so you triage the whole project without leaving the page. New session is the standing primary action. Harmonizes directly with the applied UI-v2 lists lane: same SearchField, Chip, sticky GroupHeader, state rails, and StateBadge color vocabulary, and the chat lane's hover/quiet-metadata grammar. Fully interactive (search, filter, collapse, select); both themes.",
    Component: ProjectHubWorkFirst,
  },
  {
    id: "project-hub-b",
    title: "Project hub — Command view",
    concern: "extra",
    variant: "Variant B: hero strip + two-column, Everything tab",
    summary:
      "Same missing view, opposite bet on orientation. Where the current page buries project-level signal, Variant B leads with a compact command strip — name, account/branch, a 14-day activity sparkline, live running-now indicators, needs-you count, and quick actions (New session primary, New loom, settings) — then a two-column Overview: recent sessions as dense rows on the left, project looms as state-toned cards (the data-light loom pattern, grouped Running / Needs you / Recent) on the right. An Everything tab reveals the full grouped, searchable list from Variant A for when you need the long tail. It judges how much above-the-list orientation a hub earns. Same UI-v2 language as the lists + loom lanes (state rails, WeaveChip kept out of the state palette, quiet mono numerics); both themes; interactive tabs, search, filter, collapse.",
    Component: ProjectHubCommandView,
  },
];
