/**
 * WHERE THE OPENCODE GO KEY COMES FROM, and what may be said about it (#526).
 *
 * Every rung is faked here, including the CLI file, so the suite never depends
 * on whether the machine running it has an OpenCode login — and never reads a
 * real one. What is pinned:
 *
 *   - the ORDER, all three present at once: a pasted key beats the environment
 *     beats the CLI, because the pasted one is the owner saying which account
 *     this machine's Main assistant runs on;
 *   - that a MALFORMED CLI entry is "no key" rather than an error, including the
 *     OAuth-shaped entry that lives in the same document;
 *   - that nothing which describes a key contains one.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeGoCredential,
  GO_API_KEY_VAR,
  openCodeAuthFile,
  readOpenCodeCliKey,
  redactKey,
  resolveGoCredential,
} from "../src/main-session/credentials";

const roots: string[] = [];
const tempHome = (auth?: unknown): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "go-key-"));
  roots.push(home);
  if (auth !== undefined) {
    const file = openCodeAuthFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(auth));
  }
  return home;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("the pasted key wins over the environment and over the CLI", () => {
  const resolved = resolveGoCredential({
    instanceEnv: { [GO_API_KEY_VAR]: "sk-pasted" },
    processEnv: { [GO_API_KEY_VAR]: "sk-ambient" },
    readCliKey: () => "sk-cli",
  });
  expect(resolved).toEqual({ key: "sk-pasted", source: "setting" });
});

test("the environment answers when nothing was pasted", () => {
  const resolved = resolveGoCredential({
    instanceEnv: {},
    processEnv: { [GO_API_KEY_VAR]: "sk-ambient" },
    readCliKey: () => "sk-cli",
  });
  expect(resolved).toEqual({ key: "sk-ambient", source: "environment" });
});

test("the CLI's own key is the last rung, not the first", () => {
  const resolved = resolveGoCredential({ instanceEnv: {}, processEnv: {}, readCliKey: () => "sk-cli" });
  expect(resolved).toEqual({ key: "sk-cli", source: "cli" });
});

test("all three absent is absent — the setup field's case, not an error", () => {
  expect(resolveGoCredential({ instanceEnv: {}, processEnv: {}, readCliKey: () => undefined })).toBeUndefined();
});

test("a blank value on any rung is not a key", () => {
  const resolved = resolveGoCredential({
    instanceEnv: { [GO_API_KEY_VAR]: "   " },
    processEnv: { [GO_API_KEY_VAR]: "" },
    readCliKey: () => "sk-cli",
  });
  expect(resolved).toEqual({ key: "sk-cli", source: "cli" });
});

test("the CLI file is read for its opencode-go api entry and nothing else", () => {
  const home = tempHome({ "opencode-go": { type: "api", key: "sk-from-cli" }, anthropic: { type: "api", key: "sk-other" } });
  expect(readOpenCodeCliKey(openCodeAuthFile(home))).toBe("sk-from-cli");
});

test("an OAuth-shaped entry under the same name is not an api key", () => {
  // The CLI keeps both shapes in one document. Spending a refresh token as an
  // api key would 401 and read as the person's mistake.
  const home = tempHome({ "opencode-go": { type: "oauth", refresh: "rt-1", access: "at-1" } });
  expect(readOpenCodeCliKey(openCodeAuthFile(home))).toBeUndefined();
});

test("a missing, unreadable or unparseable file is simply no key", () => {
  expect(readOpenCodeCliKey(path.join(tempHome(), "nothing.json"))).toBeUndefined();

  const home = tempHome();
  const file = openCodeAuthFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  expect(readOpenCodeCliKey(file)).toBeUndefined();

  fs.writeFileSync(file, JSON.stringify({ "opencode-go": { type: "api", key: "   " } }));
  expect(readOpenCodeCliKey(file)).toBeUndefined();
});

test("nothing that describes a key contains one", () => {
  const key = "sk-super-secret-value";
  for (const source of ["setting", "environment", "cli"] as const) {
    const described = describeGoCredential({ key, source });
    expect(described).not.toContain(key);
    // Not a prefix either: four characters of a key is still four characters
    // of a key in somebody's log aggregator.
    expect(described).not.toContain(key.slice(0, 6));
  }
  expect(describeGoCredential(undefined)).toBe("no OpenCode Go key is configured");
});

test("redaction removes every occurrence, and leaves text alone when there is no key", () => {
  expect(redactKey("auth failed for sk-1 (sent sk-1)", "sk-1")).toBe("auth failed for [redacted] (sent [redacted])");
  expect(redactKey("nothing to hide", undefined)).toBe("nothing to hide");
  expect(redactKey("nothing to hide", "")).toBe("nothing to hide");
});
