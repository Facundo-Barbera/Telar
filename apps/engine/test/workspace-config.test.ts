/**
 * THE `workspace` DOCUMENT — machine defaults, a repo's proposal, and each
 * project's overrides, resolved field by field (`workspace-config.ts`).
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { WorkspaceConfigStore, readWorkspaceProposal } from "../src/workspace-config";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-workspace-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function propose(checkout: string, config: unknown): void {
  fs.mkdirSync(path.join(checkout, ".telar"), { recursive: true });
  fs.writeFileSync(path.join(checkout, ".telar", "workspace.json"), typeof config === "string" ? config : JSON.stringify(config));
}

test("project overrides beat the repo's proposal, which beats the machine; env merges by key", async () => {
  const store = new WorkspaceConfigStore(path.join(root(), "workspace.json"));
  const checkout = root();
  expect(store.setMachine({ setup: { command: "machine-setup" }, env: { A: "machine", B: "machine" } }).ok).toBe(true);
  propose(checkout, { setup: { command: "repo-setup" }, env: { B: "repo" }, ports: { names: ["PORT"] } });
  expect(store.setOverrides("p1", { env: { C: "project" }, ports: null }).ok).toBe(true);

  const view = await store.view({ id: "p1", root: checkout });
  expect(view.effective).toEqual({ setup: { command: "repo-setup" }, env: { A: "machine", B: "repo", C: "project" } });
  expect(view.sources).toEqual({ setup: "proposed", env: "project", ports: "off" });
});

test("null turns a field off even when the machine and the repo both set it", async () => {
  const store = new WorkspaceConfigStore(path.join(root(), "workspace.json"));
  const checkout = root();
  store.setMachine({ env: { A: "1" } });
  propose(checkout, { env: { B: "2" } });
  store.setOverrides("p1", { env: null });
  const view = await store.view({ id: "p1", root: checkout });
  expect(view.effective.env).toBeUndefined();
  expect(view.sources.env).toBe("off");
});

test("a malformed proposal costs the proposal and says why; the machine layer still applies", async () => {
  const store = new WorkspaceConfigStore(path.join(root(), "workspace.json"));
  const checkout = root();
  store.setMachine({ setup: { command: "bun install" } });
  propose(checkout, "{ not json");
  const view = await store.view({ id: "p1", root: checkout });
  expect(view.proposal.error).toContain("not JSON");
  expect(view.effective).toEqual({ setup: { command: "bun install" } });

  propose(checkout, { seedDependencies: { paths: ["../outside"] } });
  expect((await readWorkspaceProposal(checkout)).error).toContain("inside the worktree");
});

test("writes refuse paths that leave the worktree and names that no shell could export", () => {
  const store = new WorkspaceConfigStore(path.join(root(), "workspace.json"));
  expect(store.setMachine({ artifacts: [{ path: "/Users/someone" }] })).toMatchObject({ ok: false });
  expect(store.setMachine({ seedDependencies: { paths: ["a/../../b"] } })).toMatchObject({ ok: false });
  expect(store.setMachine({ seedDependencies: { paths: ["C:\\Users\\someone"] } })).toMatchObject({ ok: false });
  expect(store.setMachine({ seedDependencies: { paths: ["a\\..\\..\\b"] } })).toMatchObject({ ok: false });
  expect(store.setMachine({ seedDependencies: { paths: ["\\\\server\\share"] } })).toMatchObject({ ok: false });
  expect(store.setMachine({ seedDependencies: { paths: ["apps\\web\\node_modules"] } })).toMatchObject({ ok: true });
  store.setMachine({});
  expect(store.setMachine({ env: { "NOT-A-NAME": "x" } })).toMatchObject({ ok: false });
  expect(store.setOverrides("p1", { setup: { command: "" } })).toMatchObject({ ok: false });
  expect(store.machine()).toEqual({});
});

test("a hand-edited document costs the bad entry, not its neighbours", () => {
  const file = path.join(root(), "workspace.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, machine: { env: { A: "1" } }, projects: { good: { ports: null }, bad: { setup: 42 } } }),
  );
  const store = new WorkspaceConfigStore(file);
  expect(store.machine()).toEqual({ env: { A: "1" } });
  expect(store.overrides("good")).toEqual({ ports: null });
  expect(store.overrides("bad")).toEqual({});
  fs.writeFileSync(file, "garbage");
  expect(store.machine()).toEqual({});
});

test("an empty override set leaves nothing behind for that project", () => {
  const file = path.join(root(), "workspace.json");
  const store = new WorkspaceConfigStore(file);
  store.setOverrides("p1", { env: { A: "1" } });
  store.setOverrides("p1", {});
  expect(JSON.parse(fs.readFileSync(file, "utf8")).projects).toEqual({});
});

test("over the wire: the machine layer and a project's view round-trip, and bad input is a 400", async () => {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const checkout = root();
  await client.registerProject({ id: "project_one", name: "One", root: checkout });
  propose(checkout, { ports: { names: ["PORT", "API_PORT"] } });

  expect((await client.setMachineWorkspace({ setup: { command: "bun install --frozen-lockfile" } })).machine).toEqual({
    setup: { command: "bun install --frozen-lockfile" },
  });
  const { workspace } = await client.setProjectWorkspace("project_one", { setup: { command: "make", blocking: true } });
  expect(workspace.effective).toEqual({ setup: { command: "make", blocking: true }, ports: { names: ["PORT", "API_PORT"] } });
  expect(workspace.sources).toEqual({ setup: "project", ports: "proposed" });
  expect((await client.projectWorkspace("project_one")).workspace.overrides).toEqual({ setup: { command: "make", blocking: true } });

  await expect(client.setMachineWorkspace({ env: { "1BAD": "x" } } as never)).rejects.toThrow();
  await expect(client.projectWorkspace("project_missing")).rejects.toThrow();
  expect(fs.existsSync(daemon.store.paths.workspace)).toBe(true);
});
