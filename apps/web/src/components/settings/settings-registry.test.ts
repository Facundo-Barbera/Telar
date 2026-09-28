// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PluginStatus } from "@telar/engine-client";
import { searchSettings } from "@/lib/settings-search";
import { SETTINGS_SEARCH_INDEX, SETTINGS_SEARCH_PAGES } from "./settings-registry";
import { SECTION_IDS, settingsSearchIndex } from "./settings-sections";

const here = fileURLToPath(new URL(".", import.meta.url));

const srcRoot = fileURLToPath(new URL("../../", import.meta.url));

function tsxSources(dir: string): { path: string; text: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}${name}`;
    if (statSync(path).isDirectory()) return tsxSources(`${path}/`);
    return name.endsWith(".tsx") && !name.endsWith(".test.tsx") ? [{ path, text: readFileSync(path, "utf8") }] : [];
  });
}

// Panes live in this folder or in a feature folder that builds on the settings shell.
const paneSources = (): string[] =>
  tsxSources(srcRoot)
    .filter(({ path, text }) => path.startsWith(here) || text.includes('/settings-shell"'))
    .map(({ text }) => text);

const sources = paneSources().join("\n");

test("every indexed pane is a pane the shell can actually select", () => {
  for (const page of SETTINGS_SEARCH_PAGES) {
    expect(SECTION_IDS).toContain(page.id);
  }
});

test("every indexed row's title is still copy that exists on a pane", () => {
  const missing = SETTINGS_SEARCH_INDEX.entries.filter((entry) => !sources.includes(entry.title)).map((entry) => entry.title);
  expect(missing).toEqual([]);
});

test("every indexed group is still a group heading that exists", () => {
  const groups = new Set(SETTINGS_SEARCH_INDEX.entries.map((entry) => entry.group).filter(Boolean));
  for (const group of groups) {
    expect(sources).toContain(`title="${group}"`);
  }
});

test("no two rows claim the same anchor", () => {
  const ids = SETTINGS_SEARCH_INDEX.entries.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain("settings-row-about-this-build-engine");
  expect(ids).toContain("settings-row-tools-computer-use");
});

test("the questions a person actually types find the row", () => {
  const first = (query: string) => searchSettings(SETTINGS_SEARCH_INDEX, query)[0]?.title;
  expect(first("settle")).toBe("Settle quiet sessions");
  // A title that starts with the word leads; the cleanup row is still found.
  expect(first("worktree")).toBe("Worktree preparation");
  expect(searchSettings(SETTINGS_SEARCH_INDEX, "worktree").map((hit) => hit.title)).toContain("Delete inactive worktrees");
  expect(searchSettings(SETTINGS_SEARCH_INDEX, "worktree").map((hit) => hit.title)).toContain("Workspace");
  // A symptom, not a destination.
  expect(first("disk space")).toBe("Delete inactive worktrees");
  expect(first("1password")).toBe("Remembered logins");
  expect(first("cookies")).toBe("Browser profiles");
  // Half-remembered, and in the wrong number.
  expect(first("name session")).toBe("Name sessions");
  expect(searchSettings(SETTINGS_SEARCH_INDEX, "nothing here at all")).toEqual([]);
});

test("every indexed row is declared on the pane that actually renders it", () => {
  const paneOf: Record<string, string> = {
    "Remembered logins": "integrations",
    "Browser profiles": "integrations",
    "Add a server": "tools",
    "Add a Mac": "remote",
    "Settle quiet sessions": "general",
    "Add a login": "providers",
  };
  for (const [title, pageId] of Object.entries(paneOf)) {
    const entry = SETTINGS_SEARCH_INDEX.entries.find((candidate) => candidate.title === title);
    expect(entry?.pageId).toBe(pageId);
  }
});

test("a result carries the pane it lives on, which is what the list shows", () => {
  const hit = searchSettings(SETTINGS_SEARCH_INDEX, "tailscale")[0];
  expect(hit?.pageId).toBe("remote");
  expect(hit?.pageLabel).toBe("Remote access");
});

// Static extraction: the panes are lazy and most rows need the engine to answer.
function renderedLabels(): Set<string> {
  const labels = new Set<string>();
  for (const source of paneSources()) {
    for (const [, attrs] of source.matchAll(/<(?:Row|ToggleRow)\b([\s\S]*?)\/?>/g)) {
      const label = /\blabel="([^"]+)"/.exec(attrs ?? "")?.[1];
      if (label) labels.add(label);
    }
  }
  return labels;
}

// Rows that are a state the pane is in, not a setting.
const NOT_SETTINGS = new Set([
  "Could not read plugins",
  "Could not save",
  "Desktop app only",
  "Detecting",
  "Did not start",
  "Loading",
  "No hubs configured",
  "No other TeX install found",
  "No phone can be reached yet",
  "No plugins registered",
  "No remembered logins",
  "No servers configured",
  "No update feed in this build",
  "None yet",
  "Not available here",
  "Restart to apply",
  "The engine did not answer",
]);

test("every rendered row with a fixed label has a search entry", () => {
  const indexed = new Set(SETTINGS_SEARCH_PAGES.flatMap((page) => page.groups.flatMap((group) => group.rows.map((row) => row.title))));
  const missing = [...renderedLabels()].filter((label) => !indexed.has(label) && !NOT_SETTINGS.has(label)).sort();
  expect(missing).toEqual([]);
});

test("every search entry points at a row that renders, unless it says it lands on a pane", () => {
  const labels = renderedLabels();
  const sources = paneSources().join("\n");
  // A row is rendered if a Row carries its label, a row descriptor mapped into
  // Rows names it (`label: "Setup"`), or it spells its anchor out by hand.
  const renders = (title: string, id: string) =>
    labels.has(title) || sources.includes(`label: "${title}"`) || sources.includes(`id="${id}"`);
  const anchor = new Map(SETTINGS_SEARCH_INDEX.entries.map((entry) => [`${entry.pageId}:${entry.title}`, entry.id]));
  const dangling = SETTINGS_SEARCH_PAGES.flatMap((page) =>
    page.groups.flatMap((group) =>
      group.rows
        .filter((row) => !row.navigateOnly && !renders(row.title, row.id ?? anchor.get(`${page.id}:${row.title}`) ?? ""))
        .map((row) => `${page.id}: ${row.title}`),
    ),
  );
  expect(dangling).toEqual([]);
  // And the exemption list stays honest: a label that became a setting, or went away, leaves it.
  for (const label of NOT_SETTINGS) expect(labels.has(label)).toBe(true);
});

test("generated plugin rows join the index on the Projects and Plugins panes", async () => {
  const { FIXTURE_SCHEMA } = await import("../../../test-fixtures/plugin-settings-schema");
  const plugin: PluginStatus = {
    meta: { id: "hello", api: 1, name: "Hello", version: "1", toolPrefixes: ["hello"], readTools: [], eventKinds: [], settings: [] },
    state: "ready",
    settingsSchema: FIXTURE_SCHEMA,
    machineSettingsSchema: FIXTURE_SCHEMA,
  };
  expect(settingsSearchIndex([], () => false)).toBe(SETTINGS_SEARCH_INDEX);

  const hits = searchSettings(settingsSearchIndex([plugin], () => false), "output folder");
  expect(hits.map((hit) => [hit.pageId, hit.pageLabel])).toEqual([
    ["projects", "Projects"],
    ["plugins", "Plugins"],
  ]);

  const bespoke = settingsSearchIndex([plugin], (scope) => scope === "project");
  expect(searchSettings(bespoke, "output folder").map((hit) => hit.pageId)).toEqual(["plugins"]);
});
