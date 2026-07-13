// M5 flag-off byte-identity: the out-of-process runner flag is false by default
// and honors the manifest field + the TELAR_RUNNER=1 env override. (The
// setupAgent flag was collapsed to the unconditional engine path — its helper
// and its test are gone; only the A2-scoped outOfProcessRunner flag remains.)
import { afterEach, describe, expect, test } from "bun:test";
import { runnerEnabled } from "../src/runner/flag";

afterEach(() => {
  delete process.env.TELAR_RUNNER;
});

describe("runnerEnabled", () => {
  test("false by default; honors manifest flag + env override", () => {
    delete process.env.TELAR_RUNNER;
    expect(runnerEnabled({})).toBe(false);
    expect(runnerEnabled({ outOfProcessRunner: false })).toBe(false);
    expect(runnerEnabled({ outOfProcessRunner: true })).toBe(true);
    process.env.TELAR_RUNNER = "1";
    expect(runnerEnabled({})).toBe(true);
  });
});
