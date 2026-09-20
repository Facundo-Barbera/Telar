/**
 * THE CEILING IS IN FORCE, NOT MERELY CONFIGURED (#740).
 *
 * #414's defect was not a wrong number. It was a number nobody checked had
 * applied: `[test] timeout` in bunfig.toml, silently ignored, believed fixed for
 * days while the engine suite ran on bun's 5 s default. The ceiling has moved to
 * a mechanism that does work, which leaves the lesson rather than the bug — so
 * the mechanism is asserted here instead of trusted.
 *
 * WHAT IS EVIDENCE AND WHAT IS NOT. The preload records what it did on
 * `globalThis`, and that is its own account of itself: it proves the file RAN,
 * and nothing about what bun will enforce. So every claim about the ceiling
 * itself is made by spawning `bun test` and reading what the child REPORTED —
 * a test killed at a bound is a fact the runner produced, not a string the
 * preload chose. #772 is the cost of getting this wrong: a "prove the block ran"
 * grep keyed on a describe name, which a SKIPPED block prints too, so the guard
 * was satisfied exactly when the thing it guarded against had happened.
 *
 * THE CASE THAT MATTERS MOST IS THE NEGATIVE ONE. `setDefaultTimeout` from a
 * preload overrides `--timeout` in both directions, so the obvious
 * implementation — call it unconditionally — would silently clamp
 * `bun test --timeout 60000` to 20 s and hand the next person a 20 007 ms
 * failure to misread exactly as the 5 007 ms ones were. Two tests below are that
 * case, and both were confirmed to fail against the unconditional implementation
 * before being trusted here.
 */
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * READ AT MODULE LOAD, BEFORE ANY IMPORT OF THE PRELOAD ITSELF. Importing
 * scripts/test-ceiling.mjs sets the ceiling as a side effect, so a static import
 * at the top of this file would make these assertions pass whether or not the
 * registration is live — green exactly where it is not needed, which is the
 * shape of the #414 check that never fired.
 */
const ceilingFromPreload = (globalThis as { __telarTestCeilingMs?: number }).__telarTestCeilingMs;
const sourceFromPreload = (globalThis as { __telarTestCeilingSource?: string }).__telarTestCeilingSource;

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A throwaway suite of one test, outside the repo so no sweep can collect it. */
const fixture = (body: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-ceiling-"));
  roots.push(root);
  const file = path.join(root, "ceiling-fixture.test.ts");
  fs.writeFileSync(file, body);
  return file;
};

/**
 * The invocation under test: `bun test <path>` with the repo root as cwd, which
 * is where bun looks for the bunfig that registers the ceiling. `flag` is passed
 * the way a person would type it, so the child's own command line is what the
 * preload has to read it back from.
 */
const runFromRepoRoot = (
  file: string,
  { ceiling, flag }: { ceiling?: string; flag?: string } = {},
): { output: string; status: number | null } => {
  const environment = { ...process.env };
  delete environment.TELAR_TEST_TIMEOUT_MS;
  if (ceiling !== undefined) environment.TELAR_TEST_TIMEOUT_MS = ceiling;
  const run = spawnSync(process.execPath, ["test", ...(flag ? ["--timeout", flag] : []), file], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: environment,
  });
  return { output: `${run.stdout ?? ""}${run.stderr ?? ""}`, status: run.status };
};

const sleeps = (ms: number): string => `import { test, expect } from "bun:test";
test("sleeps ${ms}ms and declares no ceiling of its own", async () => {
  await new Promise((resolve) => setTimeout(resolve, ${ms}));
  expect(1).toBe(1);
});
`;

test("the preload ran in this process, and says which knob it took the ceiling from", async () => {
  const { TEST_CEILING_MS } = await import("../../../scripts/test-ceiling.mjs");
  // Corroboration, not proof — see the header. The suite runs with no flag and
  // normally no env var, so the preload should have fallen through to its own
  // constant; a machine using the documented override is the other legal answer.
  expect(["default", "env", "flag"]).toContain(sourceFromPreload);
  if (sourceFromPreload === "default") expect(ceilingFromPreload).toBe(TEST_CEILING_MS);
  // The property that matters about the number, rather than the number twice:
  // anything at or under bun's own default would leave #740's trap open.
  expect(TEST_CEILING_MS).toBeGreaterThan(5_000);
  expect(ceilingFromPreload).toBeGreaterThan(5_000);
});

/**
 * THE DEADLINES ON THESE TESTS BOUND A HANG; NOTHING IS COMPARED AGAINST THEM
 * (#706). Each spawns a child `bun test` and asserts what that child REPORTED,
 * never how long anything took, so a loaded machine makes them slower and not
 * redder — which is the distinction #748 was filed about.
 */
