// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { foldForSearch, indexSettings, searchSettings, settingsRowId, type SettingsPageSpec } from "./settings-search";

test("folding makes accents and apostrophes invisible to a search", () => {
  // Both directions: the typed query and the indexed copy go through the same
  // function, so "busqueda" finding "Búsqueda" and the reverse are one rule.
  expect(foldForSearch("Búsqueda")).toBe(foldForSearch("busqueda"));
  expect(foldForSearch("Session’s")).toBe("sessions");
  expect(foldForSearch("Session's")).toBe("sessions");
});

test("a row id names the pane and the group it sits in", () => {
  // Two panes may both hold a "Model" row; the anchor has to name one of them.
  expect(settingsRowId({ page: "general", group: "Generated text", label: "Model" })).toBe(
    "settings-row-general-generated-text-model",
  );
  expect(settingsRowId({ page: "general", group: "Generated text", label: "Model" })).not.toBe(
    settingsRowId({ page: "providers", group: "Logins", label: "Model" }),
  );
});

test("punctuation in a label never reaches the id", () => {
  expect(settingsRowId({ page: "general", group: "Links", label: "Open in the session's browser" })).toBe(
    "settings-row-general-links-open-in-the-sessions-browser",
  );
});

test("a row outside a shell still has an id", () => {
  // `Row` is mounted alone in tests and inside Panels that are not a group.
  expect(settingsRowId({ label: "Engine" })).toBe("settings-row-engine");
});

/** A registry small enough to reason about, so the ranking is pinned by its
 *  own shape rather than by whichever real row happens to sort first today. */
const PAGES: SettingsPageSpec[] = [
  {
    id: "general",
    label: "General",
    groups: [
      { title: "Settling", rows: [{ title: "Settle quiet sessions", hint: "Nothing leaves the list on its own." }] },
      { title: "New sessions", rows: [{ title: "Workspace", hint: "Its own checkout and branch.", keywords: ["worktree"] }] },
    ],
  },
  {
    id: "remote",
    label: "Remote access",
    groups: [{ title: "Pairing", rows: [{ title: "Require pairing", hint: "Unpaired devices are refused." }] }],
  },
];
const index = indexSettings(PAGES);
const titles = (query: string) => searchSettings(index, query).map((entry) => entry.title);

test("the index knows about panes nobody has opened", () => {
  // The whole point: rows are declared, so they are findable before the pane
  // that renders them has ever mounted.
  expect(index.entries).toHaveLength(3);
  expect(index.entries[0]?.id).toBe("settings-row-general-settling-settle-quiet-sessions");
  expect(index.entries[0]?.pageLabel).toBe("General");
});

test("the row whose title starts with the query leads", () => {
  // Three rows match "se" — one by its title's first letters, one through its
  // hint, one only through the group it sits in — and that is the order.
  expect(titles("se")).toEqual(["Settle quiet sessions", "Require pairing", "Workspace"]);
});

test("the title outranks the hint, and the hint outranks the pane", () => {
  // "pairing" is a title word on one row and a group name on nothing else here.
  expect(titles("pairing")).toEqual(["Require pairing"]);
  // Found only through the hint.
  expect(titles("checkout")).toEqual(["Workspace"]);
  // Found only through the pane it lives on.
  expect(titles("remote")).toEqual(["Require pairing"]);
});

test("a keyword is matched but never shown", () => {
  const hit = searchSettings(index, "worktree")[0];
  expect(hit?.title).toBe("Workspace");
  // Keywords ride with the hint for matching; the result still shows the row.
  expect(hit?.hint).toBe("Its own checkout and branch.");
});

test("several terms match in any order, as a last resort", () => {
  expect(titles("quiet settle")).toEqual(["Settle quiet sessions"]);
});

test("an empty query is not a match-everything", () => {
  // The nav comes back when the field is cleared; an empty query returning the
  // whole index would put a list of every setting where the nav was.
  expect(searchSettings(index, "")).toEqual([]);
  expect(searchSettings(index, "   ")).toEqual([]);
});

test("a query with regex punctuation is text, not a pattern", () => {
  expect(() => searchSettings(index, "c++ (")).not.toThrow();
  expect(searchSettings(index, "c++ (")).toEqual([]);
});
