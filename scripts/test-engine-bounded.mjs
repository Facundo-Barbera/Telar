#!/usr/bin/env bun
/**
 * A TEST RUN THAT CAN SAY IT HUNG — #807.
 *
 * THE FAILURE THIS EXISTS FOR. Five `bun test` processes from one worktree,
 * alive for 28 to 56 minutes at 60–70% of a core, and nothing anywhere could
 * say which of two completely different things had happened: a run that never
 * finished, or a run that was merely crawling. No output survived either, so
 * the incident presented as a list of pids.
 *
 * WHY AN EXIT CODE CANNOT ANSWER IT, and why the obvious wrapper is the same
 * bug wearing the fix's clothes: `timeout 900 bun test; echo $?` gives a
 * non-zero for a hang and a non-zero for an ordinary failing test. A check that
 * cannot tell those apart is a check that reports "the suite is broken" every
 * time one test goes red, and reports nothing different on the day the run
 * stops ending. #772 is this repository's own version of that mistake — a guard
 * keyed on a string a SKIPPED block prints too, satisfied exactly when the thing
 * it guarded against had happened.
 *
 * SO TWO INDEPENDENT SIGNALS, neither derived from the other:
 *
 *   1. THE END-OF-RUN TALLY WAS PRINTED. bun writes `N pass` and `N fail` once
 *      per run, at the end. A hang never reaches it; a failing suite always
 *      does. `test-ceiling.test.ts`'s own `tally` helper already depends on this
 *      and defends the choice against counting per-failure lines, which come out
 *      DOUBLED on the runner.
 *   2. THE PROCESS EXITED INSIDE A WALL-CLOCK BUDGET, measured here and never
 *      read off the child's exit code.
 *
 * Which gives distinguishable states rather than "zero and not-zero":
 *
 *   passed   tally, fail = 0, exited, and nothing left in its process group
 *   failed   tally, fail > 0, exited
 *   hung     NO tally, budget exceeded
 *   unknown  exited, but never counted anything
 *   leaked   tally, fail = 0, exited — and processes still in its group (#849)
 *
 * `unknown` IS NOT COSMETIC AND MUST NOT BE FOLDED INTO `passed`. A runner that
 * died before it could count — a load failure, a killed process, a crash in a
 * preload — exits without a tally, and a wrapper that read "no fails reported"
 * as success would go green exactly there.
 *
 * AND IT TEES, which is the cheapest half (#807 step 1). Every line the run
 * prints is timestamped into a file under the OS temp directory — NOT the repo,
 * which is a working tree somebody is using — so the next occurrence names its
 * own file and its own last line instead of presenting as five pids.
 *
 * THE GROUP, NOT THE CHILD. This spawns `bun run test`, which spawns `bun test`:
 * killing the child would leave the grandchild running, which is #807's orphan
 * exactly. The kill goes through `apps/engine/src/domains/terminal/platform.ts` — the seam
 * that already carries POSIX group-kill, Windows `taskkill /T /F`, and a
 * three-valued liveness in which `unanswerable` is never a synonym for `gone` —
 * rather than a second copy of it here.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { processGroupFor } from "../apps/engine/src/domains/terminal/platform.ts";

/**
 * HOW LONG A WHOLE RUN GETS. The engine suite takes about three minutes; the
 * runs that prompted #807 were alive for 28 to 56. Fifteen minutes is five
 * times the honest duration and well under the shortest incident, so a machine
 * under real load still finishes and a run that has stopped ending is caught
 * inside the hour rather than by somebody noticing a fan.
 */
const DEFAULT_BUDGET_MS = 15 * 60_000;

/** How long the group gets to unwind politely before the forceful pass. */
const STOP_GRACE_MS = 2_000;

/** A `ps` that hangs must not be the reason a bounded runner stops being bounded. */
const PS_CEILING_MS = 5_000;

/** Enough rows to name a leak; a runaway fork bomb is not worth printing in full. */
const MAX_GROUP_ROWS = 40;

