// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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
const sources = readdirSync(here)
  .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
  .map((name) => readFileSync(`${here}${name}`, "utf8"))
  .join("\n");
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
  // "Engine" is a row on two panes — the reason the pane is in the id.
  expect(ids).toContain("settings-row-general-this-build-engine");
  expect(ids).toContain("settings-row-tools-computer-use-engine");
});

test("the questions a person actually types find the row", () => {
  const first = (query: string) => searchSettings(SETTINGS_SEARCH_INDEX, query)[0]?.title;
  expect(first("settle")).toBe("Settle quiet sessions");
  // Found by what it does, not by what it is called.
  expect(first("worktree")).toBe("Workspace");
  expect(first("1password")).toBe("Remembered logins");
  // Half-remembered, and in the wrong number.
  expect(first("name session")).toBe("Name sessions");
  expect(searchSettings(SETTINGS_SEARCH_INDEX, "nothing here at all")).toEqual([]);
});

test("a result carries the pane it lives on, which is what the list shows", () => {
  const hit = searchSettings(SETTINGS_SEARCH_INDEX, "tailscale")[0];
  expect(hit?.pageId).toBe("remote");
  expect(hit?.pageLabel).toBe("Remote access");
});
