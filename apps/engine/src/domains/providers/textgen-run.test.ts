import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPENCODE_VERSION } from "../../drivers/opencode/version";
import { runStructured, runStructuredOrThrow, TextGenFailure } from "./textgen-run";

const roots: string[] = [];
let previous: string | undefined;
beforeAll(() => {
  previous = process.env.TELAR_ALLOW_CLI;
  process.env.TELAR_ALLOW_CLI = "1";
});
afterAll(() => {
  if (previous === undefined) delete process.env.TELAR_ALLOW_CLI;
  else process.env.TELAR_ALLOW_CLI = previous;
});
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fakeCli(name: "claude" | "codex" | "opencode", body: string): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "telar-tg-fake-"));
  roots.push(bin);
  const binaryPath = path.join(bin, name);
  const version = name === "opencode" ? OPENCODE_VERSION : "2.1.270 (fake)";
  fs.writeFileSync(binaryPath, `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version}" && exit 0\ncat > /dev/null\n${body}\n`);
  fs.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

const fail = (driver: "claude" | "codex" | "opencode", binaryPath: string) =>
  runStructuredOrThrow({ driver, binaryPath }, "title this", {}).then(
    () => "answered",
    (error: unknown) => (error instanceof TextGenFailure ? error.message : `unexpected ${String(error)}`),
  );

test("claude's structured output is the answer", async () => {
  const binaryPath = fakeCli("claude", `echo '{"type":"result","subtype":"success","is_error":false,"structured_output":{"title":"Rail Flicker"}}'`);
  expect(await runStructuredOrThrow({ driver: "claude", binaryPath }, "title this", {})).toEqual({ title: "Rail Flicker" });
});

test("a claude API error is reported by its result text, not as a missing answer", async () => {
  const binaryPath = fakeCli(
    "claude",
    `echo '[claude-code:unrecognized_model] {"model":"nope"}' >&2\necho '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"API Error: 400 unknown provider for model nope"}'\nexit 1`,
  );
  expect(await fail("claude", binaryPath)).toBe("API Error: 400 unknown provider for model nope");
});

test("a claude that is not logged in says so even when it exits 0", async () => {
  const binaryPath = fakeCli("claude", `echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}'`);
  expect(await fail("claude", binaryPath)).toBe("Not logged in · Please run /login");
});

test("a crash reports its exit code and stderr", async () => {
  const binaryPath = fakeCli("claude", `echo 'segfault in model loader' >&2\nexit 3`);
  expect(await fail("claude", binaryPath)).toBe("exited 3: segfault in model loader");
});

test("an opencode provider error reports its exit and stderr", async () => {
  const binaryPath = fakeCli("opencode", `echo 'Error: The security token included in the request has expired.' >&2\nexit 1`);
  expect(await fail("opencode", binaryPath)).toBe("exited 1: Error: The security token included in the request has expired.");
});

test("an opencode run that exits 0 without JSON says there was no answer", async () => {
  const binaryPath = fakeCli("opencode", `echo '{"type":"text","part":{"text":"I cannot help"}}'\necho 'rate limited' >&2`);
  expect(await fail("opencode", binaryPath)).toBe("no JSON answer: rate limited");
});

test("a codex run that writes no last message says there was no answer", async () => {
  const binaryPath = fakeCli("codex", "exit 0");
  expect(await fail("codex", binaryPath)).toBe("no JSON answer");
});

test("runStructured logs the reason and answers undefined", async () => {
  const binaryPath = fakeCli("claude", `echo 'boom' >&2\nexit 2`);
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: string) => logged.push(line);
  try {
    expect(await runStructured({ driver: "claude", binaryPath }, "title this", {})).toBeUndefined();
  } finally {
    console.error = original;
  }
  expect(logged).toEqual(["[engine] claude text generation failed: exited 2: boom"]);
});

test("a CLI that floods stdout is killed past 4 MB and logged, not buffered", async () => {
  const binaryPath = fakeCli("claude", `while :; do head -c 1048576 /dev/zero | tr '\\0' x; done`);
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: string) => logged.push(line);
  try {
    expect(await runStructured({ driver: "claude", binaryPath }, "title this", {})).toBeUndefined();
  } finally {
    console.error = original;
  }
  expect(logged).toEqual(["[engine] claude text generation failed: output passed 4 MB"]);
});
