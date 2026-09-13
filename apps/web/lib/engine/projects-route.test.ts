/**
 * WHAT THE PROJECT PATCH ROUTE IS FOR: forwarding, and nothing else. The engine
 * validates every block and owns every refusal, so the only bug this adapter can
 * have is DROPPING a field — which is exactly the bug it had. The generic
 * `plugins` arm never travelled, so a plugin with no legacy field of its own
 * could be switched on from the project's own page (which calls the engine
 * client directly) and silently not from here.
 *
 * `null` IS THE OTHER HALF. It is a value on this route rather than an absence:
 * `dataScience: null` turns a feature off and `envMode: null` hands a project
 * back to this Mac's standing answer. A truthiness check would drop both and
 * leave the pane unable to undo the choice it had just made — so these tests
 * assert the record afterwards rather than the request.
 *
 * A real daemon on a temp home, like `routes.test.ts` beside it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { PATCH as projectPatch } from "@/app/api/projects/[projectId]/route";
import { startEngine, type EngineDaemon } from "../../../engine/src/daemon";

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

    // The ENGINE's record, not the route's echo.
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
    // The hole this loop exists to catch: a field the picker writes and this
    // route drops on the floor works on the engine and silently does nothing
    // through the cockpit.
    const client = await ready();
    expect((await patch({ iconName: "flask" })).status).toBe(200);
    const stored = (await client.listProjects()).projects.find((project) => project.id === "project_one");
    expect(stored?.iconName).toBe("flask");

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

  test("the legacy arms still travel beside the new ones", async () => {
    const client = await ready();
    await patch({ latex: { enabled: true, mainFile: "paper.tex" } });
    expect(
      (await client.listProjects()).projects.find((project) => project.id === "project_one")?.latex,
    ).toEqual({ enabled: true, mainFile: "paper.tex" });
    await patch({ latex: null });
    expect((await client.listProjects()).projects.find((project) => project.id === "project_one")?.latex).toBeUndefined();
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
