// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { foldForSearch, settingsRowId } from "./settings-search";

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
