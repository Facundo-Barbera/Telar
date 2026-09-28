// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { searchSettings } from "@/lib/settings-search";
import { SETTINGS_SEARCH_INDEX, SETTINGS_SEARCH_PAGES } from "./settings-registry";

/**
 * THE REGISTRY IS A SECOND COPY, so this is the file that keeps it from
 * rotting.
 *
 * A row renamed in its section and not here does not break anything visibly: it
 * keeps appearing in search, keeps navigating to the right pane, and quietly
 * stops scrolling to the row — the kind of decay nobody reports. Both halves
 * are checked against source, the same way `settings-nav.test.ts` pins the
 * route contract.
 */
const here = fileURLToPath(new URL(".", import.meta.url));

/** EVERY .tsx UNDER THIS DIRECTORY, not just its top level. A pane's rows are
 *  not all written in the file named after the pane — the appearance pane's
 *  Show-through row is a component in `studio/`, and a flat read reported it
 *  missing from a pane it is rendered on twice. */
function paneSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}${name}`;
    if (statSync(path).isDirectory()) return paneSources(`${path}/`);
    return name.endsWith(".tsx") && !name.endsWith(".test.tsx") ? [readFileSync(path, "utf8")] : [];
  });
}

const sources = paneSources(here).join("\n");
const nav = readFileSync(new URL("./settings-page.tsx", import.meta.url), "utf8");

test("every indexed pane is a pane the shell can actually select", () => {
  // Choosing a result calls the same `onSelect` the nav button does; an id that
  // drifted from SECTIONS would navigate nowhere at all.
  for (const page of SETTINGS_SEARCH_PAGES) {
    expect(nav).toContain(`{ id: "${page.id}"`);
  }
});

test("every indexed row's title is still copy that exists on a pane", () => {
  const missing = SETTINGS_SEARCH_INDEX.entries.filter((entry) => !sources.includes(entry.title)).map((entry) => entry.title);
  expect(missing).toEqual([]);
});

test("every indexed group is still a group heading that exists", () => {
  const groups = new Set(SETTINGS_SEARCH_INDEX.entries.map((entry) => entry.group).filter(Boolean));
  // The group is half the anchor, so a renamed heading silently moves the id.
  for (const group of groups) {
    expect(sources).toContain(`title="${group}"`);
  }
});

test("no two rows claim the same anchor", () => {
  const ids = SETTINGS_SEARCH_INDEX.entries.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  // The pane is in the id, which is what lets two panes carry a row of the same
  // name. "Engine" used to be the example on both sides; Agent tools answers
  // that question in one row called "Computer use" now (#357).
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
  /**
   * THE DRIFT THE TITLE CHECK CANNOT SEE. "Every title still exists somewhere
   * in this directory" stays true when a whole SECTION moves between panes —
   * which is what #294 did, taking remembered logins out of Agent tools and
   * onto the new Integrations pane. The index went on saying `tools`, so the
   * row kept being found and kept navigating to the pane it had left.
   *
   * Checked for the rows whose copy is distinctive enough to attribute to one
   * file; a title as common as "Engine" appears on two panes on purpose and is
   * covered by the anchor-uniqueness test instead.
   */
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

/**
 * A ROW CANNOT EXIST WITHOUT BEING SEARCHABLE, AND AN ENTRY CANNOT OUTLIVE ITS
 * ROW. Static extraction rather than a render: the panes are lazy and most of
 * their rows appear only once the engine answers, so mounting them here would
 * test the mocks. Every `<Row>`/`<ToggleRow>` with a plain-string label is read
 * out of the pane sources and matched against the registry in both directions.
 */
function renderedLabels(): Set<string> {
  const labels = new Set<string>();
  for (const source of paneSources(here)) {
    for (const [, attrs] of source.matchAll(/<(?:Row|ToggleRow)\b([\s\S]*?)\/?>/g)) {
      const label = /\blabel="([^"]+)"/.exec(attrs ?? "")?.[1];
      if (label) labels.add(label);
    }
  }
  return labels;
}

/**
 * Rows that are not settings: a state the pane is in (loading, empty, failed,
 * not available here). Searching for one would land on a row that is usually
 * not there. A new entry here needs the same excuse.
 */
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
  const sources = paneSources(here).join("\n");
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

test("generated plugin rows join the index on panes that exist, anchored where they render", async () => {
  // settings-page merges them at runtime from the engine's plugin schemas; the
  // two panes it points them at must be panes the shell can select.
  const page = readFileSync(new URL("./settings-page.tsx", import.meta.url), "utf8");
  expect(page).toContain("pluginSettingsSearchEntries(");
  expect(page).toContain('{ project: page("projects"), machine: page("plugins") }');
  for (const id of ["projects", "plugins"]) expect(SETTINGS_SEARCH_PAGES.some((entry) => entry.id === id)).toBe(true);
  // A generated row is found by name like any declared one.
  const { pluginSettingsSearchEntries } = await import("@/lib/plugins/settings-form");
  const { FIXTURE_SCHEMA } = await import("@/test-fixtures/plugin-settings-schema");
  const generated = pluginSettingsSearchEntries(
    [
      {
        meta: { id: "hello", api: 1, name: "Hello", version: "1", toolPrefixes: ["hello"], readTools: [], eventKinds: [], settings: [] },
        state: "ready",
        settingsSchema: FIXTURE_SCHEMA,
      },
    ],
    { project: { id: "projects", label: "Projects" }, machine: { id: "plugins", label: "Plugins" } },
  );
  const results = searchSettings({ entries: [...SETTINGS_SEARCH_INDEX.entries, ...generated] }, "output folder");
  expect(results[0]?.title).toBe("Output folder");
  expect(results[0]?.pageId).toBe("projects");
});
