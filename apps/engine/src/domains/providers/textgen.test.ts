import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_TEXT_GEN_POLICY, type Item, type TextGenPolicy } from "@telar/engine-client";
import { EngineStore } from "../../state";
import { EngineStateError } from "../../platform/kernel";
import { cheapModel, generateSessionTitle, maybeRetitleSession, maybeRetitleWithContext, regenerateSessionTitle, sanitizeTitle, titleIsSeed, type RegenerateStore, type RetitleStore } from "./textgen";
import { buildTitlePrompt } from "./title-prompts";
import { OPENCODE_VERSION } from "../../drivers/opencode/version";
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
    expect(store.settings.setTextGen({ driver: "opencode", effort: "medium" })).toMatchObject({ driver: "opencode", effort: "medium" });
    expect(store.settings.setTextGen({ effort: null }).effort).toBeUndefined();
  });

  test("refuses shapes that are not the policy's", () => {
    const store = new EngineStore(tmp("telar-tg-state-"), () => 100);
    expect(() => store.settings.setTextGen({ driver: "cursor" })).toThrow(EngineStateError);
    expect(() => store.settings.setTextGen({ titles: "yes" })).toThrow(EngineStateError);
    expect(() => store.settings.setTextGen({ model: "" })).toThrow(EngineStateError);
    expect(() => store.settings.setTextGen({ effort: "max" })).toThrow(EngineStateError);
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

describe("each provider answers one bare call from an empty scratch directory", () => {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.TELAR_ALLOW_CLI;
    process.env.TELAR_ALLOW_CLI = "1";
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.TELAR_ALLOW_CLI;
    else process.env.TELAR_ALLOW_CLI = previous;
  });

  function fakeCli(name: string, answer: string, version = "2.1.270 (fake)"): { binaryPath: string; recorded: () => { cwd: string; env: string[]; args: string[] } } {
    const bin = tmp("telar-tg-bin-");
    const record = path.join(bin, "record");
    const binaryPath = path.join(bin, name);
    fs.writeFileSync(
      binaryPath,
      `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version}" && exit 0\n{ pwd; echo "A=$A"; echo "CONFIG=$OPENCODE_CONFIG_CONTENT"; echo "GW=$ANTHROPIC_BASE_URL"; echo "TOKEN=\${ANTHROPIC_AUTH_TOKEN:+set}"; for a in "$@"; do echo "[$a]"; done; } > "${record}"\ncat > /dev/null\n${answer}\n`,
    );
    fs.chmodSync(binaryPath, 0o755);
    return {
      binaryPath,
      recorded: () => {
        const [cwd, a, config, gateway, token, ...args] = fs.readFileSync(record, "utf8").trim().split("\n");
        return { cwd: cwd!, env: [a!, config!, gateway!, token!], args };
      },
    };
  }

  test("Claude: no tools, skills, hooks, MCP or thinking, low effort", async () => {
    const cli = fakeCli("claude", `echo '{"structured_output":{"title":"Queue refill race"}}'`);
    expect(await generateSessionTitle({ driver: "claude", binaryPath: cli.binaryPath, env: { A: "b" }, model: "haiku", message: "fix the queue refill race" })).toBe("Queue refill race");
    const { cwd, env, args } = cli.recorded();
    expect(fs.existsSync(cwd)).toBe(false);
    expect(env[0]).toBe("A=b");
    const joined = args.join(" ");
    for (const expected of ["[--tools] []", "[--disable-slash-commands]", "[--strict-mcp-config]", "[--setting-sources] []", "[--permission-mode] [dontAsk]", "[--max-turns] [1]", "[--model] [haiku]", "[--effort] [low]"]) {
      expect(joined).toContain(expected);
    }
    expect(joined).toContain(`[--settings] [${JSON.stringify({ disableAllHooks: true, alwaysThinkingEnabled: false })}]`);
    expect(args).not.toContain("[--mcp-config]");
  });

  test("Claude: logs in through the settings file's env even though settings sources are off", async () => {
    const config = tmp("telar-tg-claude-config-");
    fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.test", ANTHROPIC_AUTH_TOKEN: "t0ken" } }));
    const cli = fakeCli("claude", `echo '{"structured_output":{"title":"Queue refill race"}}'`);
    expect(await generateSessionTitle({ driver: "claude", binaryPath: cli.binaryPath, env: { A: "b", CLAUDE_CONFIG_DIR: config }, message: "fix it" })).toBe("Queue refill race");
    expect(cli.recorded().env.slice(2)).toEqual(["GW=https://gateway.test", "TOKEN=set"]);

    await generateSessionTitle({ driver: "claude", binaryPath: cli.binaryPath, env: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: "https://instance.test" }, message: "fix it" });
    expect(cli.recorded().env[2]).toBe("GW=https://instance.test");
  });

  test("a failed call is logged with its exit and the CLI's words, never a key", async () => {
    const cli = fakeCli("claude", `echo 'Failed to authenticate: OAuth session expired (sk-ant-oat01-abcdef)' >&2; exit 1`);
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: string) => logged.push(line);
    try {
      expect(await generateSessionTitle({ driver: "claude", binaryPath: cli.binaryPath, message: "fix it" })).toBeUndefined();
    } finally {
      console.error = original;
    }
    const failures = logged.filter((line) => line.includes("text generation failed"));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("claude text generation failed: exited 1: Failed to authenticate: OAuth session expired");
    expect(failures[0]).not.toContain("sk-ant");
  });

  test("Codex: ephemeral, without the user's config, rules or web search", async () => {
    const cli = fakeCli("codex", `out=""; prev=""; for a in "$@"; do [ "$prev" = "--output-last-message" ] && out="$a"; prev="$a"; done; echo '{"title":"Queue refill race"}' > "$out"`);
    expect(await generateSessionTitle({ driver: "codex", binaryPath: cli.binaryPath, env: { A: "b" }, model: "gpt-6-luna", effort: "medium", message: "fix it" })).toBe("Queue refill race");
    const { cwd, env, args } = cli.recorded();
    expect(fs.existsSync(cwd)).toBe(false);
    expect(env[0]).toBe("A=b");
    const joined = args.join(" ");
    for (const expected of ["[exec] [--ephemeral]", "[--ignore-user-config]", "[--ignore-rules]", "[-s] [read-only]", "[--model] [gpt-6-luna]", '[model_reasoning_effort="medium"]', '[web_search="disabled"]']) {
      expect(joined).toContain(expected);
    }
  });

  test("OpenCode: a pure run with every tool and permission denied", async () => {
    const lines = [{ type: "step_start" }, { type: "text", part: { text: 'Sure: {"title":' } }, { type: "text", part: { text: '"Queue refill race"}' } }];
    const cli = fakeCli("opencode", `printf '%s\\n' ${lines.map((line) => `'${JSON.stringify(line)}'`).join(" ")}`, OPENCODE_VERSION);
    expect(await generateSessionTitle({ driver: "opencode", binaryPath: cli.binaryPath, env: { A: "b" }, model: "anthropic/claude-haiku-4-5", message: "fix it" })).toBe("Queue refill race");
    const { cwd, env, args } = cli.recorded();
    expect(fs.existsSync(cwd)).toBe(false);
    expect(env[0]).toBe("A=b");
    const config = JSON.parse(env[1]!.slice("CONFIG=".length)) as { permission: string; tools: Record<string, boolean> };
    expect(config.permission).toBe("deny");
    expect(config.tools).toEqual({ "*": false });
    expect(args.join(" ")).toBe("[run] [--format] [json] [--pure] [--model] [anthropic/claude-haiku-4-5]");
  });
});

