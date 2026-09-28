import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_TEXT_GEN_POLICY, type TextGenPolicy } from "@telar/engine-client";
import { EngineStore } from "../../state";
import { EngineStateError } from "../../platform/kernel";
import { buildTitlePrompt, maybeRetitleSession, sanitizeTitle, titleIsSeed, type RetitleStore } from "./textgen";
import { worktreeReady } from "../../../test/worktree-ready";

const roots: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function repo(): string {
  const root = tmp("telar-tg-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

describe("sanitizeTitle", () => {
  test("keeps the first line, unwrapped and collapsed", () => {
    expect(sanitizeTitle('"Fix the login flow"\nand more')).toBe("Fix the login flow");
    expect(sanitizeTitle("  Fix   the\tlogin  flow.  ")).toBe("Fix the login flow");
  });

  test("bounds a title the model refused to keep short", () => {
    expect(sanitizeTitle("x".repeat(300))!.length).toBe(80);
  });

  test("refuses non-answers", () => {
    expect(sanitizeTitle(undefined)).toBeUndefined();
    expect(sanitizeTitle(42)).toBeUndefined();
    expect(sanitizeTitle('""')).toBeUndefined();
    expect(sanitizeTitle("   \n  ")).toBeUndefined();
  });
});

describe("titleIsSeed", () => {
  test("the store default and the cockpit's truncation are both seeds", () => {
    expect(titleIsSeed("New session", "anything")).toBe(true);
    const message = "please   fix the\nqueue refill race in the worker";
    expect(titleIsSeed("please fix the queue refill race in the worker", message)).toBe(true);
    const long = "a".repeat(200);
    expect(titleIsSeed("a".repeat(80), long)).toBe(true);
  });

  test("a title a person wrote is not a seed", () => {
    expect(titleIsSeed("Queue refill race", "please fix the queue refill race")).toBe(false);
    expect(titleIsSeed("", "message")).toBe(false);
  });
});

test("the prompt carries the message, bounded", () => {
  const prompt = buildTitlePrompt("m".repeat(20_000));
  expect(prompt).toContain("Return JSON with exactly one key: title.");
  expect(prompt.length).toBeLessThan(10_000);
});

describe("text generation policy", () => {
  test("defaults, round trip, and a driver change dropping the model", () => {
    const store = new EngineStore(tmp("telar-tg-state-"), () => 100);
    expect(store.settings.textGen()).toEqual(DEFAULT_TEXT_GEN_POLICY);
    expect(store.settings.setTextGen({ titles: false, model: "sonnet" })).toEqual({ ...DEFAULT_TEXT_GEN_POLICY, titles: false, model: "sonnet" });
    expect(store.settings.setTextGen({ renameBranches: false }).model).toBe("sonnet");
    const swapped = store.settings.setTextGen({ driver: "codex" });
    expect(swapped.driver).toBe("codex");
    expect(swapped.model).toBeUndefined();
    expect(store.settings.setTextGen({ model: null }).model).toBeUndefined();
  });

  test("refuses shapes that are not the policy's", () => {
    const store = new EngineStore(tmp("telar-tg-state-"), () => 100);
    expect(() => store.settings.setTextGen({ driver: "cursor" })).toThrow(EngineStateError);
    expect(() => store.settings.setTextGen({ titles: "yes" })).toThrow(EngineStateError);
    expect(() => store.settings.setTextGen({ model: "" })).toThrow(EngineStateError);
  });

  test("a mangled file costs the preference, never a throw", () => {
    const stateRoot = tmp("telar-tg-state-");
    const store = new EngineStore(stateRoot, () => 100);
    fs.writeFileSync(path.join(stateRoot, "text-generation.json"), "not json at all");
    expect(store.settings.textGen()).toEqual(DEFAULT_TEXT_GEN_POLICY);
  });
});

describe("refreshWorktreeBranchFromTitle", () => {
  async function worktreeSession(title: string): Promise<{ store: EngineStore; id: string }> {
    const store = new EngineStore(tmp("telar-tg-state-"), () => 100);
    store.projectRegistry.register({ id: "project_one", name: "One", root: repo() });
    const session = store.lifecycle.createSession({ id: "session_abcdef123456", projectId: "project_one", envMode: "worktree", title });
    await worktreeReady(store, session.id);
    return { store, id: session.id };
  }

  test("a generated title renames the engine-cut branch, on disk and on the record", async () => {
    const { store, id } = await worktreeSession("please fix the queue refill race in the work");
    store.lifecycle.updateSession(id, { title: "Queue refill race" });
    expect(await store.lifecycle.refreshWorktreeBranchFromTitle(id)).toBe("telar/queue-refill-race-abcdef");
    const session = store.records.get(id);
    if (session.workspace.mode !== "worktree") throw new Error("expected a worktree session");
    expect(session.workspace.branch).toBe("telar/queue-refill-race-abcdef");
    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: session.workspace.path, encoding: "utf8" }).trim();
    expect(head).toBe("telar/queue-refill-race-abcdef");
  });

  test("declines when nothing would change, and never twice", async () => {
    const { store, id } = await worktreeSession("same title");
    expect(await store.lifecycle.refreshWorktreeBranchFromTitle(id)).toBeUndefined();
  });
});

