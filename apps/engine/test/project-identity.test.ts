/**
 * WHAT A PROJECT IS CALLED, WHAT IT LOOKS LIKE, AND WHAT ITS CONVERSATIONS OPEN
 * ON — the four fields `PATCH /v2/projects/:id` grew so the Projects pane could
 * stop rendering its rows as unavailable (#308).
 *
 * THE CASES THAT MATTER ARE THE ABSENCES. Each of these fields has a meaning for
 * "not stored" that no value of it can express — `envMode` absent means "follow
 * this Mac's standing answer", which is a different sentence from `"local"` — so
 * the tests below are mostly about `null` REMOVING a key rather than writing a
 * neutral one, and about a refusal leaving the record untouched.
 *
 * Both halves are covered: the store's own write path, and the HTTP arms in
 * front of it, which are what a malformed body actually meets. Every case uses a
 * temp home and a temp checkout; nothing reads the real `~/.telar`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { EngineStateError, EngineStore } from "../src/state";
import { startEngine, type EngineDaemon } from "../src/daemon";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const dir = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function readyStore(): EngineStore {
  const store = new EngineStore(dir("telar-identity-home-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: dir("telar-identity-checkout-") });
  return store;
}

/** What is actually on disk, before any schema parse re-shapes it. */
function onDisk(store: EngineStore): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(store.paths.root, "projects.json"), "utf8")).projects[0];
}

describe("the store's write path", () => {
  test("a rename lands, is trimmed, and leaves the root alone", () => {
    const store = readyStore();
    const before = store.getProject("project_one").root;
    const project = store.updateProject("project_one", { name: "  Telar  " });
    expect(project.name).toBe("Telar");
    expect(project.root).toBe(before);
    expect(onDisk(store).name).toBe("Telar");
  });

  test("an empty rename is refused and the old name survives", () => {
    const store = readyStore();
    expect(() => store.updateProject("project_one", { name: "   " })).toThrow(EngineStateError);
    expect(store.getProject("project_one").name).toBe("One");
  });

  test("the three optional answers store, and `null` REMOVES the key rather than neutralising it", () => {
    const store = readyStore();
    const set = store.updateProject("project_one", {
      iconEmoji: "🧵",
      envMode: "worktree",
      defaultModel: { instanceId: "claude", model: "opus", effort: "high" },
    });
    expect(set.iconEmoji).toBe("🧵");
    expect(set.envMode).toBe("worktree");
    expect(set.defaultModel).toEqual({ instanceId: "claude", model: "opus", effort: "high" });

    const cleared = store.updateProject("project_one", { iconEmoji: null, envMode: null, defaultModel: null });
    // ABSENT, not `"local"` and not `{}` — absence is what "follow this Mac"
    // is spelled as, and a neutral value could not say it.
    expect("iconEmoji" in cleared).toBe(false);
    expect("envMode" in cleared).toBe(false);
    expect("defaultModel" in cleared).toBe(false);
    const stored = onDisk(store);
    expect(stored.envMode).toBeUndefined();
    expect(stored.defaultModel).toBeUndefined();
  });

  test("one field moves without disturbing the others, or the plugin map", () => {
    const store = readyStore();
    store.updateProject("project_one", { latex: { enabled: true }, envMode: "worktree", iconEmoji: "🧵" });
    const project = store.updateProject("project_one", { name: "Renamed" });
    expect(project.name).toBe("Renamed");
    expect(project.envMode).toBe("worktree");
    expect(project.iconEmoji).toBe("🧵");
    expect(project.latex).toEqual({ enabled: true });
  });

  test("an invalid selection is refused BEFORE anything is written", () => {
    const store = readyStore();
    store.updateProject("project_one", { envMode: "worktree" });
    // A selection that selects nothing is an absent selection — the contract
    // refuses it, and so must this.
    expect(() => store.updateProject("project_one", { defaultModel: { instanceId: "claude" } as never })).toThrow(EngineStateError);
    expect(() => store.updateProject("project_one", { envMode: "somewhere" as never })).toThrow(EngineStateError);
    const project = store.getProject("project_one");
    expect(project.envMode).toBe("worktree");
    expect(project.defaultModel).toBeUndefined();
  });

  test("a removed project's identity is frozen like the rest of its settings", () => {
    const store = readyStore();
    store.unregisterProject("project_one");
    expect(() => store.updateProject("project_one", { name: "Renamed" })).toThrow(EngineStateError);
  });
});

describe("PATCH /v2/projects/:id", () => {
  async function daemon(): Promise<{ client: EngineClient; port: number; token: string }> {
    const home = dir("telar-identity-daemon-");
    const started = await startEngine({ engineRoot: home });
    daemons.push(started);
    const client = new EngineClient(started.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: dir("telar-identity-daemon-checkout-") });
    return { client, port: started.discovery.port, token: started.discovery.token };
  }

  test("the route carries all four fields through and answers with the stored record", async () => {
    const { client } = await daemon();
    const answer = await client.updateProject("project_one", {
      name: "Telar",
      iconEmoji: "🧵",
      envMode: "worktree",
      defaultModel: { instanceId: "claude", model: "opus" },
    });
    expect(answer.project).toMatchObject({
      name: "Telar",
      iconEmoji: "🧵",
      envMode: "worktree",
      defaultModel: { instanceId: "claude", model: "opus" },
    });
    // And the answer is the record, not an echo of the request: a re-read says
    // the same thing.
    const { projects } = await client.listProjects();
    expect(projects.find((project) => project.id === "project_one")).toMatchObject({ name: "Telar", envMode: "worktree" });
  });

  test("`null` travels, so a pane can hand a project back to this Mac's answer", async () => {
    const { client } = await daemon();
    await client.updateProject("project_one", { envMode: "local", iconEmoji: "🧵", defaultModel: { instanceId: "claude", model: "opus" } });
    const answer = await client.updateProject("project_one", { envMode: null, iconEmoji: null, defaultModel: null });
    expect(answer.project.envMode).toBeUndefined();
    expect(answer.project.iconEmoji).toBeUndefined();
    expect(answer.project.defaultModel).toBeUndefined();
  });

  test("a wrong shape is a 400 naming the field, not a 500 and not a silent store", async () => {
    const { port, token, client } = await daemon();
    const patch = (payload: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${port}/v2/projects/project_one`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    for (const [payload, field] of [
      [{ name: "" }, "name"],
      [{ name: 7 }, "name"],
      [{ iconEmoji: 7 }, "iconEmoji"],
      [{ defaultModel: [] }, "defaultModel"],
      [{ envMode: "elsewhere" }, "envMode"],
    ] as const) {
      const response = await patch(payload);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toContain(field);
    }

    // Nothing was half-applied by any of them.
    const { project } = await client.updateProject("project_one", {});
    expect(project).toMatchObject({ name: "One" });
    expect(project.envMode).toBeUndefined();
  });

  test("the plugin arms still work beside the new ones, in one write", async () => {
    const { client } = await daemon();
    const answer = await client.updateProject("project_one", {
      name: "Telar",
      plugins: { hello: { enabled: true, settings: { greeting: "hola" } } },
    });
    expect(answer.project.name).toBe("Telar");
    expect(answer.project.plugins).toBeDefined();
  });
});
