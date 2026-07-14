// LANE: lists — OWNED by the lists redesign lane. Overwrites ONLY this file.
// Demo components live under apps/web/lib/demo-gallery/lists/**.
// Scope: the three index surfaces at scale — Dashboard, Projects, Looms
// (concerns 2 + 5). Search-first headers, grouping, collapsible groups,
// dense status-rich rows, filters + sort, sticky toolbars — scroll radically
// reduced against generous fixture volume (16 projects, 34 sessions, 24 looms).
import type { DemoEntry } from "../registry";
import { CommandPaletteDemo } from "../lists/command-palette";

export const listsEntries: DemoEntry[] = [
  {
    id: "lists-command-palette",
    title: "Global quick-switcher (⌘K)",
    concern: "extra",
    summary:
      "There is no fast path to a specific thing today — you navigate to a list and scan. This is the ⌘K palette that ties the search-first redesigns together: one fuzzy field over every project, session, and loom, results grouped by kind with state rails and relative times, full keyboard navigation. Type-to-jump instead of scroll-to-find.",
    Component: CommandPaletteDemo,
  },
];
