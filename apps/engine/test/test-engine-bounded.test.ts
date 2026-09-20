/**
 * THE WRAPPER'S THREE VERDICTS, EACH DRIVEN BY A REAL RUN — #807.
 *
 * A CHECK THAT ONLY SEES GREEN HAS DEMONSTRATED NOTHING, which is the standard
 * every scan in scripts/source-invariants.mjs is held to and the one that
 * matters most here: the whole claim of `scripts/test-engine-bounded.mjs` is
 * that it can tell a HANG from a FAILING TEST, and both of those are non-zero
 * exits. Asserting only that a passing suite reports `passed` would leave the
 * distinction the file exists for completely untested.
 *
 * So every outcome is produced by a fixture that really is in that state:
 *
 *   hung     a module-scope `await` that never settles — measured on bun 1.3.11
 *            in #807 as the shape bun's per-test ceiling cannot reach, because
 *            that ceiling is an event-loop timer and nothing ever registers
 *   failed   one ordinary failing test
 *   passed   one ordinary passing test
 *   unknown  a command that exits cleanly having counted nothing — the state a
 *            wrapper reading "no fails reported" would call success, which is
 *            #772's defect exactly
 *
 * AND THE GRANDCHILD, NOT THE CHILD. The wrapper spawns `bun run <script>`,
 * which spawns `bun test`: a kill that only reached the child would leave
 * behind precisely the process #807 reports. The hung case asserts the pid of
 * the INNER process is gone — #771's lesson, that a test which only asserts the
 * child died passes against the unfixed path.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const WRAPPER = path.join(REPO_ROOT, "scripts/test-engine-bounded.mjs");

/**
 * Generous for a fixture of one test, and generous for the hung case too: the
 * inner process only has to start and write one line, which it does in tens of
 * milliseconds. Every test here declares 60 s, so the wrapper's own budget is
 * what ends a hang, not the runner's.
 */
const RUN_BUDGET_MS = 6_000;
/** The ceiling on the `Bun.spawnSync` below — #807's own rule, applied here. */
const WRAPPER_CEILING_MS = 40_000;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type Verdict = {
  outcome: "passed" | "failed" | "hung" | "unknown";
  exited: boolean;
  timedOut: boolean;
  pass: number | null;
  fail: number | null;
  exitCode: number | null;
  groupLiveness: "alive" | "gone" | "unanswerable";
  reapedSurvivors: boolean;
  groupInspection: {
    phase: "budget" | "survivors";
    supported: boolean;
    reason?: string;
    truncated?: boolean;
    rows: { pid: number; ppid: number; pgid: number; etime: string; command: string }[];
  } | null;
  childPid: number | null;
  logPath: string;
  lastLine: string;
};

/**
 * A throwaway workspace whose `run` script starts a `bun test` of its own, so
 * the wrapper's child and the suite it is really bounding are two different
 * processes — the arrangement the production script runs in.
 */
function workspace(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-bounded-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "fixture.test.ts"), body);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: { run: "bun test fixture.test.ts" } }));
  return root;
}

/** Runs the wrapper against a fixture workspace and returns the verdict it wrote. */
function wrapped(root: string, command: string[] = ["bun", "run", "run"]): { verdict: Verdict; status: number | null; output: string } {
  const verdictOut = path.join(root, "verdict.json");
  const run = Bun.spawnSync(["bun", WRAPPER, "--budget-ms", String(RUN_BUDGET_MS), "--verdict-out", verdictOut, "--log-dir", path.join(root, "logs"), "--", ...command], {
    cwd: root,
    // Bounded for #807's own reason: this spawns a run that is DELIBERATELY
    // hung, and a sync child wait is outside every ceiling above it.
    timeout: WRAPPER_CEILING_MS,
    killSignal: "SIGKILL",
  });
  const output = `${run.stdout?.toString() ?? ""}${run.stderr?.toString() ?? ""}`;
  expect(fs.existsSync(verdictOut)).toBe(true);
  return { verdict: JSON.parse(fs.readFileSync(verdictOut, "utf8")) as Verdict, status: run.exitCode, output };
}

