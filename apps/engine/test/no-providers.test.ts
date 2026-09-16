/**
 * THE SUITE'S OWN GUARD, HELD TO ITS WORD — issue #532.
 *
 * Every assertion here is about the preload registered in bunfig.toml
 * (test/no-providers.ts). Without it the engine suite spawned a real `claude`
 * dozens of times per run for session titles, model lists and skills probes,
 * each spending the machine owner's subscription and leaving a ~250 KB
 * transcript under ~/.claude/projects. This file fails the moment that
 * registration is dropped, so the regression cannot come back quietly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_TEST_REFUSAL, cliSpawnAllowed, requireCli } from "../src/cli-resolution";
import { loadClaudeModelSdk, readClaudeModels } from "../src/models";
import { loadClaudeCommandSdk, readClaudeSupportedCommands } from "../src/provider-skills";
import { EngineStore } from "../src/state";
import { generateSessionTitle, maybeRetitleSession, textGenDisabledByEnv, type RetitleStore } from "../src/textgen";

const roots: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  // Whatever an opt-in test set, the next one starts gated again.
  delete process.env.TELAR_ALLOW_CLI;
});

test("the preload armed both switches", () => {
  expect(process.env.NODE_ENV).toBe("test");
  expect(textGenDisabledByEnv()).toBe(true);
  expect(cliSpawnAllowed()).toBe(false);
});

describe("a test cannot spawn a provider", () => {
  test("not for a title", async () => {
    // The real store, the real default policy — the exact shape that was
    // spending model calls: `titles: true`, a seed title, a directory to run in.
    const store = new EngineStore(tmp("telar-np-state-"), () => 100);
    expect(store.getTextGenPolicy().titles).toBe(true);

    const asked: unknown[] = [];
    const retitle: RetitleStore = {
      getTextGenPolicy: () => store.getTextGenPolicy(),
      getSession: () => ({ title: "fix the thing", state: "active", workspace: { path: tmp("telar-np-cwd-") } }),
      resolveProviderInstance: () => ({ enabled: true, env: [] }),
      updateSession: () => undefined,
      refreshWorktreeBranchFromTitle: () => undefined,
    };
    await maybeRetitleSession(retitle, "session_one", "fix the thing", ((input: unknown) => {
      asked.push(input);
      return Promise.resolve("A Real Title");
    }) as never);
    // The environment's switch is read before the stored preference is acted
    // on, so the generator is never even reached.
    expect(asked).toHaveLength(0);

    // And the generator itself, called directly, refuses rather than spawning.
    expect(await generateSessionTitle({ driver: "claude", cwd: tmp("telar-np-cwd-"), message: "fix the thing" })).toBeUndefined();
  });

  test("not for a model list", async () => {
    await expect(loadClaudeModelSdk()).rejects.toThrow(CLI_TEST_REFUSAL);
    // And through the function a menu actually calls: an empty catalogue whose
    // message names the refusal, not a subprocess.
    const answer = await readClaudeModels();
    expect(answer.models).toEqual([]);
    expect(answer.message).toContain(CLI_TEST_REFUSAL);
  });

  test("not for a skills probe", async () => {
    await expect(loadClaudeCommandSdk()).rejects.toThrow(CLI_TEST_REFUSAL);
    // This one reports absence as an empty list by contract, so the loader
    // above is where the refusal is legible; both are asserted.
    expect(await readClaudeSupportedCommands(tmp("telar-np-cwd-"))).toEqual([]);
  });

  test("and requireCli refuses every CLI, by name", () => {
    expect(() => requireCli("claude")).toThrow(CLI_TEST_REFUSAL);
    expect(() => requireCli("codex")).toThrow(CLI_TEST_REFUSAL);
    expect(() => requireCli("opencode")).toThrow(CLI_TEST_REFUSAL);
  });
});

describe("the opt-in", () => {
  test("TELAR_ALLOW_CLI=1 lifts the gate", async () => {
    process.env.TELAR_ALLOW_CLI = "1";
    expect(cliSpawnAllowed()).toBe(true);
    // Importing the SDK is not spawning it, so this is safe to assert for real.
    await expect(loadClaudeModelSdk()).resolves.toBeDefined();
    /**
     * `requireCli` may still throw — on a machine with no Claude Code install
     * it says so, and that is the answer this test wants to allow through. What
     * it must NOT be any more is the gate's own refusal.
     */
    let message = "";
    try {
      requireCli("claude");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(CLI_TEST_REFUSAL);
  });

  test("and it is read per call, so it does not leak past the test that set it", () => {
    expect(cliSpawnAllowed()).toBe(false);
    expect(() => requireCli("claude")).toThrow(CLI_TEST_REFUSAL);
  });
});
