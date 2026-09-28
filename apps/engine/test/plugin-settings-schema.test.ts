/**
 * A PLUGIN'S SETTINGS SCHEMA IS PUBLISHED AS DATA — P3.
 *
 * The cockpit's generated pane is drawn from `PluginStatus.settingsSchema` /
 * `machineSettingsSchema`, JSON Schema the host derives from the zod schema it
 * validates writes against. The proof plugin carries every renderer hint.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PluginHost } from "../src/domains/plugins/host";
import { helloPlugin } from "../src/domains/plugins/hello";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-plugin-schema-"));
  dirs.push(dir);
  return dir;
};

type Schema = { properties: Record<string, Record<string, unknown>> };

test("the host publishes both scopes' schemas, with titles, hints and renderer keys", () => {
  const host = new PluginHost([helloPlugin({ resolve: () => ({ projectId: "p", sessionId: "s" }) })], { daemonId: "d", stateDir: tempDir() });
  const [status] = host.statuses();
  const project = status!.settingsSchema as Schema;
  expect(project.properties.greeting).toMatchObject({ type: "string", title: "Greeting", inherits: "greeting" });
  expect(project.properties.slowMs).toMatchObject({ type: "integer", title: "Pretend work", minimum: 0, maximum: 60_000, default: 50 });
  expect(project.properties.slowMs!.info).toBeString();
  const machine = status!.machineSettingsSchema as Schema;
  expect(machine.properties.greeting).toMatchObject({ type: "string", title: "Greeting" });
});

test("a plugin without a schema publishes none, and one that cannot be expressed is left out", () => {
  const meta = { id: "hello", api: 1, name: "Hello", version: "1", toolPrefixes: ["hello"], readTools: [], eventKinds: [], settings: [] };
  const bare = new PluginHost([{ meta }], { daemonId: "d", stateDir: tempDir() }).statuses()[0]!;
  expect(bare.settingsSchema).toBeUndefined();
  // A transform-only schema still answers (as `any`) rather than failing health.
  const odd = new PluginHost([{ meta, settingsSchema: z.object({ at: z.date() }) }], { daemonId: "d", stateDir: tempDir() }).statuses()[0]!;
  expect(odd.settingsSchema).toBeDefined();
});

test("Data Science's and LaTeX's Mac fields are published for the generated pane — and the web fixture matches", async () => {
  const { latexPlugin } = await import("../src/domains/plugins/latex/plugin");
  const { dataSciencePlugin } = await import("../src/domains/plugins/data-science/plugin");
  const never = () => {
    throw new Error("not used");
  };
  const host = new PluginHost(
    [
      latexPlugin({ resolve: never, jobs: { list: () => [], disposeAll: () => {} }, settings: {} as never }),
      dataSciencePlugin({ resolve: never, projectOf: () => undefined, settings: {} as never }),
    ],
    { daemonId: "d", stateDir: tempDir() },
  );
  const [latex, ds] = host.statuses();
  const latexMachine = latex!.machineSettingsSchema as Schema;
  expect(latexMachine.properties.engine).toMatchObject({ title: "Default engine", labels: { pdflatex: "pdfLaTeX" } });
  expect(latexMachine.properties.autoInstallPackages).toMatchObject({ type: "boolean", title: "Install missing packages automatically" });
  const dsMachine = ds!.machineSettingsSchema as Schema;
  expect(dsMachine.properties.python).toMatchObject({ title: "Default Python", widget: "path" });
  // The section labels head the generated groups, so a search anchor survives the move.
  expect(latex!.meta.settings.find((section) => section.scope === "machine")?.label).toBe("Compiling");
  expect(ds!.meta.settings.find((section) => section.scope === "machine")?.label).toBe("Data science defaults");
  // The web renders against a copy of exactly these; a drifted copy fails here.
  const fixture = JSON.parse(
    fs.readFileSync(path.join(import.meta.dir, "../../web/test-fixtures/bundled-machine-schemas.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(fixture).toEqual({ latex: latex!.machineSettingsSchema, dataScience: ds!.machineSettingsSchema });
});
