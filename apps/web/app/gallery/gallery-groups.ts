// Pure grouping helpers for the catalog — NO "use client". Shared by the server
// index page (app/gallery/page.tsx), the client sidebar nav (gallery-nav.tsx) and
// the client entry header (gallery-entry-header.tsx).
// Kept out of the "use client" nav module so the server component can call
// gallerySections()/orderedCatalog() directly (a function exported from a client
// module becomes a client-reference proxy and cannot be invoked on the server).
import {
  GALLERY_FIXTURES,
  GALLERY_APP_VIEWS,
  GALLERY_COMPONENTS,
} from "@/lib/gallery-fixtures";
import type {
  GalleryGroup,
  GalleryFixtureBundle,
  GalleryAppEntry,
  GalleryComponentEntry,
} from "@/lib/gallery-fixtures";

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

// Section identifiers — the three top-level buckets the nav/index render, in
// nav order: the 35 loom-cockpit entries first, then the non-cockpit app views,
// then the isolated component showcase.
export const SECTION_LOOM = "loom";
export const SECTION_APP = "app";
export const SECTION_COMPONENT = "component";

// A single catalog entry, normalized across the three registries into one shape
// so the nav, the linear pager, the breadcrumb and the command palette all read
// the same list. `badge` is the mono chip (surface / view key / component key).
export type CatalogKind = "loom" | "app" | "component";
export type CatalogItem = {
  id: string;
  label: string;
  description: string;
  badge: string;
  kind: CatalogKind;
  sectionId: string;
  sectionLabel: string;
  groupLabel: string;
};

export type CatalogGroup = { key: string; label: string; items: CatalogItem[] };
export type CatalogSection = {
  id: string;
  label: string;
  groups: CatalogGroup[];
  count: number;
};

function loomItem(b: GalleryFixtureBundle): CatalogItem {
  return {
    id: b.id,
    label: b.label,
    description: b.description,
    badge: b.surface,
    kind: "loom",
    sectionId: SECTION_LOOM,
    sectionLabel: "Loom views",
    groupLabel: GROUP_LABELS[b.group],
  };
}

function appItem(e: GalleryAppEntry): CatalogItem {
  return {
    id: e.id,
    label: e.label,
    description: e.description,
    badge: e.view,
    kind: "app",
    sectionId: SECTION_APP,
    sectionLabel: "App views",
    groupLabel: "App views",
  };
}

function componentItem(e: GalleryComponentEntry): CatalogItem {
  return {
    id: e.id,
    label: e.label,
    description: e.description,
    badge: e.component,
    kind: "component",
    sectionId: SECTION_COMPONENT,
    sectionLabel: "Components",
    groupLabel: "Components",
  };
}

// The three sections, each split into groups. The loom section keeps the 12
// lifecycle sub-groups (preserving catalog order within a group); the app and
// component sections are a single flat group each. Empty groups are dropped so
// the nav never shows a header with nothing under it.
export function gallerySections(): CatalogSection[] {
  const loomGroups: CatalogGroup[] = GROUP_ORDER.map((group) => ({
    key: group,
    label: GROUP_LABELS[group],
    items: GALLERY_FIXTURES.filter((f) => f.group === group).map(loomItem),
  })).filter((g) => g.items.length > 0);

  const appGroups: CatalogGroup[] = [
    {
      key: "app-views",
      label: "App views",
      items: GALLERY_APP_VIEWS.map(appItem),
    },
  ].filter((g) => g.items.length > 0);

  const componentGroups: CatalogGroup[] = [
    {
      key: "components",
      label: "Components",
      items: GALLERY_COMPONENTS.map(componentItem),
    },
  ].filter((g) => g.items.length > 0);

  const sections: CatalogSection[] = [
    { id: SECTION_LOOM, label: "Loom views", groups: loomGroups },
    { id: SECTION_APP, label: "App views", groups: appGroups },
    { id: SECTION_COMPONENT, label: "Components", groups: componentGroups },
  ].map((s) => ({
    ...s,
    count: s.groups.reduce((n, g) => n + g.items.length, 0),
  }));

  return sections.filter((s) => s.count > 0);
}

// The whole catalog flattened into nav order — the single source of truth for
// the linear prev/next pager, the "n of N" position and the command palette.
export function orderedCatalog(): CatalogItem[] {
  return gallerySections().flatMap((s) => s.groups.flatMap((g) => g.items));
}
