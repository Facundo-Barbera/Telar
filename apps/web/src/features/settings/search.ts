import type { ComponentType } from "react";

export function foldForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/['\u2018\u2019]/g, "")
    .toLowerCase();
}

function slug(text: string): string {
  return foldForSearch(text)
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

export function settingsRowId(parts: { page?: string; group?: string; label: string }): string {
  const trail = [parts.page, parts.group, parts.label].map((part) => (part ? slug(part) : "")).filter(Boolean);
  return `settings-row-${trail.join("-")}`;
}

type SettingsSearchIcon = ComponentType<{ className?: string }>;

type SettingsRowSpec = {
  id?: string;
  title: string;
  hint?: string;
  keywords?: readonly string[];
  icon?: SettingsSearchIcon;
  navigateOnly?: true;
};

type SettingsGroupSpec = {
  title?: string;
  rows: readonly SettingsRowSpec[];
};

export type SettingsPageSpec = {
  id: string;
  label: string;
  icon?: SettingsSearchIcon;
  groups: readonly SettingsGroupSpec[];
};

export type SettingsSearchEntry = {
  id: string;
  title: string;
  hint?: string;
  group?: string;
  pageId: string;
  pageLabel: string;
  icon?: SettingsSearchIcon;
  folded: { title: string; hint: string; place: string };
};

export type SettingsSearchIndex = { entries: readonly SettingsSearchEntry[] };

export function indexSettings(pages: readonly SettingsPageSpec[]): SettingsSearchIndex {
  const entries: SettingsSearchEntry[] = [];
  for (const page of pages) {
    for (const group of page.groups) {
      for (const row of group.rows) {
        const id = row.id ?? settingsRowId({ page: page.id, ...(group.title ? { group: group.title } : {}), label: row.title });
        const icon = row.icon ?? page.icon;
        entries.push({
          id,
          title: row.title,
          ...(row.hint ? { hint: row.hint } : {}),
          ...(group.title ? { group: group.title } : {}),
          pageId: page.id,
          pageLabel: page.label,
          ...(icon ? { icon } : {}),
          folded: {
            title: foldForSearch(row.title),
            hint: foldForSearch([row.hint, ...(row.keywords ?? [])].filter(Boolean).join(" ")),
            place: foldForSearch([group.title, page.label].filter(Boolean).join(" ")),
          },
        });
      }
    }
  }
  return { entries };
}

function rank(entry: SettingsSearchEntry, query: string, terms: readonly string[]): number | undefined {
  const { title, hint, place } = entry.folded;
  if (title.startsWith(query)) return 0;
  if (new RegExp(`\\b${query.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(title)) return 1;
  if (title.includes(query)) return 2;
  if (hint.includes(query)) return 3;
  if (place.includes(query)) return 4;
  const all = `${title} ${hint} ${place}`;
  if (terms.length > 1 && terms.every((term) => all.includes(term))) return 5;
  return undefined;
}

export function searchSettings(
  index: SettingsSearchIndex,
  query: string,
  options?: { limit?: number },
): SettingsSearchEntry[] {
  const folded = foldForSearch(query).trim();
  if (!folded) return [];
  const terms = folded.split(/\s+/).filter(Boolean);
  const scored: { entry: SettingsSearchEntry; rank: number; order: number }[] = [];
  index.entries.forEach((entry, order) => {
    const score = rank(entry, folded, terms);
    if (score !== undefined) scored.push({ entry, rank: score, order });
  });
  scored.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const limit = options?.limit ?? scored.length;
  return scored.slice(0, limit).map((hit) => hit.entry);
}
