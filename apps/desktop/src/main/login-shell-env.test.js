"use strict";

const { afterEach, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { captureLoginShellEnv } = require("./login-shell-env");

const saved = { ...process.env };
const dirs = [];

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeShell(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-login-shell-"));
  dirs.push(dir);
  const shell = path.join(dir, "shell");
  fs.writeFileSync(shell, `#!/bin/sh\ncat <<'EOF'\n${lines.join("\n")}\nEOF\n`, { mode: 0o755 });
  return shell;
}

test("the login shell's PATH comes first, then the entries only the app had, without repeats", () => {
  process.env.SHELL = fakeShell(["PATH=/opt/login/bin:/usr/bin"]);
  process.env.PATH = "/usr/bin:/app/only";
  captureLoginShellEnv();
  expect(process.env.PATH).toBe("/opt/login/bin:/usr/bin:/app/only");
});

test("other variables fill gaps and never override what the app already has", () => {
  process.env.SHELL = fakeShell(["TELAR_TEST_NEW=from-shell", "TELAR_TEST_KEPT=from-shell", "=ignored"]);
  process.env.TELAR_TEST_KEPT = "from-app";
  captureLoginShellEnv();
  expect(process.env.TELAR_TEST_NEW).toBe("from-shell");
  expect(process.env.TELAR_TEST_KEPT).toBe("from-app");
});

test("a shell that cannot run leaves the environment alone", () => {
  process.env.SHELL = path.join(os.tmpdir(), "telar-no-such-shell");
  const before = { ...process.env };
  captureLoginShellEnv();
  expect(process.env).toEqual(before);
});
