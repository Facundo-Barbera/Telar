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
 * HOW LONG A CHILD `bun test` GETS BEFORE THIS HELPER KILLS IT — #807.
 *
 * THE CEILING ABOVE CANNOT REACH IN HERE, and that is the whole reason this
 * number exists. Bun's per-test ceiling is a timer on the event loop;
 * `spawnSync` blocks the JS thread in `wait4`, so a thread parked in that
 * syscall never reaches the timer and a child that never exits is a test that
 * never fails. On this file that is the sharpest case in the suite: seven child
 * `bun test` invocations, so one stuck child is TWO unbounded `bun test`
 * processes — this one blocked on a child of its own — and nothing bounded
 * either of them.
 *
 * IT IS A PER-CALL-SITE NUMBER, NOT A BLANKET WRAPPER. Every child spawned here
 * is a fixture of one or two tests that sleep for well under a second, so 45 s
 * is two orders of magnitude of slack — and it sits UNDER the 60 s deadline each
 * test using this helper declares. That ordering is the point: a stuck child
 * comes back as `timedOut` from this helper, which a test can assert on, rather
 * than as a dead test the runner reports with no reason attached.
 */
const CHILD_RUN_BUDGET_MS = 45_000;

/**
 * The invocation under test: `bun test <path>` with the repo root as cwd, which
 * is where bun looks for the bunfig that registers the ceiling. `flag` is passed
 * the way a person would type it, so the child's own command line is what the
 * preload has to read it back from.
 */
const runFromRepoRoot = (
  files: string | string[],
  { ceiling, flag, budgetMs = CHILD_RUN_BUDGET_MS }: { ceiling?: string; flag?: string; budgetMs?: number } = {},
): { output: string; status: number | null; timedOut: boolean; killedPid: number | undefined } => {
  const environment = { ...process.env };
  delete environment.TELAR_TEST_TIMEOUT_MS;
  if (ceiling !== undefined) environment.TELAR_TEST_TIMEOUT_MS = ceiling;
  // BELT, WITH BRACES BELOW. On the runner the child's failure reporting comes
  // out doubled (see `tally`), and bun's GitHub-Actions reporter is the likely
  // cause — likely, not established: setting GITHUB_ACTIONS, CI, or both on
  // this Mac reproduces none of it, so this line is a plausible remedy that
  // could not be falsified where it was written. `tally` is what the
  // assertions actually stand on, and it holds whether or not this helps.
  delete environment.GITHUB_ACTIONS;
  const run = spawnSync(process.execPath, ["test", ...(flag ? ["--timeout", flag] : []), ...(Array.isArray(files) ? files : [files])], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: environment,
    timeout: budgetMs,
    // SIGKILL, NOT SIGTERM, for the reason src/worktree.ts already argues at
    // its own sync git runner: what this guards against is a process that is
    // not answering, and a signal it may handle politely is a signal it may
    // never get around to handling. A `bun test` parked on a module-scope await
    // that never settles is exactly that — nothing of its own is running.
    killSignal: "SIGKILL",
  });
  const failure = run.error as { code?: string } | undefined;
  // THE SECOND CLAUSE IS KEPT FOR THE REASON THE GIT RUNNER KEEPS IT: a child
  // that died on SIGKILL with no status is one this helper killed, on a
  // platform that did not also hand back ETIMEDOUT.
  const timedOut = failure?.code === "ETIMEDOUT" || (run.status == null && run.signal === "SIGKILL");
  return {
    output: `${run.stdout ?? ""}${run.stderr ?? ""}`,
    status: run.status,
    timedOut,
    // Reported because the SPAWN happened, not because the child cooperated —
    // #748's argument for `spawnSync` over `execFileSync`, reused here so a
    // killed child names the process that was killed.
    killedPid: typeof run.pid === "number" && run.pid > 0 ? run.pid : undefined,
  };
};

