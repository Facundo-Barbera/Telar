import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClaudeDriver } from "../src/driver";

/**
 * THE ACTUAL SPAWN BOUNDARY, not the shape of an options object.
 *
 * `resolveChildEnv` deletes a key the turn's env patch maps to `undefined`, so
 * a configured login stops inheriting an ambient credential. That only achieves
 * anything if the installed SDK treats the supplied environment as a
 * REPLACEMENT — an SDK that merged `process.env` back over it would hand the
 * credential to the child anyway, and every object-shape assertion in
 * claude-identity.test.ts would be testing a fiction.
 *
 * So this drives the REAL `@anthropic-ai/claude-agent-sdk` and points it at a
 * fixture executable that writes its own environment to a file and exits. No
 * provider is contacted: the fixture speaks none of the CLI's protocol, so the
 * query fails immediately afterwards and the failure is expected. The file is
 * the evidence.
 */
test("the installed SDK replaces the child environment, so a deleted key is really gone", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-child-env-"));
  const dump = path.join(home, "env.json");
  const fixture = path.join(home, "fake-claude");
  // Bare POSIX sh, and it exits at once: it is a probe, not a CLI.
  fs.writeFileSync(
    fixture,
    ["#!/bin/sh", `/usr/bin/env > ${JSON.stringify(`${dump}.txt`)}`, "exit 0", ""].join("\n"),
    { mode: 0o755 },
  );

  process.env.TELAR_TEST_SPAWN_CREDENTIAL = "ambient-secret";
  const controller = new AbortController();
  try {
    const driver = createClaudeDriver(undefined, { resolveExecutable: () => fixture });
    await driver
      .run({
        prompt: "probe",
        sessionId: "session_child_env",
        cwd: home,
        signal: controller.signal,
        env: { TELAR_TEST_SPAWN_CREDENTIAL: undefined, TELAR_TEST_SPAWN_MARKER: "kept" },
        onObservations: async () => undefined,
      })
      // The fixture is not Claude Code; it exits without speaking the protocol
      // and the turn fails. That is the point — the environment is already on
      // disk by then.
      .catch(() => undefined);
  } finally {
    controller.abort();
    delete process.env.TELAR_TEST_SPAWN_CREDENTIAL;
  }

  const dumped = `${dump}.txt`;
  if (!fs.existsSync(dumped)) throw new Error("the fixture executable was never spawned; this test proves nothing as written");
  const lines = fs.readFileSync(dumped, "utf8").split("\n");
  const keys = new Set(lines.map((line) => line.slice(0, line.indexOf("="))));
  // The patch reached the child…
  expect(keys.has("TELAR_TEST_SPAWN_MARKER")).toBeTrue();
  // …the deletion reached it too, rather than being merged back from the
  // worker's own environment…
  expect(keys.has("TELAR_TEST_SPAWN_CREDENTIAL")).toBeFalse();
  // …and the child still inherits what an ordinary process needs.
  expect(keys.has("PATH")).toBeTrue();

  fs.rmSync(home, { recursive: true, force: true });
}, 30_000);
