// LANE: sidebar — Sidebar & Navigation (concerns 3, 7). Owns this file plus
// everything under lib/demo-gallery/sidebar/**.
import type { DemoEntry } from "../registry";
import { SidebarFullDemo } from "../sidebar/entry-full";
import { SidebarRecentsDemo } from "../sidebar/entry-recents";
import { SidebarSettingsDemo } from "../sidebar/entry-settings";
import { SidebarCollapseDemo } from "../sidebar/entry-collapse";
import { SidebarAccountWheelsDemo } from "../sidebar/entry-account-wheels";

export const sidebarEntries: DemoEntry[] = [
  {
    id: "sidebar-redesign",
    title: "Sidebar, redesigned",
    concern: "3",
    summary:
      "The full sidebar rebuilt: a Pinned section above recents, recents sorted active-first with the freshest active project highlighted, and TODAY's chats + active looms nested under each project on expand. Settings moves to the bottom, above it the plan-usage account wheels sit compact by default and drag-to-reorder. Fully interactive — pin/unpin, expand, collapse, drag a wheel.",
    Component: SidebarFullDemo,
  },
  {
    id: "sidebar-recents-grouping",
    title: "Recents grouping — current vs redesigned",
    concern: "3",
    variant: "Focused: recents block",
    summary:
      "The recents block in isolation, side by side with today's flat list, so the three additive changes read at a glance: a pinned section, active-first ordering (last active on top, location unchanged), and today's chats/looms nested under each project instead of scattered across other surfaces.",
    Component: SidebarRecentsDemo,
  },
  {
    id: "sidebar-settings-bottom",
    title: "Settings moved to the bottom",
    concern: "7",
    summary:
      "Settings leaves the top nav — where it sat 4th among navigation and was easy to mis-click — for a dedicated slot pinned to the sidebar footer beneath the account wheels, the conventional home for config. Reachable in both expanded and collapsed states. Before/after comparison.",
    Component: SidebarSettingsDemo,
  },
  {
    id: "sidebar-account-wheels",
    title: "Account wheels — compact + reorderable",
    concern: "extra",
    variant: "Focused: footer wheels",
    summary:
      "The plan-usage account wheels, up close. Compact by default — a tight row of just the rings — with a chevron to expand into per-account detail (account · plan · tier · 5h/weekly split). Hover any wheel for its plan tooltip, restored from the production PlanRing: account · plan · tier plus the 5h and weekly numbers with tone dots and mini bars, floated as an anchored overlay that never reflows the strip and hides mid-drag. Every wheel is also a grab handle: drag to choose display order, with a primary bar marking the drop point; hover and reorder work compact, expanded, and in the collapsed rail. Order is held in demo state — it becomes a persisted settings fact when it ships.",
    Component: SidebarAccountWheelsDemo,
  },
  {
    id: "sidebar-collapse-rail",
    title: "Collapsed icon rail",
    concern: "extra",
    summary:
      "Collapse behaviour: projects become initial glyphs and any project with a loom in flight keeps a pulsing dot, so running-loom visibility survives the collapse. The account wheels stack centered in the rail and stay drag-to-reorder. Expanded and collapsed states shown together; both live.",
    Component: SidebarCollapseDemo,
  },
];