describe("maybeRetitleSession", () => {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.TELAR_TEXTGEN;
    delete process.env.TELAR_TEXTGEN;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.TELAR_TEXTGEN;
    else process.env.TELAR_TEXTGEN = previous;
  });

  type Overrides = Partial<{
    policy: TextGenPolicy;
    title: string;
    titleAfter: string;
    generated: string | undefined;
    message: string;
  }>;

  function harness(overrides: Overrides = {}) {
    const calls: { generate: unknown[]; updates: { title: string }[]; renamed: string[] } = { generate: [], updates: [], renamed: [] };
    let title = overrides.title ?? "fix the thing";
    const store: RetitleStore = {
      settings: { textGen: () => overrides.policy ?? { titles: true, renameBranches: true, driver: "claude", model: "haiku" } },
      records: { get: () => ({ title, state: "active", workspace: { mode: "local", path: "/tmp" } }) },
      providers: { resolve: () => ({ enabled: true, env: [{ name: "A", value: "b" }] }) },
      lifecycle: {
        updateSession: (_id, patch) => {
          calls.updates.push(patch);
          title = patch.title;
        },
        refreshWorktreeBranchFromTitle: (id) => {
          calls.renamed.push(id);
          return "telar/renamed";
        },
      },
    };
    const generate = (input: unknown) => {
      calls.generate.push(input);
      if (overrides.titleAfter !== undefined) title = overrides.titleAfter;
      return Promise.resolve("generated" in overrides ? overrides.generated : "A Real Title");
    };
    return { calls, run: () => maybeRetitleSession(store, "session_one", overrides.message ?? "fix the thing", generate as never) };
  }

  test("replaces the seed and renames the branch", async () => {
    const { calls, run } = harness();
    await run();
    expect(calls.updates).toEqual([{ title: "A Real Title" }]);
    expect(calls.renamed).toEqual(["session_one"]);
    expect(calls.generate[0]).toMatchObject({ driver: "claude", model: "haiku", env: { A: "b" }, message: "fix the thing" });
  });

  test("an image-only first message keeps its seed — there are no words to title", async () => {
    const { calls, run } = harness({ title: "New session", message: "  " });
    await run();
    expect(calls.generate).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  test("switched off, it does not even ask", async () => {
    const { calls, run } = harness({ policy: { titles: false, renameBranches: true, driver: "claude" } });
    await run();
    expect(calls.generate).toHaveLength(0);
  });

  test("a title a person already wrote is never overwritten", async () => {
    const { calls, run } = harness({ title: "My own name for this" });
    await run();
    expect(calls.generate).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  test("a rename landing WHILE the harness thinks wins over the harness", async () => {
    const { calls, run } = harness({ titleAfter: "Renamed mid-flight" });
    await run();
    expect(calls.generate).toHaveLength(1);
    expect(calls.updates).toHaveLength(0);
    expect(calls.renamed).toHaveLength(0);
  });

  test("a failed generation keeps the placeholder and touches nothing", async () => {
    const { calls, run } = harness({ generated: undefined });
    await run();
    expect(calls.updates).toHaveLength(0);
    expect(calls.renamed).toHaveLength(0);
  });

  test("branch renaming honours its own switch", async () => {
    const { calls, run } = harness({ policy: { titles: true, renameBranches: false, driver: "claude" } });
    await run();
    expect(calls.updates).toHaveLength(1);
    expect(calls.renamed).toHaveLength(0);
  });
});