/**
 * WHAT THE CHILD COUNTED, NOT HOW MANY TIMES IT SAID SO.
 *
 * The obvious reading of a two-file run is to count `timed out after Nms` in
 * the child's output. That instrument was green on a Mac and came back
 * 2-where-1 and 4-where-2 on the runner — every count exactly DOUBLED, which is
 * what a failure reported twice looks like and is not what a child that ran
 * extra files would produce. It is the mirror image of the `(pass) …` grep #740
 * rejected for reading zero locally, and it was caught by the runner rather
 * than by the check passing.
 *
 * WHY THIS IS NOT THE SAME BET AGAIN. The doubling could not be reproduced
 * here — GITHUB_ACTIONS and CI, alone and together, leave this Mac's output
 * single — so anything the reporter prints once per failure is a quantity whose
 * meaning depends on where it is read. The end-of-run tallies are not: bun
 * writes `N pass` and `N fail` once, which is why the single-file cases above
 * have asserted `1 pass` through CI since #740 and never doubled. And the three
 * states a two-file run can be in — both covered, one covered, neither — are
 * three different pairs rather than a shared substring, so a wrong answer names
 * itself in the failure instead of merely disagreeing with a number.
 */
const tally = (output: string): string => {
  const passed = /^\s*(\d+) pass$/m.exec(output)?.[1];
  const failed = /^\s*(\d+) fail$/m.exec(output)?.[1];
  return `${passed ?? "?"} pass, ${failed ?? "?"} fail`;
};

/**
 * A SUITE THAT CAN NEVER FINISH, and the one shape the ceiling above cannot
 * touch. The `await` is at MODULE SCOPE, so no test ever registers and bun's
 * per-test timer is never armed; measured on bun 1.3.11 for #807, the child
 * prints nothing past its banner and runs forever at ~0% CPU.
 */
const neverExits = (): string => `import { test, expect } from "bun:test";
await new Promise(() => {});
test("this line is never reached, so no ceiling ever applies to it", () => {
  expect(1).toBe(1);
});
`;

const sleeps = (ms: number): string => `import { test, expect } from "bun:test";
test("sleeps ${ms}ms and declares no ceiling of its own", async () => {
  await new Promise((resolve) => setTimeout(resolve, ${ms}));
  expect(1).toBe(1);
});
`;

/**
 * THE CALL SITE'S OWN CEILING, WHICH IS THE ONLY ONE THAT REACHES A BLOCKED
 * THREAD — #807.
 *
 * NOTHING IS COMPARED AGAINST A CLOCK HERE, for #706's reason: the assertion is
 * that the helper RETURNED and what it returned about the child, never how long
 * anything took. A loaded machine makes this slower and not redder.
 *
 * WHAT IT LOOKS LIKE WITHOUT THE FIX is not a red test — it is no test at all.
 * Remove `timeout` from `runFromRepoRoot` and this case does not fail: it hangs,
 * holding a `bun test` of its own open behind it, which is the failure #807
 * reports and the reason scripts/test-engine-bounded.mjs has to tell a hang from
 * a failure rather than reading an exit code.
 */
test("a child that can never finish comes back as a killed child, not as a blocked helper", () => {
  const run = runFromRepoRoot(fixture(neverExits()), { budgetMs: 2_000 });
  expect(run.timedOut).toBe(true);
  // A child killed by a signal has no status at all — distinct from the
  // ordinary non-zero of a suite that ran and failed.
  expect(run.status).toBeNull();
  expect(typeof run.killedPid).toBe("number");
  // AND IT NEVER COUNTED ANYTHING. A run killed before its first test
  // registered prints no end-of-run tally, which is exactly the signal the
  // bounded wrapper reads to tell `hung` from `failed`.
  expect(tally(run.output)).toBe("? pass, ? fail");
}, 60_000);

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

