import path from "node:path";
import { filesUnder, read, ROOT } from "./files.mjs";

// Panes are lazy and most rows need the engine, so the search index is checked against their source.
const SETTINGS = "apps/web/src/features/settings/";

// Rows that are a state the pane is in, not a setting.
const NOT_SETTINGS = new Set([
  "Could not read plugins", "Could not save", "Desktop app only", "Detecting", "Did not start", "Loading", "No hubs configured",
  "No other TeX install found", "No phone can be reached yet", "No plugins registered", "No remembered logins", "No servers configured",
  "No update feed in this build", "None yet", "Not available here", "Restart to apply", "The engine did not answer",
]);

// Panes live in the settings components or in a feature that builds on the settings shell.
const paneSources = () =>
  filesUnder("apps/web/src", /\.tsx$/)
    .filter((file) => file.startsWith(`${SETTINGS}components/`) || /\/settings-shell"|from "@\/features\/settings"/.test(read(file)))
    .map(read);

/** Labels of every `<Row>`/`<ToggleRow>` with a fixed `label="…"`. */
export function renderedLabels(sources) {
  const labels = new Set();
  for (const source of sources) {
    for (const [, attrs] of source.matchAll(/<(?:Row|ToggleRow)\b([\s\S]*?)\/?>/g)) {
      const label = /\blabel="([^"]+)"/.exec(attrs ?? "")?.[1];
      if (label) labels.add(label);
    }
  }
  return labels;
}

export const settingsSearchCheck = {
  name: "settings-search-matches-the-panes",
  protects: "every search entry names a row a pane renders, and every fixed row a pane renders can be found",
  async run() {
    const { SETTINGS_SEARCH_INDEX, SETTINGS_SEARCH_PAGES } = await import(path.join(ROOT, SETTINGS, "registry.ts"));
    const sources = paneSources();
    const text = sources.join("\n");
    const labels = renderedLabels(sources);
    const failures = [];
    for (const entry of SETTINGS_SEARCH_INDEX.entries) {
      if (!text.includes(entry.title)) failures.push(`search entry "${entry.title}" is copy no pane contains`);
      if (entry.group && !text.includes(`title="${entry.group}"`)) failures.push(`search group "${entry.group}" is no group heading`);
    }
    const indexed = new Set(SETTINGS_SEARCH_PAGES.flatMap((page) => page.groups.flatMap((group) => group.rows.map((row) => row.title))));
    for (const label of labels) if (!indexed.has(label) && !NOT_SETTINGS.has(label)) failures.push(`row "${label}" renders but search cannot find it`);
    const anchor = new Map(SETTINGS_SEARCH_INDEX.entries.map((entry) => [`${entry.pageId}:${entry.title}`, entry.id]));
    const renders = (title, id) => labels.has(title) || text.includes(`label: "${title}"`) || text.includes(`id="${id}"`);
    for (const page of SETTINGS_SEARCH_PAGES) {
      for (const group of page.groups) {
        for (const row of group.rows) {
          if (!row.navigateOnly && !renders(row.title, row.id ?? anchor.get(`${page.id}:${row.title}`) ?? "")) failures.push(`${page.id}: "${row.title}" is indexed but renders nowhere`);
        }
      }
    }
    for (const label of NOT_SETTINGS) if (!labels.has(label)) failures.push(`"${label}" is exempted as a state row but no pane renders it any more`);
    return failures;
  },
};
