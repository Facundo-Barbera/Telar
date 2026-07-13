// Pure grouping helpers for the catalog — NO "use client". Shared by the server
// index page (app/gallery/page.tsx) and the client sidebar nav (gallery-nav.tsx).
// Kept out of the "use client" nav module so the server component can call
// groupedFixtures() directly (a function exported from a client module becomes a
// client-reference proxy and cannot be invoked on the server).
import { GALLERY_FIXTURES } from "@/lib/gallery-fixtures";
import type { GalleryGroup, GalleryFixtureBundle } from "@/lib/gallery-fixtures";

// Lifecycle order — the sequence a loom actually walks. The nav, the index and
// the prev/next pager all order by this so the reviewer can read top-to-bottom.
export const GROUP_ORDER: GalleryGroup[] = [
  "journey",
  "scoping",
  "charter",
  "running",
  "blocked",
  "env",
  "verify",
  "review",
  "ready",
  "terminal",
  "drawers",
  "chat",
];

export const GROUP_LABELS: Record<GalleryGroup, string> = {
  journey: "Journey",
  scoping: "Scoping",
  charter: "Charter review",
  running: "Running",
  blocked: "Blocked",
  env: "Env review",
  verify: "Verify",
  review: "Needs review",
  ready: "Ready / accept",
  terminal: "Terminal states",
  drawers: "Drawers",
  chat: "Chat",
};

// Group the catalog once, in lifecycle order, preserving catalog order within a
// group. Shared by the sidebar nav and the index page.
export function groupedFixtures(): Array<{
  group: GalleryGroup;
  label: string;
  entries: GalleryFixtureBundle[];
}> {
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    entries: GALLERY_FIXTURES.filter((f) => f.group === group),
  })).filter((g) => g.entries.length > 0);
}
