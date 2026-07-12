// M5 flag-off byte-identity: both flags are false by default and honor the
// manifest field + the TELAR_*=1 env override (mirrors autoRepairEnabled).
import { afterEach, describe, expect, test } from "bun:test";
import { runnerEnabled, setupAgentEnabled } from "../src/runner/flag";

afterEach(() => {
  delete process.env.TELAR_RUNNER;
  delete process.env.TELAR_SETUP_AGENT;
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

describe("setupAgentEnabled", () => {
  test("false by default; honors manifest flag + env override", () => {
    delete process.env.TELAR_SETUP_AGENT;
    expect(setupAgentEnabled({})).toBe(false);
    expect(setupAgentEnabled({ setupAgent: false })).toBe(false);
    expect(setupAgentEnabled({ setupAgent: true })).toBe(true);
    process.env.TELAR_SETUP_AGENT = "1";
    expect(setupAgentEnabled({})).toBe(true);
  });
});