/**
 * THE HALF #740 NEVER RAN, AND THE REASON #792 EXISTS.
 *
 * Every case above hands the child ONE file, which is the only arrangement in
 * which a preload's `setDefaultTimeout` holds for the whole run. Measured on
 * bun 1.3.11: it reaches the first test file a run loads and no other. #740
 * removed `--timeout 20000` from the workspace `test` scripts on the strength
 * of this file, so the 182-file engine suite ran at bun's 5 s default for 181
 * of them — with `__telarTestCeilingMs` reporting 20 000 in every one, which is
 * why a preload's self-report is corroboration and never proof.
 *
 * BOTH FIXTURES SLEEP THE SAME. Bun's order over two paths is not something to
 * depend on, and a pair where only one sleeps would pass whenever the sleeper
 * happened to load first — green exactly when the run is safe, silent when it
 * is not.
 */
test("a preload's ceiling stops at the first file — which is why the flag is back on the test scripts", () => {
  // 120 ms is a number only the preload can produce, and 400 ms is comfortably
  // under bun's own 5 s: the death is the file the preload reached, and the
  // survivor is the one it did not.
  const { output } = runFromRepoRoot([fixture(sleeps(400)), fixture(sleeps(400))], { ceiling: "120" });
  expect(output).toContain("timed out after 120ms");
  // If this ever reads "0 pass, 2 fail", bun has started applying a preload's
  // ceiling to every file and the --timeout on each workspace's `test` script
  // may be retired — see scripts/test-ceiling.mjs and `test-ceiling-is-registered`.
  expect(tally(output)).toBe("1 pass, 1 fail");
}, 60_000);

test("an explicit --timeout reaches EVERY file, which is what the workspace test scripts rely on", () => {
  // The same pair, the same 120 ms, asked for the way a test script asks for
  // it. Both must die: a flag that only reached the first file would leave the
  // second one passing, exactly as the preload does above.
  const { output, status } = runFromRepoRoot([fixture(sleeps(400)), fixture(sleeps(400))], { flag: "120" });
  expect(output).toContain("timed out after 120ms");
  expect(tally(output)).toBe("0 pass, 2 fail");
  expect(status).not.toBe(0);
}, 60_000);

/**
 * AND THE SUITE CI ACTUALLY RUNS CARRIES ONE. The behaviour above is about
 * `--timeout` in general; this is about the engine's own script having it, read
 * off package.json rather than typed here — a number written twice can agree
 * with itself while disagreeing with what CI runs. `test-ceiling-is-registered`
 * holds the same line for every other workspace.
 */
test("this suite's own `test` script carries the ceiling, not just the preload", async () => {
  const { TEST_CEILING_MS, timeoutFlagIn } = await import("../../../scripts/test-ceiling.mjs");
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "apps/engine/package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(timeoutFlagIn(manifest.scripts.test ?? "")).toBe(TEST_CEILING_MS);
});

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

test("the path arguments are read off a command line without a table of which flags take a value", async () => {
  const { pathArgumentsIn } = await import("../../../scripts/test-ceiling.mjs");
  const samples: Array<{ reads: string[]; why: string; line: string }> = [
    { reads: ["one.test.ts"], why: "the single-file run the preload can cover", line: "bun test one.test.ts" },
    { reads: ["a.test.ts", "b.test.ts"], why: "two files, which it cannot", line: "bun test a.test.ts b.test.ts" },
    { reads: [], why: "a bare sweep of the whole workspace", line: "bun test" },
    { reads: ["THE", "STORE", "PASSES", "one.test.ts"], why: "a filter's value is left in — the filesystem drops it, not a flag table", line: "bun test -t THE STORE PASSES one.test.ts" },
    { reads: ["20000", "one.test.ts"], why: "a flag's number survives here too, and is dropped by the same stat", line: "bun test --timeout 20000 one.test.ts" },
    { reads: ["apps/engine/test"], why: "a directory reads as one argument, and is not a file", line: "bun test apps/engine/test" },
  ];
  const wrong = samples.filter((sample) => JSON.stringify(pathArgumentsIn(sample.line)) !== JSON.stringify(sample.reads));
  expect(wrong.map((sample) => `${sample.why}: ${sample.line}`)).toEqual([]);
});
