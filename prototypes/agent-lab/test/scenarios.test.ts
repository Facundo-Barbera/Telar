/**
 * The seven scenarios, as tests.
 *
 * Each one is the same function `bun run scenario:<n>` runs, so a green test and
 * a green command cannot disagree — and the evidence table in REPORT.md is the
 * output of the thing CI checks rather than of a second implementation.
 *
 * Scenarios 1 and 3 spawn a real child process. It is awaited and its exit code
 * is checked, so nothing here outlives the test.
 */
import { describe, expect, test } from "bun:test";
import { runScenario1 } from "../src/scenarios/1-own-state";
import { runScenario2 } from "../src/scenarios/2-streaming-read";
import { runScenario3 } from "../src/scenarios/3-approval-restart";
import { runScenario4 } from "../src/scenarios/4-delegation";
import { runScenario5 } from "../src/scenarios/5-cancellation";
import { runScenario6 } from "../src/scenarios/6-no-duplicate-delegation";
import { runScenario7 } from "../src/scenarios/7-growing-context";

describe("A. LangGraph scenarios", () => {
  test("1 — own state, no Telar session, resumed in a fresh process", async () => {
    expect(await runScenario1()).toBe(true);
  });

  test("2 — streaming after a read tool", async () => {
    expect(await runScenario2()).toBe(true);
  });

  test("3 — permission interrupt survives a restart", async () => {
    expect(await runScenario3()).toBe(true);
  });

  test("4 — delegation round trip", async () => {
    expect(await runScenario4()).toBe(true);
  });

  test("5 — cancellation mid-stream and mid-tool", async () => {
    expect(await runScenario5()).toBe(true);
  });

  test("6 — no duplicate delegation on retry", async () => {
    expect(await runScenario6()).toBe(true);
  });

  test("7 — growing context over 40 turns", async () => {
    expect(await runScenario7()).toBe(true);
  });
});
