import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll } from "bun:test";

/**
 * "THIS FILE DRIVES A CLI ON PURPOSE" — the opt-in past issue #532's gate.
 *
 * `requireCli` refuses every provider spawn under `NODE_ENV=test` (see
 * `refuseCliSpawnUnderTest`), because for months nothing stopped a test from
 * quietly spending the machine owner's Claude subscription on generated
 * session titles. A handful of tests legitimately resolve a CLI anyway: they
 * put a FAKE `claude` or `codex` script on PATH and assert what the driver
 * sends it. Those files call this, and the call is the declaration — a reader
 * of the file learns from line one that a binary gets resolved here.
 *
 * HOOKS RATHER THAN A BARE ASSIGNMENT, because bun runs every test file in one
 * process: setting the variable at import time would lift the gate for every
 * file that ran after this one, which is most of the suite. `beforeAll` and
 * `afterAll` are the file's own scope, so the window is exactly this file, and
 * whatever the environment held before is put back rather than deleted.
 */
export function allowCliInThisFile(): void {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.TELAR_ALLOW_CLI;
    process.env.TELAR_ALLOW_CLI = "1";
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.TELAR_ALLOW_CLI;
    else process.env.TELAR_ALLOW_CLI = previous;
  });
}

/** A `claude` that EXISTS and refuses to run. See ./fixtures/fake-claude. */
const FAKE_CLAUDE = path.join(import.meta.dir, "fixtures", "fake-claude");

/**
 * "RESOLVE A CLAUDE WITHOUT ASKING THIS MACHINE" — the other half of the gate
 * above, and the fix for issue #752.
 *
 * `allowCliInThisFile` lets a file resolve a CLI. It does not say WHICH, and
 * the answer used to be "whatever the host has": `cli-resolution.ts` searches
 * PATH, then the login shell's and `launchctl`'s PATH, then three well-known
 * directories. A developer Mac essentially always finds a real Claude Code; a
 * clean runner finds nothing and `requireCli` throws. Eight tests across two
 * files went down that way on `ubuntu-latest` while passing here — the suite
 * was reporting a fact about the machine rather than about the code.
 *
 * These files drive a FAKE SDK and spawn nothing; they need a path to exist,
 * not a provider to run. So pin one. `plugin-approval-dispatch.test.ts` pins
 * `CODEX_BIN` for the mirror-image reason — to stop the driver finding the REAL
 * codex and spawning it — and the two now bracket the same seam from both ends.
 *
 * HOOKS RATHER THAN A BARE ASSIGNMENT, for the same reason as above: bun runs
 * every test file in one process, so the window must be exactly this file.
 */
export function pinFakeClaudeInThisFile(): void {
  let previous: string | undefined;
  beforeAll(() => {
    if (!fs.existsSync(FAKE_CLAUDE)) {
      throw new Error("the fake claude fixture is missing; refusing to run rather than fall back to whatever this machine has installed");
    }
    previous = process.env.CLAUDE_CODE_EXECUTABLE;
    process.env.CLAUDE_CODE_EXECUTABLE = FAKE_CLAUDE;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE;
    else process.env.CLAUDE_CODE_EXECUTABLE = previous;
  });
}