/**
 * WHAT WAS ACTUALLY STILL IN THE GROUP — #849, and the gap #807's investigation
 * named under *Parentage*:
 *
 *   "The table records no `ppid`. If any two of the five were a
 *   `test-ceiling.test.ts` parent/child pair, that would be close to decisive,
 *   and it is exactly what was not captured. Whatever records the next
 *   occurrence should carry `ppid` and `pgid`."
 *
 * Until now this file could say that something was left behind and could stop
 * it; it could not say WHAT. "Something was left" is not actionable, and the
 * suite has reported it on two clean green runs, so the next occurrence should
 * arrive already naming a command line.
 *
 * `ps -Ao … ` AND FILTER HERE, NOT `ps -g <pgid>`. #849 suggests the latter and
 * it is wrong on the runner: on macOS BSD `ps`, `-g` selects by process group,
 * but on procps-ng — which is what `ubuntu-latest` has — `-g` selects by
 * SESSION id or effective group NAME. The same command would quietly answer a
 * different question on CI than on a Mac, and answer it without failing, which
 * is the shape of every instrument this repository has had to throw away. `-A`
 * and `-o` are POSIX and mean one thing everywhere; the pgid comparison is done
 * here where it can be read.
 *
 * READ-ONLY, AND BOUNDED. This inspects; the stopping is still `group.stop`.
 */
function inspectProcessGroup(pgid, phase) {
  if (process.platform === "win32") {
    return { phase, supported: false, reason: "POSIX `ps` only; Windows stops the tree through taskkill /T /F", rows: [] };
  }
  const ps = spawnSync("ps", ["-Ao", "pid=,ppid=,pgid=,etime=,command="], {
    encoding: "utf8",
    timeout: PS_CEILING_MS,
    killSignal: "SIGKILL",
  });
  if (ps.error || typeof ps.stdout !== "string") {
    return { phase, supported: true, reason: `ps failed: ${ps.error?.message ?? "no output"}`, rows: [] };
  }
  const rows = [];
  for (const line of ps.stdout.split("\n")) {
    // pid, ppid, pgid, etime, then the command line — which has spaces in it,
    // so only the first four fields are split off.
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    if (Number(match[3]) !== pgid) continue;
    // This process asked the question; it is not one of the survivors.
    if (Number(match[1]) === process.pid) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), etime: match[4], command: match[5] });
  }
  return { phase, supported: true, truncated: rows.length > MAX_GROUP_ROWS, rows: rows.slice(0, MAX_GROUP_ROWS) };
}

/**
 * WHAT THE CHILD COUNTED, read off the end-of-run tallies bun writes once.
 *
 * Deliberately the same instrument `test-ceiling.test.ts` settled on, and for
 * the reason recorded there: anything printed once per FAILURE is a quantity
 * whose meaning depends on where it is read — those came back exactly doubled
 * on the runner and single on a Mac. The end-of-run tallies did not.
 */
function tallyIn(output) {
  const pass = /^\s*(\d+) pass$/m.exec(output)?.[1];
  const fail = /^\s*(\d+) fail$/m.exec(output)?.[1];
  if (pass === undefined || fail === undefined) return undefined;
  return { pass: Number(pass), fail: Number(fail) };
}

function parseArgv(argv) {
  const options = { budgetMs: Number(process.env.TELAR_TEST_BUDGET_MS ?? "") || DEFAULT_BUDGET_MS, logDir: undefined, verdictOut: undefined, command: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      options.command = argv.slice(i + 1);
      break;
    }
    if (arg === "--budget-ms") options.budgetMs = Number(argv[++i]);
    else if (arg === "--log-dir") options.logDir = argv[++i];
    else if (arg === "--verdict-out") options.verdictOut = argv[++i];
    else throw new Error(`test-engine-bounded: unrecognised argument ${JSON.stringify(arg)}`);
  }
  if (!Number.isFinite(options.budgetMs) || options.budgetMs <= 0) {
    throw new Error(`test-engine-bounded: --budget-ms must be a positive number of milliseconds`);
  }
  return options;
}

/**
 * ONE PLACE THE COMMAND LIVES. The default delegates to the workspace's own
 * `test` script rather than spelling out `bun test --timeout 20000` here: a
 * ceiling written twice is a ceiling that can disagree with the one CI runs,
 * which is #414 and #792 both. `scripts/source-invariants.mjs` guards the flag
 * where it lives, and this wrapper never becomes a second opinion about it.
 */
const DEFAULT_COMMAND = ["bun", "run", "test"];

/** A file name that sorts by time and cannot collide between two concurrent runs. */
function logPathFor(directory) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `engine-${stamp}-${process.pid}.log`);
}

