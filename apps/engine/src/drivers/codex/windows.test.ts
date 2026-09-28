import { expect, test } from "bun:test";
import type { ProviderModel } from "@telar/engine-client";
import { parseCodexWindows, withCodexLongRows } from "./windows";

const row = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  label: id,
  isDefault: false,
  hidden: false,
  hiddenByUser: false,
  legacy: false,
  source: "provider",
  efforts: [],
  fastMode: false,
  ...extra,
});

const CATALOG = JSON.stringify({
  models: [
    { slug: "gpt-6-sol", context_window: 272000, max_context_window: 872000 },
    { slug: "gpt-5.5", context_window: 272000, max_context_window: 272000 },
    { slug: "broken" },
  ],
});

test("the catalog is read per slug, and a row with no window is skipped", () => {
  const windows = parseCodexWindows(CATALOG);
  expect(windows.get("gpt-6-sol")).toEqual({ context: 272_000, max: 872_000 });
  expect(windows.get("gpt-5.5")).toEqual({ context: 272_000, max: 272_000 });
  expect(windows.has("broken")).toBeFalse();
  expect(parseCodexWindows("not json").size).toBe(0);
});

test("a model with a long window gains a [1m] row; one without does not", () => {
  const rows = withCodexLongRows([row("gpt-6-sol", { isDefault: true }), row("gpt-5.5")], parseCodexWindows(CATALOG));
  expect(rows.map((model) => [model.id, model.isDefault, model.defaultWindow])).toEqual([
    ["gpt-6-sol", true, true],
    ["gpt-6-sol[1m]", false, undefined],
    ["gpt-5.5", false, undefined],
  ]);
});
