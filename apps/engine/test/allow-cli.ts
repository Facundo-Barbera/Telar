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
