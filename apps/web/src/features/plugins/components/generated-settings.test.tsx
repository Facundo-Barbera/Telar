/**
 * A PLUGIN WITH NO BESPOKE PANE GETS A COMPLETE, WORKING ONE.
 *
 * Rendered from the fixture schema: every kind draws its control, a project
 * field with a Mac default offers "Inherit (<Mac value>)", and a change writes
 * the whole settings blob through the same generic arm as the enable switch.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { Project } from "@telar/engine-client";
import { settingsFields } from "../settings-form";
import { FIXTURE_SCHEMA } from "../../../../test-fixtures/plugin-settings-schema";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { GeneratedSettingsRows } = await import("./generated-settings");
const { PluginSettings } = await import("./plugin-settings");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const FIELDS = settingsFields(FIXTURE_SCHEMA);

test("every field draws a labelled control, with its hint and ⓘ", () => {
  const html = renderToStaticMarkup(
    <GeneratedSettingsRows fields={FIELDS} values={{ tone: "dry" }} inherited={{ greeting: "howdy" }} onWrite={async () => {}} />,
  );
  for (const label of ["Shout", "Tone", "Greeting", "Output folder", "Slow ms", "Ratio"]) expect(html).toContain(label);
  expect(html).toContain("Answer in capitals.");
  // The stored choice, read as a label rather than a raw value.
  expect(html).toContain(">dry<");
  // A project field with a Mac default says what it would inherit.
  expect(html).toContain('placeholder="Inherit (howdy)"');
  // A field with a schema default shows it as the placeholder.
  expect(html).toContain('placeholder="50"');
});

test("a select that inherits offers Inherit first, and it is the unset state", () => {
  const inheriting = settingsFields({
    type: "object",
    properties: { tone: { type: "string", enum: ["warm", "dry"], title: "Tone", inherits: "tone" } },
  });
  const html = renderToStaticMarkup(
    <GeneratedSettingsRows fields={inheriting} values={{}} inherited={{ tone: "warm" }} onWrite={async () => {}} />,
  );
  expect(html).toContain("Inherit (warm)");
});

test("a change writes the whole blob, and a refusal says why under the row", async () => {
  const writes: Record<string, unknown>[] = [];
  let refuse = false;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <GeneratedSettingsRows
        fields={FIELDS}
        values={{ tone: "dry" }}
        onWrite={async (next) => {
          if (refuse) throw new Error("hello: greeting is too long");
          writes.push(next);
        }}
      />,
    );
  });
  const shout = host.querySelector('[aria-label="Shout"]') as HTMLElement;
  await act(async () => shout.click());
  expect(writes).toEqual([{ tone: "dry", loud: true }]);

  refuse = true;
  await act(async () => shout.click());
  expect(host.textContent).toContain("hello: greeting is too long");
  act(() => root.unmount());
  host.remove();
});

test("the generic project pane shows the generated fields once the plugin is on", () => {
  const entry = {
    key: "hello",
    pluginId: "hello",
    sectionId: "hello",
    label: "Hello",
    scope: "project" as const,
    state: "ready" as const,
    settingsSchema: FIXTURE_SCHEMA,
  };
  const on = { id: "p", name: "P", root: "/tmp/p", plugins: { version: 1, entries: { hello: { enabled: true } } } } as unknown as Project;
  const off = { id: "p", name: "P", root: "/tmp/p" } as unknown as Project;
  const enabled = renderToStaticMarkup(<PluginSettings entry={entry} project={on} onChange={() => {}} machineSettings={{ greeting: "howdy" }} />);
  expect(enabled).toContain("Output folder");
  expect(enabled).toContain("Inherit (howdy)");
  // Off, it is the switch alone — no settings for a plugin that is not running.
  const disabled = renderToStaticMarkup(<PluginSettings entry={entry} project={off} onChange={() => {}} />);
  expect(disabled).not.toContain("Output folder");
  // And a plugin whose schema has nothing drawable is the switch alone too.
  const bare = renderToStaticMarkup(<PluginSettings entry={{ ...entry, settingsSchema: { type: "object", properties: {} } }} project={on} onChange={() => {}} />);
  expect(bare).not.toContain("Output folder");
});
