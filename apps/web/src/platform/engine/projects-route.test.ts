/**
 * The route only forwards; its one possible bug is dropping a field. `null` is a
 * value here (turns a feature off, hands back to the Mac's default), so tests
 * assert the stored record. Runs a real daemon on a temp home.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { PATCH as projectPatch } from "@/app/api/projects/[projectId]/route";
import { startEngine, type EngineDaemon } from "../../../../engine/src/daemon";

const savedTelarHome = process.env.TELAR_HOME;
const savedTelarCockpit = process.env.TELAR_COCKPIT;
const roots: string[] = [];
const daemons: EngineDaemon[] = [];

afterEach(() => {
  return Promise.all(daemons.splice(0).reverse().map((daemon) => daemon.close())).then(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    if (savedTelarHome === undefined) delete process.env.TELAR_HOME;
    else process.env.TELAR_HOME = savedTelarHome;
    if (savedTelarCockpit === undefined) delete process.env.TELAR_COCKPIT;
    else process.env.TELAR_COCKPIT = savedTelarCockpit;
  });
});

async function ready(): Promise<EngineClient> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-projects-route-"));
  roots.push(home);
  process.env.TELAR_HOME = home;
  process.env.TELAR_COCKPIT = "1";
  const daemon = await startEngine({ engineRoot: path.join(home, "engine") });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  fs.mkdirSync(path.join(home, "one"));
  await client.registerProject({ id: "project_one", name: "One", root: path.join(home, "one") });
  return client;
}

const patch = (payload: unknown) =>
  projectPatch(
    new Request("http://telar.local/api/projects/project_one", { method: "PATCH", body: JSON.stringify(payload) }),
    { params: Promise.resolve({ projectId: "project_one" }) },
  );

describe("PATCH /api/projects/:projectId", () => {
  test("carries the four identity fields through to the engine", async () => {
    const client = await ready();
    const response = await patch({
      name: "Telar",
      iconEmoji: "🧵",
      envMode: "worktree",
      defaultModel: { instanceId: "claude", model: "opus", effort: "high" },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).project).toMatchObject({ name: "Telar", envMode: "worktree" });

    const stored = (await client.listProjects()).projects.find((project) => project.id === "project_one");
    expect(stored).toMatchObject({
      name: "Telar",
      iconEmoji: "🧵",
      envMode: "worktree",
      defaultModel: { instanceId: "claude", model: "opus", effort: "high" },
    });
  });

  test("`null` travels, so a choice can be undone", async () => {
    const client = await ready();
    await patch({ envMode: "worktree", iconEmoji: "🧵", defaultModel: { instanceId: "claude", model: "opus" } });
    const response = await patch({ envMode: null, iconEmoji: null, defaultModel: null });
    expect(response.status).toBe(200);

    const stored = (await client.listProjects()).projects.find((project) => project.id === "project_one");
    expect(stored?.envMode).toBeUndefined();
    expect(stored?.iconEmoji).toBeUndefined();
    expect(stored?.defaultModel).toBeUndefined();
  });

  test("the picked glyph travels too, and Auto-detect clears it (#364)", async () => {
    const client = await ready();
    expect((await patch({ iconName: "flask-conical" })).status).toBe(200);
    const stored = (await client.listProjects()).projects.find((project) => project.id === "project_one");
    expect(stored?.iconName).toBe("flask-conical");

    expect((await patch({ iconName: null, iconEmoji: null })).status).toBe(200);
    const cleared = (await client.listProjects()).projects.find((project) => project.id === "project_one");
    expect(cleared?.iconName).toBeUndefined();
  });

  test("the generic plugins arm travels — the hole this route had", async () => {
    const client = await ready();
    const response = await patch({ plugins: { hello: { enabled: true, settings: { greeting: "hola" } } } });
    expect(response.status).toBe(200);

    const stored = (await client.listProjects()).projects.find((project) => project.id === "project_one");
    expect(stored?.plugins?.entries?.hello?.enabled).toBe(true);
  });

  test("the legacy arms still travel beside the new ones, and land in the map", async () => {
    const client = await ready();
    const latex = async () => (await client.listProjects()).projects.find((project) => project.id === "project_one")?.plugins?.entries?.latex;
    await patch({ latex: { enabled: true, mainFile: "paper.tex" } });
    expect(await latex()).toEqual({ enabled: true, settings: { mainFile: "paper.tex" } });
    await patch({ latex: null });
    expect(await latex()).toBeUndefined();
  });

  test("the engine owns the refusal, and its status comes through unchanged", async () => {
    await ready();
    const response = await patch({ envMode: "elsewhere" });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  test("a field the contract does not know is not forwarded", async () => {
    const client = await ready();
    const response = await patch({ root: "/etc", name: "Telar" });
    expect(response.status).toBe(200);
    const stored = (await client.listProjects()).projects.find((project) => project.id === "project_one");
    expect(stored?.name).toBe("Telar");
    expect(stored?.root).not.toBe("/etc");
  });
});
