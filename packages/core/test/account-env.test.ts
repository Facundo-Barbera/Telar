import { afterEach, beforeEach, expect, test } from "bun:test";
import { accountEnv } from "../src/engine";

// Account isolation (the "both accounts point to work" bug): a subscription
// account with NO configDir must land on the provider's BASE login regardless
// of what CLAUDE_CONFIG_DIR the Telar server was launched under.
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.CLAUDE_CONFIG_DIR;
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

test("an ambient ANTHROPIC_BASE_URL never reaches a plain account", () => {
  // The CLIProxyAPI case: the proxy is a real, working setup — but an account
  // that never asked for it must not be silently routed through it.
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8317";
  const env = accountEnv({ name: "personal", provider: "claude", authMode: "subscription" });
  expect("ANTHROPIC_BASE_URL" in env).toBe(false);
});

test("an ambient ANTHROPIC_API_KEY cannot re-bill a subscription account", () => {
  // Silently swapping a Max subscription onto metered API billing is the same
  // class of bug as landing `personal` on the work login.
  process.env.ANTHROPIC_API_KEY = "sk-ant-ambient";
  const env = accountEnv({ name: "personal", provider: "claude", authMode: "subscription" });
  expect("ANTHROPIC_API_KEY" in env).toBe(false);
});

test("an ambient ANTHROPIC_AUTH_TOKEN cannot replace the Keychain identity", () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "sk-local-ambient";
  const env = accountEnv({ name: "personal", provider: "claude", authMode: "subscription" });
  expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(false);
});

test("codex accounts get the same guard in their own spelling", () => {
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:8317/v1";
  process.env.OPENAI_API_KEY = "sk-ambient";
  const env = accountEnv({ name: "cx", provider: "codex", authMode: "subscription" });
  expect("OPENAI_BASE_URL" in env).toBe(false);
  expect("OPENAI_API_KEY" in env).toBe(false);
});

test("DECLARING still works — the guard stops inheriting, not choosing", () => {
  // A proxy-backed account: it says so, so it gets it. This is the supported
  // way to run Telar through CLIProxyAPI.
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

test("two accounts, one ambient proxy: only the declaring one is routed", () => {
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8317";
  const plain = accountEnv({ name: "direct", provider: "claude" });
  const proxied = accountEnv({
    name: "proxied",
    provider: "claude",
    env: [{ name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", sensitive: false }],
  });
  expect(plain.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(proxied.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
});
