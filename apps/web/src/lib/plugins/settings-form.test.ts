/**
 * A SCHEMA BECOMES ROWS, and the rows are searchable where they render.
 *
 * The fixture is the JSON Schema the engine publishes for a plugin — the shape
 * zod's `toJSONSchema` writes, `.meta()` keys included — covering every kind the
 * generated pane draws and the two it deliberately leaves to a bespoke block.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import type { PluginStatus } from "@telar/engine-client";
import { settingsRowId } from "@/lib/settings-search";
import { projectPluginSections } from "./sections";
import { FIXTURE_SCHEMA } from "../../../test-fixtures/plugin-settings-schema";
import { generatedGroupTitle, parseNumberField, pluginSettingsSearchEntries, settingsFields } from "./settings-form";


test("every drawable kind becomes a field; lists and nested choices do not", () => {
  const fields = settingsFields(FIXTURE_SCHEMA);
  expect(fields.map((field) => [field.key, field.kind])).toEqual([
    ["loud", "toggle"],
    ["tone", "select"],
    ["greeting", "text"],
    ["folder", "path"],
    ["slowMs", "number"],
    ["ratio", "number"],
  ]);
  const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
  expect(byKey.tone!.options).toEqual(["warm", "dry"]);
  expect(byKey.greeting!.inherits).toBe("greeting");
  expect(byKey.folder!.info).toBe("Relative to the checkout.");
  // A property with no title still gets a readable label.
  expect(byKey.slowMs!.label).toBe("Slow ms");
  expect(byKey.slowMs!.integer).toBe(true);
  expect(byKey.ratio!.max).toBe(1);
  expect(settingsFields(undefined)).toEqual([]);
});

test("a number is checked against the schema before it is written", () => {
  const slow = settingsFields(FIXTURE_SCHEMA).find((field) => field.key === "slowMs")!;
  expect(parseNumberField(slow, "")).toEqual({ value: undefined });
  expect(parseNumberField(slow, "120")).toEqual({ value: 120 });
  expect(parseNumberField(slow, "1.5")).toEqual({ error: "Enter a whole number." });
  expect(parseNumberField(slow, "-1")).toEqual({ error: "At least 0." });
  expect(parseNumberField(slow, "abc")).toEqual({ error: "Enter a number." });
});

const status = (id: string, extra: Partial<PluginStatus> = {}): PluginStatus =>
  ({
    meta: {
      id,
      api: 1,
      name: id === "hello" ? "Hello" : id,
      version: "1",
      toolPrefixes: [id],
      readTools: [],
      eventKinds: [],
      settings: [
        { id: "s", scope: "project", label: "Hello" },
        { id: "m", scope: "machine", label: "Hello defaults" },
      ],
    },
    state: "ready",
    settingsSchema: FIXTURE_SCHEMA,
    machineSettingsSchema: { type: "object", properties: { greeting: { type: "string", title: "Greeting" } } },
    ...extra,
  }) as PluginStatus;

const PAGES = { project: { id: "projects", label: "Projects" }, machine: { id: "plugins", label: "Plugins" } };

test("generated rows are searchable, anchored where the pane draws them", () => {
  const entries = pluginSettingsSearchEntries([status("hello")], PAGES);
  expect(entries.map((entry) => `${entry.pageId}:${entry.title}`)).toEqual([
    "projects:Shout",
    "projects:Tone",
    "projects:Greeting",
    "projects:Output folder",
    "projects:Slow ms",
    "projects:Ratio",
    "plugins:Greeting",
  ]);
  // The generic project pane heads its group with the plugin's first section —
  // the same title the anchor is derived from.
  expect(projectPluginSections([status("hello")])[0]!.label).toBe(generatedGroupTitle(status("hello"), "project"));
  expect(entries[0]!.id).toBe(settingsRowId({ page: "projects", group: "Hello", label: "Shout" }));
  expect(entries.at(-1)!.id).toBe(settingsRowId({ page: "plugins", group: "Hello defaults", label: "Greeting" }));
  // Found by the plugin's name too, not only the field's.
  expect(entries[0]!.folded.hint).toContain("hello");
});

test("a scope whose pane is bespoke indexes no generated rows", () => {
  const entries = pluginSettingsSearchEntries([status("latex")], PAGES, (scope) => scope === "project");
  expect(entries.map((entry) => entry.pageId)).toEqual(["plugins"]);
});

test("the section entry carries the schema to the generated pane, once", () => {
  const [first] = projectPluginSections([status("hello")]);
  expect(first!.settingsSchema).toBe(FIXTURE_SCHEMA);
});
