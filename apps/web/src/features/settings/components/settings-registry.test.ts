import { expect, test } from "bun:test";
import type { PluginStatus } from "@telar/engine-client";
import { searchSettings } from "../search";
import { SETTINGS_SEARCH_INDEX, SETTINGS_SEARCH_PAGES } from "../registry";
import { SECTION_IDS, settingsSearchIndex } from "../settings-sections";

test("every indexed pane is a pane the shell can actually select", () => {
  for (const page of SETTINGS_SEARCH_PAGES) {
    expect(SECTION_IDS).toContain(page.id);
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

test("generated plugin rows join the index on the Projects and Plugins panes", async () => {
  const { FIXTURE_SCHEMA } = await import("../../../../test-fixtures/plugin-settings-schema");
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