test("a bare `bun test <path>` from the repo root takes its ceiling from the preload", () => {
  // 120 ms is a number only the preload can produce. Bun's own default is
  // 5,000, under which a 400 ms test passes comfortably; a death at 120 ms is
  // therefore proof that the root bunfig's registration reached this run.
  const { output, status } = runFromRepoRoot(fixture(sleeps(400)), { ceiling: "120" });
  expect(output).toContain("timed out after 120ms");
  expect(status).not.toBe(0);
}, 60_000);

test("and that ceiling is really above bun's default, not merely reported to be", () => {
  // The claim #740 actually makes, with nothing but the runner's own verdict
  // behind it: a test that bun's 5 s default would kill, run the way a person
  // types it, passing. No env var, no flag — the constant, in force.
  const { output, status } = runFromRepoRoot(fixture(sleeps(5_200)));
  expect(output).not.toContain("timed out");
  expect(output).toContain("1 pass");
  expect(status).toBe(0);
}, 60_000);

test("an explicit --timeout is honoured against the real 20 s constant, not swallowed by it", () => {
  // THE CLAMP THAT MUST NOT EXIST, measured against the ceiling that actually
  // ships. No env var, so the preload's own constant is the rival: the flag asks
  // for 300 ms and the test wants 700, which is BELOW the constant. Honoured, the
  // test dies at 300; clamped to 20 s, it passes — and asserting the death rather
  // than the pass is how this stays exact about a 20-second ceiling without
  // sleeping for twenty seconds.
  //
  // Read it the other way round and it is the orchestrator's case: if a
  // `--timeout` under the constant survives, the preload is not overwriting what
  // bun parsed, which is the same branch `--timeout 60000` takes.
  const { output, status } = runFromRepoRoot(fixture(sleeps(700)), { flag: "300" });
  expect(output).toContain("timed out after 300ms");
  expect(status).not.toBe(0);
}, 60_000);

test("and a --timeout ABOVE the ceiling the preload was configured with survives too", () => {
  // The raise direction, which needs a configured ceiling small enough to see
  // past: the preload is told 200 ms, the command line asks for 3,000, and the
  // test wants 700 in between. Honoured, it passes; clamped to what the preload
  // was configured with, it dies at 200 ms.
  const { output, status } = runFromRepoRoot(fixture(sleeps(700)), { ceiling: "200", flag: "3000" });
  expect(output).not.toContain("timed out");
  expect(output).toContain("1 pass");
  expect(status).toBe(0);
}, 60_000);

test("a test's own ceiling still beats every default above it", () => {
  // The escape hatch a genuinely slow test uses: the preload sets a DEFAULT, not
  // a cap, so a per-test bound keeps meaning what it says in both directions.
  const { output, status } = runFromRepoRoot(
    fixture(`import { test, expect } from "bun:test";
test("sleeps 400ms under its own 120ms ceiling", async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(1).toBe(1);
}, 120);
`),
    { ceiling: "9000" },
  );
  expect(output).toContain("timed out after 120ms");
  expect(status).not.toBe(0);
}, 60_000);

test("the flag is read out of a real command line, in either spelling, without false positives", async () => {
  const { timeoutFlagIn, ownCommandLine } = await import("../../../scripts/test-ceiling.mjs");
  const samples: Array<{ reads: number | null; why: string; line: string }> = [
    { reads: 20_000, why: "the spaced spelling", line: "bun test --timeout 20000 one.test.ts" },
    { reads: 20_000, why: "the = spelling", line: "bun test --timeout=20000 one.test.ts" },
    { reads: 250, why: "trailing, with nothing after it", line: "bun test one.test.ts --timeout 250" },
    { reads: null, why: "no flag at all", line: "bun test one.test.ts" },
    { reads: null, why: "a longer flag that starts the same way", line: "bun test --timeout-per-file 900 one.test.ts" },
    { reads: null, why: "the flag named inside a path", line: "bun test fixtures/--timeout/one.test.ts" },
    { reads: null, why: "a non-numeric argument", line: "bun test --timeout soon one.test.ts" },
  ];
  const wrong = samples.filter((sample) => timeoutFlagIn(sample.line) !== sample.reads);
  expect(wrong.map((sample) => `${sample.why}: ${sample.line}`)).toEqual([]);

  // And that the reader works AT ALL on this platform: if it returns null the
  // ceiling silently stops honouring flags, which is why the preload says so on
  // stderr when it happens rather than carrying on quietly.
  const line = ownCommandLine();
  expect(typeof line).toBe("string");
  expect(line).toContain("bun");
});
