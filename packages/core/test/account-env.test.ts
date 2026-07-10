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