function spawnGroup(command, group) {
  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    // `bun run test` spawns `bun test`; only a group kill reaches the grandchild.
    detached: group.detached,
  });
  // Read once: `child.pid` clears on exit, and `kill(-undefined)` becomes `kill(0)`,
  // which signals this process's own group (the developer's shell).
  const childPid = child.pid;
  if (typeof childPid !== "number" || childPid <= 0) {
    throw new Error(`test-engine-bounded: ${command[0]} reported no pid, so its process group cannot be bounded`);
  }
  return { child, childPid };
}

/** Tees the child's output to the screen and a timestamped log, keeping the tail for the tally. */
function captureOutput(child, log) {
  const state = { lastLine: "", recent: "", pending: "" };
  const absorb = (chunk) => {
    const text = String(chunk);
    state.recent = (state.recent + text).slice(-64_000);
    process.stdout.write(text);
    state.pending += text;
    const lines = state.pending.split("\n");
    state.pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) state.lastLine = line;
      log.write(`${new Date().toISOString()} ${line}\n`);
    }
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  const flush = () => {
    if (!state.pending.trim()) return;
    state.lastLine = state.pending;
    log.write(`${new Date().toISOString()} ${state.pending}\n`);
  };
  return { state, flush };
}

function stopperFor(group, childPid) {
  return (force) => {
    try {
      group.stop(childPid, force);
    } catch (error) {
      // ESRCH: nothing left to stop. EPERM: a recycled pid that is not ours to signal.
      if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
    }
  };
}

/** Runs the child under the budget; resolves with its exit and whether the budget fired. */
async function awaitBounded(child, childPid, stop, budgetMs) {
  const run = { timedOut: false, groupInspection: null };
  const budget = setTimeout(() => {
    run.timedOut = true;
    // Inspected before the signal: after the kill there is nothing left to name.
    run.groupInspection = inspectProcessGroup(childPid, "budget");
    stop(false);
    setTimeout(() => stop(true), STOP_GRACE_MS).unref?.();
  }, budgetMs);
  const relay = () => stop(true);
  process.on("SIGINT", relay);
  process.on("SIGTERM", relay);
  run.exit = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: null, signal: null, error }));
    child.on("close", (code, signal) => resolve({ code, signal, error: undefined }));
  });
  clearTimeout(budget);
  process.off("SIGINT", relay);
  process.off("SIGTERM", relay);
  return run;
}

/**
 * A runner exiting is not evidence its children did (#807, #849). Asked at once, with
 * no grace: a leaked CLI dies ~100 ms after the runner, and a grace would hide it.
 * Only ESRCH means gone; EPERM and Windows' `unanswerable` are never `gone`.
 */
