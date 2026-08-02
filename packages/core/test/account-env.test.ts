import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountEnv } from "../src/engine";

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-claude-runtime-"));
const runtimeSettings = path.join(runtimeDir, "settings.json");
process.env.TELAR_CLAUDE_SETTINGS_PATH = runtimeSettings;

// Account isolation (the "both accounts point to work" bug): a subscription
// account with NO configDir must land on the provider's BASE login regardless
// of what CLAUDE_CONFIG_DIR the Telar server was launched under.
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.CLAUDE_CONFIG_DIR;
  fs.writeFileSync(runtimeSettings, JSON.stringify({ env: {} }));
});
afterEach(() => {
  if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prev;
});

test("a no-configDir claude account deletes CLAUDE_CONFIG_DIR — never inherits an ambient one", () => {
  process.env.CLAUDE_CONFIG_DIR = "/Users/facundo/.claude-work"; // ambient pollution
  const env = accountEnv({ name: "personal", provider: "claude", authMode: "subscription" });
  // Deleted → the subprocess is CLAUDE_CONFIG_DIR-less → base (personal) login,
  // NOT the inherited work dir.
  expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
});

test("an explicit-configDir account still pins its own login", () => {
  process.env.CLAUDE_CONFIG_DIR = "/Users/facundo/.claude-work";
  const env = accountEnv({
    name: "work",
    provider: "claude",
    authMode: "subscription",
    configDir: "/Users/facundo/.claude-work",
  });
  expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/facundo/.claude-work");
});

test("two different accounts never resolve to the same config dir", () => {
  process.env.CLAUDE_CONFIG_DIR = "/Users/facundo/.claude-work";
  const personal = accountEnv({ name: "personal", provider: "claude", authMode: "subscription" });
  const work = accountEnv({ name: "work", provider: "claude", authMode: "subscription", configDir: "/Users/facundo/.claude-work" });
  expect(personal.CLAUDE_CONFIG_DIR).not.toBe(work.CLAUDE_CONFIG_DIR);
});

// ── ambient routing/identity must never decide for an account ──────────────
// Same failure family as the CLAUDE_CONFIG_DIR case above, one layer out: the
// config dir decides WHICH LOGIN, these decide WHERE THE REQUEST GOES and WHO
// IT GOES AS. A shell that exports them (notably a terminal spawned by Claude
// Code, which exports its settings.json `env` block) would otherwise reroute or
// re-bill every account at once, with nothing in the registry saying so.
const OWNED = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
];
let ambient: Record<string, string | undefined> = {};
beforeEach(() => {
  ambient = Object.fromEntries(OWNED.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of OWNED) {
    if (ambient[k] === undefined) delete process.env[k];
    else process.env[k] = ambient[k];
  }
});

test("the native Claude account inherits its ambient runtime route", () => {
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8317";
  const env = accountEnv({ name: "personal", provider: "claude", authMode: "subscription" });
  expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
});

test("the native Claude account inherits its explicitly configured API identity", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-ambient";
  const env = accountEnv({ name: "personal", provider: "claude", authMode: "subscription" });
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-ambient");
});

test("the native Claude account inherits its configured router token", () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "sk-local-ambient";
  const env = accountEnv({ name: "personal", provider: "claude", authMode: "subscription" });
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-local-ambient");
});

test("Claude settings contribute routing and model aliases without loading the user tier", () => {
  fs.writeFileSync(runtimeSettings, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      ANTHROPIC_AUTH_TOKEN: "router-token",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "gpt-routed-mini",
      UNRELATED_TOOL_ENV: "must-not-leak-from-settings",
    },
  }));
  const env = accountEnv({ name: "personal", provider: "claude", authMode: "subscription" });
  expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("router-token");
  expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("gpt-routed-mini");
  expect(env.UNRELATED_TOOL_ENV).toBeUndefined();
});

test("codex accounts get the same guard in their own spelling", () => {
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:8317/v1";
  process.env.OPENAI_API_KEY = "sk-ambient";
  const env = accountEnv({ name: "cx", provider: "codex", authMode: "subscription" });
  expect("OPENAI_BASE_URL" in env).toBe(false);
  expect("OPENAI_API_KEY" in env).toBe(false);
});

test("DECLARING still works — the guard stops inheriting, not choosing", () => {
  // An explicitly routed account says so, so it gets the declared environment.
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9999"; // ambient, must lose
  const env = accountEnv({
    name: "proxied",
    provider: "claude",
    authMode: "subscription",
    env: [
      { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", sensitive: false },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-local-declared", sensitive: false },
    ],
  });
  expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-local-declared");
});

test("api-key auth mode still sets its token after the guard runs", () => {
  // Ordering proof: the delete happens BEFORE the auth-mode token is applied,
  // so the guard must not wipe the value the account actually asked for.
  process.env.ANTHROPIC_API_KEY = "sk-ambient-loser";
  process.env.MY_KEY_SRC = "sk-declared-winner";
  const env = accountEnv({
    name: "keyed",
    provider: "claude",
    authMode: "api-key",
    tokenEnv: "MY_KEY_SRC",
  });
  expect(env.ANTHROPIC_API_KEY).toBe("sk-declared-winner");
  delete process.env.MY_KEY_SRC;
});

test("an isolated config-dir account does not inherit the native runtime route", () => {
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8317";
  const native = accountEnv({ name: "personal", provider: "claude" });
  const isolated = accountEnv({ name: "work", provider: "claude", configDir: "/tmp/claude-work" });
  expect(native.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
  expect(isolated.ANTHROPIC_BASE_URL).toBeUndefined();
});