test("the cheap default is the first small-tier model a provider lists", () => {
  expect(cheapModel(["gpt-6-astra", "gpt-6-luna[1m]", "gpt-6-luna", "gpt-5.5"])).toBe("gpt-6-luna");
  expect(cheapModel(["opencode/gemini-3-flash", "opencode/claude-haiku-4-5"])).toBe("opencode/claude-haiku-4-5");
  expect(cheapModel(["google/gemini-3.1-pro"])).toBeUndefined();
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
    rows: string[];
  }>;

  function harness(overrides: Overrides = {}) {
    const calls: { generate: unknown[]; updates: { title: string; autoTitle?: string }[]; renamed: string[] } = { generate: [], updates: [], renamed: [] };
    let title = overrides.title ?? "fix the thing";
    const store: RetitleStore = {
      settings: { textGen: () => overrides.policy ?? { titles: true, renameBranches: true, driver: "claude", model: "haiku" } },
      records: { get: () => ({ title, state: "active" }) },
      providers: { resolve: () => ({ enabled: true, env: [{ name: "A", value: "b" }] }) },
      catalogues: { cachedRows: () => overrides.rows?.map((id) => ({ id })) },
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
    expect(calls.updates).toEqual([{ title: "A Real Title", autoTitle: "first" }]);
    expect(calls.renamed).toEqual(["session_one"]);
    expect(calls.generate[0]).toMatchObject({ driver: "claude", model: "haiku", env: { A: "b" }, message: "fix the thing" });
  });

  test("a provider with its own config dir titles as that account, not the ambient one", async () => {
    const store: RetitleStore = {
      settings: { textGen: () => ({ titles: true, renameBranches: false, driver: "claude", model: "haiku" }) },
      records: { get: () => ({ title: "fix the thing", state: "active" }) },
      providers: { resolve: () => ({ enabled: true, configDir: "/tmp/claude-work", env: [] }) },
      lifecycle: { updateSession: () => undefined, refreshWorktreeBranchFromTitle: () => undefined },
    };
    const asked: { env: Record<string, string | undefined> }[] = [];
    await maybeRetitleSession(store, "session_one", "fix the thing", ((input: { env: Record<string, string | undefined> }) => {
      asked.push(input);
      return Promise.resolve("A Real Title");
    }) as never);
    expect(asked[0]!.env["CLAUDE_CONFIG_DIR"]).toBe("/tmp/claude-work");
    expect("ANTHROPIC_AUTH_TOKEN" in asked[0]!.env && asked[0]!.env["ANTHROPIC_AUTH_TOKEN"] === undefined).toBe(true);
  });

  test("OpenCode titles with the cheapest model it lists when the stored one is not an OpenCode id", async () => {
    const { calls, run } = harness({ policy: { titles: true, renameBranches: true, driver: "opencode", model: "haiku" }, rows: ["google/gemini-3.1-pro", "anthropic/claude-haiku-4-5"] });
    await run();
    expect(calls.generate[0]).toMatchObject({ driver: "opencode", model: "anthropic/claude-haiku-4-5" });
    expect(calls.updates).toEqual([{ title: "A Real Title", autoTitle: "first" }]);
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

describe("regenerateSessionTitle", () => {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.TELAR_TEXTGEN;
    delete process.env.TELAR_TEXTGEN;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.TELAR_TEXTGEN;
    else process.env.TELAR_TEXTGEN = previous;
  });

  type Overrides = Partial<{ title: string; titleAfter: string; answer: Record<string, unknown> | undefined; items: Item[]; renameBranches: boolean }>;

  const item = (index: number, detail: Item["detail"]): Item =>
    ({ id: `item_${index}`, runId: "run_one", sessionId: "session_one", status: "completed", detail, startedAt: index }) as Item;
  const conversation = [
    item(2, { type: "assistant_message", text: "The list re-sorts twice on settle." }),
    item(1, { type: "user_message", text: "Why does the rail flicker?" }),
    item(3, { type: "reasoning", text: "SECRET THINKING" }),
  ];

  function harness(overrides: Overrides = {}) {
    const calls: { prompts: string[]; inputs: unknown[]; updates: { title: string }[]; renamed: string[] } = { prompts: [], inputs: [], updates: [], renamed: [] };
    let title = overrides.title ?? "My own name";
    const store: RegenerateStore = {
      settings: { textGen: () => ({ titles: false, renameBranches: overrides.renameBranches ?? true, driver: "claude", model: "haiku", effort: "medium" }) },
      records: { get: () => ({ title, state: "active" }) },
      providers: { resolve: () => ({ enabled: true, env: [] }) },
      queries: { items: () => overrides.items ?? conversation },
      lifecycle: {
        updateSession: (_id, patch) => {
          calls.updates.push(patch);
          title = patch.title;
        },
        refreshWorktreeBranchFromTitle: (id) => {
          calls.renamed.push(id);
          return undefined;
        },
      },
    };
    const run = (input: unknown, prompt: string) => {
      calls.inputs.push(input);
      calls.prompts.push(prompt);
      if (overrides.titleAfter !== undefined) title = overrides.titleAfter;
      return Promise.resolve("answer" in overrides ? overrides.answer : { title: "Rail Settle Flicker" });
    };
    return { calls, run: () => regenerateSessionTitle(store, "session_one", run as never) };
  }

  test("replaces even a title the person wrote, from the conversation, with the policy's model and effort", async () => {
    const { calls, run } = harness();
    expect(await run()).toEqual({ title: "Rail Settle Flicker", changed: true });
    expect(calls.updates).toEqual([{ title: "Rail Settle Flicker" }]);
    expect(calls.renamed).toEqual(["session_one"]);
    expect(calls.inputs[0]).toMatchObject({ driver: "claude", model: "haiku", effort: "medium" });
    const prompt = calls.prompts[0]!;
    expect(prompt).toContain('The previous title was "My own name".');
    expect(prompt).toContain("USER:\nWhy does the rail flicker?\n\nASSISTANT:\nThe list re-sorts twice on settle.");
    expect(prompt).not.toContain("SECRET THINKING");
  });

  test("an unchanged answer writes nothing", async () => {
    const { calls, run } = harness({ answer: { title: "My own name" } });
    expect(await run()).toEqual({ title: "My own name", changed: false });
    expect(calls.updates).toHaveLength(0);
  });

  test("a failed generation is undefined and touches nothing", async () => {
    const { calls, run } = harness({ answer: undefined });
    expect(await run()).toBeUndefined();
    expect(calls.updates).toHaveLength(0);
  });

  test("a rename landing while it thinks wins", async () => {
    const { calls, run } = harness({ titleAfter: "Renamed meanwhile" });
    await expect(run()).rejects.toThrow("renamed while");
    expect(calls.updates).toHaveLength(0);
  });

  test("a session with nothing said is refused before any call", async () => {
    const { calls, run } = harness({ items: [] });
    await expect(run()).rejects.toThrow(EngineStateError);
    expect(calls.inputs).toHaveLength(0);
  });

  test("branch renaming honours its own switch", async () => {
    const { calls, run } = harness({ renameBranches: false });
    await run();
    expect(calls.renamed).toHaveLength(0);
  });
});

describe("maybeRetitleWithContext", () => {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.TELAR_TEXTGEN;
    delete process.env.TELAR_TEXTGEN;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.TELAR_TEXTGEN;
    else process.env.TELAR_TEXTGEN = previous;
  });

  type Mark = "first" | "second" | undefined;
  type Overrides = Partial<{ autoTitle: Mark; titles: boolean; items: Item[]; answer: Record<string, unknown> | undefined; renamedMeanwhile: string }>;

  const item = (index: number, detail: Item["detail"]): Item =>
    ({ id: `item_${index}`, runId: "run_one", sessionId: "session_one", status: "completed", detail, startedAt: index }) as Item;
  const asked = item(1, { type: "user_message", text: "arregla esto" } as Item["detail"]);
  const answered = item(3, { type: "assistant_message", text: "The rail re-sorted twice on settle; it now sorts once." });
  const worked = item(2, { type: "command_execution", command: { command: "bun test rail" } } as Item["detail"]);

  function harness(overrides: Overrides = {}) {
    const session = { title: "Fix This", state: "active", autoTitle: ("autoTitle" in overrides ? overrides.autoTitle : "first") as Mark };
    const calls = { prompts: [] as string[], renamed: [] as string[] };
    const store: RegenerateStore = {
      settings: { textGen: () => ({ titles: overrides.titles ?? true, renameBranches: true, driver: "claude", model: "haiku" }) },
      records: { get: () => ({ ...session }) },
      providers: { resolve: () => ({ enabled: true, env: [] }) },
      queries: { items: () => overrides.items ?? [asked, worked, answered] },
      lifecycle: {
        updateSession: (_id, patch) => {
          if (patch.autoTitle !== undefined) session.autoTitle = patch.autoTitle;
          else if (patch.title !== session.title) session.autoTitle = undefined;
          session.title = patch.title;
        },
        refreshWorktreeBranchFromTitle: (id) => {
          calls.renamed.push(id);
          return undefined;
        },
      },
    };
    const run = (_input: unknown, prompt: string) => {
      calls.prompts.push(prompt);
      if (overrides.renamedMeanwhile !== undefined) store.lifecycle.updateSession("session_one", { title: overrides.renamedMeanwhile });
      return Promise.resolve("answer" in overrides ? overrides.answer : { title: "Rail Settle Re-sort" });
    };
    return { session, calls, run: () => maybeRetitleWithContext(store, "session_one", run as never) };
  }

  test("after a turn that did work, retitles the generated title from the conversation, once", async () => {
    const { session, calls, run } = harness();
    await run();
    expect(session).toEqual({ title: "Rail Settle Re-sort", state: "active", autoTitle: "second" });
    expect(calls.prompts[0]).toContain('The previous title was "Fix This".');
    expect(calls.prompts[0]).toContain("ASSISTANT:\nThe rail re-sorted twice on settle");
    expect(calls.renamed).toEqual(["session_one"]);
    await run();
    expect(calls.prompts).toHaveLength(1);
  });

  test("a second message is enough context even without tool calls", async () => {
    const { session, run } = harness({ items: [asked, answered, item(4, { type: "user_message", text: "y el orden?" } as Item["detail"])] });
    await run();
    expect(session.title).toBe("Rail Settle Re-sort");
  });

  test("waits while there is only the opening message and a bare answer", async () => {
    const { session, calls, run } = harness({ items: [asked, answered] });
    await run();
    expect(calls.prompts).toHaveLength(0);
    expect(session.autoTitle).toBe("first");
  });

  test("never touches a title a person or a creating session chose", async () => {
    const { session, calls, run } = harness({ autoTitle: undefined });
    await run();
    expect(calls.prompts).toHaveLength(0);
    expect(session.title).toBe("Fix This");
  });

  test("switched off, it does not ask", async () => {
    const { calls, run } = harness({ titles: false });
    await run();
    expect(calls.prompts).toHaveLength(0);
  });

  test("a failure keeps the title and is not retried", async () => {
    const { session, calls, run } = harness({ answer: undefined });
    await run();
    await run();
    expect(session).toEqual({ title: "Fix This", state: "active", autoTitle: "second" });
    expect(calls.prompts).toHaveLength(1);
    expect(calls.renamed).toHaveLength(0);
  });

  test("a rename landing while it thinks wins", async () => {
    const { session, calls, run } = harness({ renamedMeanwhile: "My rail bug" });
    await run();
    expect(session).toEqual({ title: "My rail bug", state: "active", autoTitle: undefined });
    expect(calls.renamed).toHaveLength(0);
  });
});