/** Does this pid still exist? ESRCH is the only answer that means gone. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

test("a run that can never finish is reported HUNG, and its inner process is gone", () => {
  const root = workspace(`import fs from "node:fs";
import path from "node:path";
import { test, expect } from "bun:test";
// WRITTEN FIRST, SYNCHRONOUSLY, before anything can block: the pid is what the
// caller asserts about, and it must not depend on the fixture getting further.
fs.writeFileSync(path.join(import.meta.dir, "inner.pid"), String(process.pid));
await new Promise(() => {});
test("never registered, so no per-test ceiling ever applies", () => { expect(1).toBe(1); });
`);
  const { verdict, status } = wrapped(root);

  expect(verdict.outcome).toBe("hung");
  // THE TWO SIGNALS, SEPARATELY. Nothing was counted, and the budget was the
  // thing that ended it — a failing suite would satisfy neither.
  expect(verdict.pass).toBeNull();
  expect(verdict.fail).toBeNull();
  expect(verdict.exited).toBe(false);
  expect(verdict.timedOut).toBe(true);
  expect(status).toBe(2);

  const pidFile = path.join(root, "inner.pid");
  expect(fs.existsSync(pidFile)).toBe(true);
  const inner = Number(fs.readFileSync(pidFile, "utf8"));
  // IT REALLY WAS A GRANDCHILD: the process that hung is not the process the
  // wrapper spawned, so a kill that reached only the child would have left it.
  expect(inner).not.toBe(verdict.childPid);
  expect(gone(inner)).toBe(true);
  // And the platform seam's own answer about the whole group agrees.
  expect(verdict.groupLiveness).toBe("gone");
}, 60_000);

test("a run with one failing test is reported FAILED, with the child's own count", () => {
  const root = workspace(`import { test, expect } from "bun:test";
test("passes", () => { expect(1).toBe(1); });
test("fails", () => { expect(1).toBe(2); });
`);
  const { verdict, status } = wrapped(root);

  expect(verdict.outcome).toBe("failed");
  expect(verdict.pass).toBe(1);
  expect(verdict.fail).toBe(1);
  expect(verdict.exited).toBe(true);
  expect(verdict.timedOut).toBe(false);
  expect(status).toBe(1);
}, 60_000);

test("a run that passes is reported PASSED, and its log holds the last line it printed", () => {
  const root = workspace(`import { test, expect } from "bun:test";
test("passes", () => { expect(1).toBe(1); });
`);
  const { verdict, status } = wrapped(root);

  expect(verdict.outcome).toBe("passed");
  expect(verdict.pass).toBe(1);
  expect(verdict.fail).toBe(0);
  expect(status).toBe(0);

  /**
   * THE HALF THAT COSTS NOTHING AND WOULD HAVE TURNED #807 INTO A ONE-LINE
   * REPORT: the run's output is on disk, timestamped per line, outside the repo.
   */
  const lines = fs.readFileSync(verdict.logPath, "utf8").split("\n").filter(Boolean);
  const content = lines.filter((line) => !line.startsWith("#"));
  const undated = content.map((line) => line.replace(/^\S+ ?/, ""));
  // Every content line carries its own timestamp, so a run that stops can be
  // read for WHEN it stopped and not only where.
  const stamps = content.map((line) => line.split(" ")[0] ?? "");
  expect(stamps.filter((stamp) => Number.isNaN(Date.parse(stamp)))).toEqual([]);
  // The last line the run printed is recoverable from the file and from the
  // verdict, and they are the same line.
  expect(undated.at(-1)).toBe(verdict.lastLine);
  expect(verdict.lastLine.length).toBeGreaterThan(0);
}, 60_000);

