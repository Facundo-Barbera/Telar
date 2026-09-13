/**
 * LATEX AFTER THE MIGRATION — the properties a user would notice if this went
 * wrong, and nothing about how the plugin is wired internally.
 *
 * The migration's whole risk is that it changes something a person already
 * depends on. So each case here is a preserved behaviour:
 *
 *   the released client's `/latex/<method>` still answers
 *   the generic `/plugins/latex/<method>` answers IDENTICALLY — one door
 *     cannot drift from the other, because both dispatch the same route table
 *   a project that has not enabled LaTeX is refused, in the same words
 *   the legacy `Project.latex` mirror is still written, so a rollback keeps
 *     the user's toolchain and main file
 *   LaTeX's tools keep their shipped qualified names, so no stored approval is
 *     orphaned
 *
 * Temp engine root, temp checkout. No TeX is installed and none is needed: every
 * case stops at the gate or at toolchain resolution, which is exactly where a
 * machine without TeX stops anyway.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EngineClient,
  TELAR_MCP_SERVER,
  canonicalToolName,
  parseToolName,
  pluginEnabled,
  readProjectPlugins,
  type EngineClientError,
} from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { latexMeta } from "../src/plugins/latex";
import { bundledPluginToolModules } from "../src/plugins/bundled";
import { ratifiedReadTools } from "../src/plugins/policy";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-latex-migration-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function ready(options: { enable?: boolean } = {}) {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  if (options.enable) {
    // A toolchain whose binary EXISTS, because `resolveLatex` checks the path on
    // disk before it will hand out a capability. `/bin/echo` is never executed
    // by any case here — every one stops at the gate or at a status read.
    await client.updateProject("project_one", {
      latex: { enabled: true, mainFile: "paper.tex", toolchain: { kind: "texlive", path: "/bin/echo" } },
    });
  }
  await client.createSession({ id: "session_one", projectId: "project_one" });
  return { daemon, client };
}

/** Both doors, called the same way, so their answers can be compared. */
const legacyDoor = (client: EngineClient, method: string, body?: unknown) => client.latex("session_one", method, body);
const genericDoor = (client: EngineClient, method: string, body?: unknown) => client.plugin("session_one", "latex", method, body);

test("LaTeX is a registered plugin, and the host — not its manifest — decides its reads", async () => {
  const { client } = await ready();
  const health = await client.health();
  const latex = health.plugins?.find((status) => status.meta.id === "latex");
  expect(latex?.state).toBe("ready");

  // The manifest claims nothing, because ratifying LaTeX's reads would stop
  // them parking an approval card — a widening this migration does not make.
  expect(latexMeta.readTools).toEqual([]);
  expect(ratifiedReadTools(latexMeta)).toEqual([]);
});

test("the released client's door and the generic plugin door give the SAME answer", async () => {
  const { client } = await ready({ enable: true });

  // `status` needs no TeX: it reports that nothing has been compiled yet.
  const legacy = await legacyDoor(client, "status");
  const generic = await genericDoor(client, "status");
  expect(generic).toEqual(legacy);

  // The two are one implementation now — the switch statement that used to sit
  // beside the route table is gone, so they cannot answer differently.
  expect(legacy).toBeDefined();
});

test("a project that has not enabled LaTeX is refused at BOTH doors, in the same words", async () => {
  const { client } = await ready();

  const legacy = await legacyDoor(client, "status").catch((error: EngineClientError) => error);
  const generic = await genericDoor(client, "status").catch((error: EngineClientError) => error);

  expect((legacy as EngineClientError).message).toContain("not enabled");
  expect((generic as EngineClientError).message).toContain("not enabled");
});

test("an unknown verb is a 404 about the method, not a 500", async () => {
  const { client } = await ready({ enable: true });
  await expect(legacyDoor(client, "nosuchverb")).rejects.toMatchObject({ status: 404 } satisfies Partial<EngineClientError>);
  await expect(genericDoor(client, "nosuchverb")).rejects.toMatchObject({ status: 404 } satisfies Partial<EngineClientError>);
});

test("the legacy mirror is still written, so rolling back keeps the user's settings", async () => {
  const { daemon } = await ready({ enable: true });

  const stored = JSON.parse(fs.readFileSync(path.join(daemon.store.paths.root, "projects.json"), "utf8")).projects[0];

  // The map is authoritative…
  expect(pluginEnabled(readProjectPlugins(stored).plugins, "latex")).toBe(true);

  // …and the legacy block is written beside it, in the same atomic write, for
  // exactly one reader: an OLDER engine binary. Removing it is a deliberate
  // compatibility decision, not something a migration does on the way past.
  expect(stored.latex).toEqual({ enabled: true, mainFile: "paper.tex", toolchain: { kind: "texlive", path: "/bin/echo" } });
});

test("LaTeX's tools keep their shipped names, so no stored approval is orphaned", () => {
  // THE COMPATIBILITY DECISION, pinned. `latex_compile` ships as
  // `mcp__telar__latex_compile`; serving it from the plugin socket would rename
  // it and orphan every grant a user has given it.
  expect(canonicalToolName(TELAR_MCP_SERVER, "latex_compile")).toBe("mcp__telar__latex_compile");
  expect(parseToolName("mcp__telar__latex_compile").capability).toBe("latex");

  // …which is why LaTeX contributes NO wall to the plugin socket. Its engine
  // module migrated; its tool registration deliberately did not.
  expect(bundledPluginToolModules().map((module) => module.meta.id)).not.toContain("latex");
});
