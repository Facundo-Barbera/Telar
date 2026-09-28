import { expect, test } from "bun:test";
import { renderedLabels } from "./settings-search.mjs";

test("a fixed row label is read off Row and ToggleRow, not off anything else", () => {
  const labels = renderedLabels(['<Row label="Name sessions" hint="x" />', '<ToggleRow\n  label="Settle quiet sessions"\n/>', '<Button label="Save" />']);
  expect([...labels]).toEqual(["Name sessions", "Settle quiet sessions"]);
});
