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
import { EngineClient, type ModelCatalogue, type ProviderModel } from "@telar/engine-client";
import { EngineStateError, EngineStore } from "../src/state";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";

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

  test("a picked glyph stores by NAME, and its shape is checked here (#364)", () => {
    const store = readyStore();
    expect(store.updateProject("project_one", { iconName: "flask-conical" }).iconName).toBe("flask-conical");
    expect("iconName" in store.updateProject("project_one", { iconName: null })).toBe(false);
    // WHICH names exist is the cockpit's question, not the registry's — an
    // engine enforcing last year's set would refuse a glyph a newer app draws.
    // What the store owns is the SHAPE, so a path or a sentence never lands.
    expect(store.updateProject("project_one", { iconName: "a-glyph-no-build-has-yet" }).iconName).toBe("a-glyph-no-build-has-yet");
    for (const bad of ["", "Flask", "../etc/passwd", "9lives", "a b"]) {
      expect(() => store.updateProject("project_one", { iconName: bad })).toThrow(EngineStateError);
    }
  });

  test("naming one icon field clears the other, so a record never holds two picks", () => {
    // Both answer "what did somebody choose for this project", and a record
    // carrying both would leave the rail's fallback order deciding which of two
    // deliberate picks wins.
    const store = readyStore();
    store.updateProject("project_one", { iconEmoji: "🧵" });
    const glyph = store.updateProject("project_one", { iconName: "rocket" });
    expect(glyph.iconName).toBe("rocket");
    expect("iconEmoji" in glyph).toBe(false);
    const mark = store.updateProject("project_one", { iconEmoji: "🧵" });
    expect(mark.iconEmoji).toBe("🧵");
    expect("iconName" in mark).toBe(false);
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

/**
 * THE LADDER: the session's own answer, then the project's, then the Mac's.
 *
 * Each rung's ABSENCE is a real answer rather than a missing one, which is what
 * makes these cases distinguishable at all — a project that stored `"local"` and
 * a project that stored nothing must behave differently the moment the Mac's
 * standing answer changes underneath them.
 */
describe("a new conversation honours the project before the Mac", () => {
  /** A checkout that is a real git repo, so `worktree` is reachable. */
  function gitStore(): EngineStore {
    const checkout = dir("telar-identity-git-");
    for (const args of [["init"], ["config", "user.email", "t@t"], ["config", "user.name", "T"], ["commit", "--allow-empty", "-m", "root"]]) {
      // BOUNDED, BECAUSE A SYNC CHILD WAIT IS OUTSIDE EVERY CEILING ABOVE IT
      // (#807): `spawnSync` parks this thread in `wait4`, where bun's per-test
      // timer — an event-loop timer — can never reach it. A `git` that decides
      // to prompt for credentials, or one waiting on an index.lock another
      // process holds, never returns on its own. Five seconds is generous for
      // four local plumbing commands in a fresh temp directory, and SIGKILL for
      // the reason src/worktree.ts's sync runner argues: a git that has not
      // answered is one that may never handle a polite signal.
      Bun.spawnSync(["git", ...args], { cwd: checkout, timeout: 5_000, killSignal: "SIGKILL" });
    }
    const store = new EngineStore(dir("telar-identity-home-"), () => 100);
    store.registerProject({ id: "project_one", name: "One", root: checkout });
    return store;
  }

  test("the project's answer beats the Mac's, in both directions", () => {
    const store = gitStore();
    store.setSessionDefaults({ envMode: "local" });
    store.updateProject("project_one", { envMode: "worktree" });
    expect(store.createSession({ id: "session_a", projectId: "project_one" }).envMode).toBe("worktree");

    store.setSessionDefaults({ envMode: "worktree" });
    store.updateProject("project_one", { envMode: "local" });
    expect(store.createSession({ id: "session_b", projectId: "project_one" }).envMode).toBe("local");
  });

  test("a project that stored nothing follows the Mac, and keeps following when it moves", () => {
    const store = gitStore();
    store.setSessionDefaults({ envMode: "worktree" });
    expect(store.createSession({ id: "session_a", projectId: "project_one" }).envMode).toBe("worktree");
    store.setSessionDefaults({ envMode: "local" });
    expect(store.createSession({ id: "session_b", projectId: "project_one" }).envMode).toBe("local");
  });

  test("clearing the project's answer hands it back to the Mac", () => {
    const store = gitStore();
    store.setSessionDefaults({ envMode: "worktree" });
    store.updateProject("project_one", { envMode: "local" });
    expect(store.createSession({ id: "session_a", projectId: "project_one" }).envMode).toBe("local");
    store.updateProject("project_one", { envMode: null });
    expect(store.createSession({ id: "session_b", projectId: "project_one" }).envMode).toBe("worktree");
  });

  test("a caller that STATES a mode still gets exactly that", () => {
    const store = gitStore();
    store.updateProject("project_one", { envMode: "worktree" });
    expect(store.createSession({ id: "session_a", projectId: "project_one", envMode: "local" }).envMode).toBe("local");
  });

  test("a pinned worktree yields on an unversioned checkout rather than refusing the session", () => {
    // Nobody typed `worktree` for THIS session — it is a preference, like the
    // Mac's, and a project without git must still be openable.
    const store = readyStore();
    store.updateProject("project_one", { envMode: "worktree" });
    expect(store.createSession({ id: "session_a", projectId: "project_one" }).envMode).toBe("local");
  });

  test("the project's default model rides the session, when the session lands on its login", () => {
    const store = readyStore();
    store.updateProject("project_one", { defaultModel: { instanceId: "claude", model: "opus", effort: "high" } });
    const session = store.createSession({ id: "session_a", projectId: "project_one" });
    expect(session.model).toEqual({ instanceId: "claude", model: "opus", effort: "high" });
  });

  test("…and does not, when the caller routed the session to another provider", () => {
    // A selection is a MODEL ON A LOGIN. Carrying a Claude default onto a Codex
    // session would name a model that login has never heard of.
    const store = readyStore();
    store.updateProject("project_one", { defaultModel: { instanceId: "claude", model: "opus" } });
    const session = store.createSession({ id: "session_a", projectId: "project_one", driver: "codex" });
    expect(session.model).toBeUndefined();
  });

  test("a project with no default model leaves the session on the provider's own", () => {
    const store = readyStore();
    expect(store.createSession({ id: "session_a", projectId: "project_one" }).model).toBeUndefined();
  });
});

/**
 * THE MODEL'S OPTIONS — effort and fast mode — ride with the project's default,
 * checked against what the catalogue says that model offers.
 */
describe("a new conversation starts with the project's model options", () => {
  const row = (id: string, options: { efforts?: string[]; fastMode?: boolean; isDefault?: boolean } = {}): ProviderModel => ({
    id,
    label: id,
    isDefault: options.isDefault ?? false,
    hidden: false,
    hiddenByUser: false,
    legacy: false,
    efforts: options.efforts ?? [],
    fastMode: options.fastMode ?? false,
    source: "provider",
  });
  const CATALOGUE = [
    row("claude-opus-5", { efforts: ["low", "medium", "high"], fastMode: true, isDefault: true }),
    row("claude-haiku-4-5"),
  ];

  /** A store whose catalogue is WARM, which is what the check reads. */
  async function catalogued(): Promise<EngineStore> {
    const catalogue = async (): Promise<ModelCatalogue> => ({ driver: "claude", instanceId: "claude", readAt: 100, models: CATALOGUE });
    const store = new EngineStore(dir("telar-identity-home-"), () => 100, { models: catalogue, manifest: { version: 1 } });
    await store.modelCatalogue("claude");
    store.registerProject({ id: "project_one", name: "One", root: dir("telar-identity-checkout-") });
    return store;
  }

  test("a new session gets the project's effort and fast mode", async () => {
    const store = await catalogued();
    store.updateProject("project_one", { defaultModel: { instanceId: "claude", model: "claude-opus-5", effort: "medium", fastMode: true } });
    expect(store.createSession({ id: "session_a", projectId: "project_one" }).model).toEqual({
      instanceId: "claude",
      model: "claude-opus-5",
      effort: "medium",
      fastMode: true,
    });
  });

  test("options with no model apply to the provider's default model", async () => {
    const store = await catalogued();
    store.updateProject("project_one", { defaultModel: { instanceId: "claude", effort: "high" } });
    expect(store.createSession({ id: "session_a", projectId: "project_one" }).model).toEqual({ instanceId: "claude", effort: "high" });
  });

  test("the composer's choice overrides them", async () => {
    const store = await catalogued();
    store.updateProject("project_one", { defaultModel: { instanceId: "claude", model: "claude-opus-5", effort: "medium", fastMode: true } });
    store.createSession({ id: "session_a", projectId: "project_one" });
    // What the canvas does with a pick made before the first message.
    const picked = store.updateSession("session_a", { model: { instanceId: "claude", model: "claude-opus-5", effort: "low" } });
    expect(picked.model).toEqual({ instanceId: "claude", model: "claude-opus-5", effort: "low" });
    // …and a turn's own choice beats the session's at claim.
    store.submitTurn("session_a", { runId: "run_one", input: "hello", model: { model: "claude-opus-5", effort: "high" } });
    expect(store.claimNextTurn("worker_one")?.model?.effort).toBe("high");
  });

  test("an option the model does not offer is dropped", async () => {
    const store = await catalogued();
    store.updateProject("project_one", { defaultModel: { instanceId: "claude", model: "claude-haiku-4-5", effort: "high", fastMode: true } });
    expect(store.createSession({ id: "session_a", projectId: "project_one" }).model).toEqual({ instanceId: "claude", model: "claude-haiku-4-5" });

    // With nothing left to select, the session is on the provider's default.
    store.updateProject("project_one", { defaultModel: { instanceId: "claude", model: "claude-opus-5", effort: "ultra" } });
    expect(store.createSession({ id: "session_b", projectId: "project_one" }).model).toEqual({ instanceId: "claude", model: "claude-opus-5" });
    store.updateProject("project_one", { defaultModel: { instanceId: "claude", effort: "ultra" } });
    expect(store.createSession({ id: "session_c", projectId: "project_one" }).model).toBeUndefined();
  });

  test("ultracode needs a model with xhigh, and is dropped from one without", async () => {
    const store = await catalogued();
    store.updateProject("project_one", { defaultModel: { instanceId: "claude", model: "claude-opus-5", ultracode: true } });
    // The fixture's Opus stops at high.
    expect(store.createSession({ id: "session_a", projectId: "project_one" }).model).toEqual({ instanceId: "claude", model: "claude-opus-5" });
  });

  test("a cold catalogue trusts the stored options", () => {
    const store = readyStore();
    store.updateProject("project_one", { defaultModel: { instanceId: "claude", model: "claude-haiku-4-5", effort: "high" } });
    expect(store.createSession({ id: "session_a", projectId: "project_one" }).model?.effort).toBe("high");
  });
});

describe("PATCH /v2/projects/:id", () => {
  async function daemon(): Promise<{ client: EngineClient; port: number; token: string }> {
    const home = dir("telar-identity-daemon-");
    const started = await startEngine({ models: stubModels, engineRoot: home });
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
      [{ iconName: 7 }, "iconName"],
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