test("a run that PASSES while leaving a process behind reaps it, and says so", () => {
  /**
   * #807's ORPHAN, AS REPORTED. The five processes in the incident were alive
   * after their tests had finished, which a timeout-only wrapper never sees: the
   * run exits, the tally is printed, the verdict is `passed`, and something is
   * still running. bun's test runner force-exits rather than draining the loop —
   * measured in the investigation against a listening server, a live interval
   * and a live child — so a leaked child outlives the runner by design.
   */
  const root = workspace(`import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "bun:test";
test("leaves a child running behind it, the way a leaked shell does", () => {
  const leaked = spawn("sleep", ["120"], { stdio: "ignore" });
  leaked.unref();
  fs.writeFileSync(path.join(import.meta.dir, "leaked.pid"), String(leaked.pid));
  expect(typeof leaked.pid).toBe("number");
});
`);
  const { verdict, status, output } = wrapped(root);

  // The run really did pass — this is not a failure being caught by the back door.
  expect(verdict.outcome).toBe("passed");
  expect(verdict.pass).toBe(1);
  expect(verdict.fail).toBe(0);
  expect(status).toBe(0);

  // AND THE LEAKED PROCESS IS GONE. Asserted FIRST, and about the pid rather
  // than about the wrapper's own account of itself: without the reap this is
  // the line that goes red, and it goes red by naming a process that is still
  // running — which is the whole of #807 in one assertion.
  const leaked = Number(fs.readFileSync(path.join(root, "leaked.pid"), "utf8"));
  expect(gone(leaked)).toBe(true);
  expect(verdict.groupLiveness).toBe("gone");
  expect(verdict.reapedSurvivors).toBe(true);

  /**
   * AND IT SAYS WHICH PROCESS — #849, the fixture that issue asks for by name:
   * "a suite that leaks a known pid, asserting that pid appears in the
   * verdict's rows".
   *
   * Before this, the wrapper reported the leak on two clean green runs of the
   * real suite and could not say what was in the group, so #807's *Parentage*
   * question — were any two of them a parent/child pair — stayed unanswerable.
   * The assertion is on the PID THE FIXTURE WROTE DOWN, not on the row count
   * and not on the presence of the word "sleep": a row count passes against a
   * `ps` that answered about the wrong group, which is exactly the failure
   * `-g <pgid>` would produce on procps-ng.
   */
  expect(verdict.groupInspection?.phase).toBe("survivors");
  expect(verdict.groupInspection?.supported).toBe(true);
  const rows = verdict.groupInspection?.rows ?? [];
  const found = rows.find((row) => row.pid === leaked);
  expect(found).toBeDefined();
  // The parentage #807 could not capture: the leaked process is in the run's
  // group and is descended from something, and both numbers are recorded.
  expect(found?.pgid).toBe(verdict.childPid);
  expect(found?.ppid).toBeGreaterThan(0);
  expect(found?.command).toContain("sleep");
  // The rows reach the log a human reads, not only the JSON a script reads.
  expect(output).toContain(`pid=${leaked} ppid=${found?.ppid}`);
}, 60_000);

test("a command that exits without counting anything is UNKNOWN, never passed", () => {
  /**
   * THE STATE A NAIVE WRAPPER CALLS SUCCESS. Exit code 0, no failures reported
   * — and no tally either, because nothing ran. #772's guard passed in exactly
   * this shape; folding it into `passed` would rebuild that bug here.
   */
  const root = workspace(`import { test, expect } from "bun:test";
test("passes", () => { expect(1).toBe(1); });
`);
  const { verdict, status } = wrapped(root, ["bun", "-e", "console.log('a runner that never counted')"]);

  expect(verdict.outcome).toBe("unknown");
  expect(verdict.exitCode).toBe(0);
  expect(verdict.exited).toBe(true);
  expect(verdict.pass).toBeNull();
  expect(status).toBe(3);
}, 60_000);