async function reapGroup(group, childPid, stop, run) {
  let reapedSurvivors = false;
  if (group.liveness(childPid) === "alive") {
    reapedSurvivors = true;
    run.groupInspection = inspectProcessGroup(childPid, "survivors");
    stop(true);
  }
  // Polled: a process killed a moment ago still answers until it is reaped.
  let groupLiveness = "alive";
  for (let waited = 0; waited < 2_000; waited += 50) {
    groupLiveness = group.liveness(childPid);
    if (groupLiveness !== "alive") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { reapedSurvivors, groupLiveness };
}

/**
 * `exited` is this process's wall clock, `tally` the child's own count; neither derives
 * from the other. A green run that left a named survivor (or could not look) is `leaked`,
 * not `passed`; a failing run stays `failed`.
 */
function outcomeOf({ timedOut, tally, reapedSurvivors, groupInspection }) {
  const leaked =
    reapedSurvivors && groupInspection?.phase === "survivors" && (groupInspection.rows.length > 0 || !groupInspection.supported || Boolean(groupInspection.reason));
  if (timedOut) return "hung";
  if (tally === undefined) return "unknown";
  if (tally.fail > 0) return "failed";
  return leaked ? "leaked" : "passed";
}

function printInspection({ phase, supported, reason, rows, truncated }) {
  const what = phase === "budget" ? "holding the run open at its budget" : "still in the group after a clean exit";
  if (!supported || reason) {
    process.stdout.write(`[test-engine-bounded] could not enumerate what was ${what}: ${reason}\n`);
  } else if (rows.length === 0) {
    process.stdout.write(`[test-engine-bounded] nothing was ${what} by the time ps ran — it had already exited\n`);
  } else {
    process.stdout.write(`[test-engine-bounded] ${rows.length}${truncated ? `+ (capped at ${MAX_GROUP_ROWS})` : ""} process(es) ${what}:\n`);
    for (const row of rows) {
      process.stdout.write(`[test-engine-bounded]   pid=${row.pid} ppid=${row.ppid} pgid=${row.pgid} etime=${row.etime} ${row.command}\n`);
    }
  }
}

function printVerdict(verdict, tally, exit) {
  const { outcome, exited, budgetMs, elapsedMs, groupLiveness } = verdict;
  const counted = tally === undefined ? "no end-of-run tally" : `${tally.pass} pass, ${tally.fail} fail`;
  process.stdout.write(
    `[test-engine-bounded] ${outcome} — ${counted}; ` +
      `${exited ? `exited ${exit.signal ? `on ${exit.signal}` : String(exit.code)}` : `killed at the ${budgetMs}ms budget`} ` +
      `after ${(elapsedMs / 1000).toFixed(1)}s; process group ${groupLiveness}\n`,
  );
  if (outcome !== "passed") process.stdout.write(`[test-engine-bounded] last line: ${verdict.lastLine || "(nothing was printed)"}\n`);
  if (verdict.reapedSurvivors) process.stdout.write(`[test-engine-bounded] the run left processes in its group after exiting; they were stopped\n`);
  if (outcome === "leaked") {
    process.stdout.write(
      `[test-engine-bounded] LEAKED: every test passed, but a test spawned something it did not stop. The rows below name it; ` +
        `find the test that starts that command and kill it in its own teardown (#849)\n`,
    );
  }
  if (verdict.groupInspection) printInspection(verdict.groupInspection);
  process.stdout.write(`[test-engine-bounded] log: ${verdict.logPath}\n`);
}

async function main() {
  const options = parseArgv(process.argv.slice(2));
  const command = options.command?.length ? options.command : DEFAULT_COMMAND;
  const logPath = logPathFor(options.logDir ?? path.join(os.tmpdir(), "telar-engine-tests"));
  const log = fs.createWriteStream(logPath, { flags: "a" });

  // Said before the run: a run that never ends never reaches its summary.
  process.stdout.write(`[test-engine-bounded] ${command.join(" ")} in ${process.cwd()}\n`);
  process.stdout.write(`[test-engine-bounded] log: ${logPath}\n`);
  log.write(`# ${new Date().toISOString()} ${command.join(" ")} in ${process.cwd()} (budget ${options.budgetMs}ms)\n`);

  const group = processGroupFor(process.platform, (pid, signal) => process.kill(pid, signal));
  const { child, childPid } = spawnGroup(command, group);
  const output = captureOutput(child, log);
  const startedAt = Date.now();
  const stop = stopperFor(group, childPid);
  const run = await awaitBounded(child, childPid, stop, options.budgetMs);
  output.flush();
  const { reapedSurvivors, groupLiveness } = await reapGroup(group, childPid, stop, run);

  const tally = tallyIn(output.state.recent);
  const { exit, timedOut, groupInspection } = run;
  const outcome = outcomeOf({ timedOut, tally, reapedSurvivors, groupInspection });
  const verdict = {
    outcome,
    exited: !timedOut,
    timedOut,
    elapsedMs: Date.now() - startedAt,
    budgetMs: options.budgetMs,
    exitCode: exit.code,
    exitSignal: exit.signal,
    pass: tally?.pass ?? null,
    fail: tally?.fail ?? null,
    groupLiveness,
    reapedSurvivors,
    groupInspection,
    childPid,
    logPath,
    lastLine: output.state.lastLine.trim(),
    command,
    ...(exit.error ? { spawnError: exit.error.message } : {}),
  };

  log.write(`# ${new Date().toISOString()} ${JSON.stringify(verdict)}\n`);
  await new Promise((resolve) => log.end(resolve));
  if (options.verdictOut) fs.writeFileSync(options.verdictOut, `${JSON.stringify(verdict, null, 2)}\n`);
  printVerdict(verdict, tally, exit);

  // One exit code per outcome; `scripts/engine-shard.mjs` passes 2, 3 and 4 through.
  process.exit({ passed: 0, failed: 1, hung: 2, unknown: 3, leaked: 4 }[outcome]);
}

await main();
