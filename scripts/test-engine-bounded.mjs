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
 * exactly. The kill goes through `apps/engine/src/run/platform.ts` — the seam
 * that already carries POSIX group-kill, Windows `taskkill /T /F`, and a
 * three-valued liveness in which `unanswerable` is never a synonym for `gone` —
 * rather than a second copy of it here.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { processGroupFor } from "../apps/engine/src/run/platform.ts";

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

async function main() {
  const options = parseArgv(process.argv.slice(2));
  const command = options.command?.length ? options.command : DEFAULT_COMMAND;
  const logPath = logPathFor(options.logDir ?? path.join(os.tmpdir(), "telar-engine-tests"));
  const log = fs.createWriteStream(logPath, { flags: "a" });

  // SAID BEFORE THE RUN, NOT AFTER IT. A run that never ends never reaches its
  // own summary, so the file's name has to be on screen while it is still going.
  process.stdout.write(`[test-engine-bounded] ${command.join(" ")} in ${process.cwd()}\n`);
  process.stdout.write(`[test-engine-bounded] log: ${logPath}\n`);
  log.write(`# ${new Date().toISOString()} ${command.join(" ")} in ${process.cwd()} (budget ${options.budgetMs}ms)\n`);

  const group = processGroupFor(process.platform, (pid, signal) => process.kill(pid, signal));
  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    // THE GRANDCHILD IS THE POINT: `bun run test` spawns `bun test`, and a kill
    // that only reached the child would strand exactly the process #807 is about.
    detached: group.detached,
  });

  /**
   * THE PID IS READ ONCE, HERE, AND NEVER OFF `child` AGAIN.
   *
   * `child.pid` IS CLEARED WHEN THE PROCESS EXITS, and every signal this file
   * sends is aimed at a GROUP — `kill(-pid, …)`. Read late, that is
   * `kill(-undefined)`, which coerces to `kill(0)`: the signal every process in
   * THIS process's own group, which on a developer's machine is their shell and
   * whatever else they are running. Measured while proving the hang case: the
   * kernel refused it with EPERM, which is the only reason it was noticed
   * rather than delivered.
   */
  const childPid = child.pid;
  if (typeof childPid !== "number" || childPid <= 0) {
    throw new Error(`test-engine-bounded: ${command[0]} reported no pid, so its process group cannot be bounded`);
  }

  /**
   * THE LAST LINE, KEPT SEPARATELY FROM THE LOG. It is what a hang has instead
   * of a tally, and reading it back off a file the run may still be writing is
   * a race this does not need to take.
   */
  let lastLine = "";
  /** Enough tail to hold the end-of-run tallies without holding a whole run. */
  let recent = "";
  let pending = "";

  const absorb = (chunk) => {
    const text = String(chunk);
    recent = (recent + text).slice(-64_000);
    process.stdout.write(text);
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) lastLine = line;
      log.write(`${new Date().toISOString()} ${line}\n`);
    }
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);

  const startedAt = Date.now();
  let timedOut = false;
  let groupLiveness = "alive";

  const stop = (force) => {
    try {
      group.stop(childPid, force);
    } catch (error) {
      // ESRCH is what "there was nothing left to stop" looks like, and it is
      // the outcome this wanted. EPERM is the other answer that must not
      // escalate: it means the group is not ours to signal, and the one way a
      // group we spawned becomes somebody else's is a recycled pid — where
      // trying harder is the worst available move.
      if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
    }
  };

  /**
   * WHAT WAS IN THE GROUP WHEN IT WAS STOPPED. Filled on both paths that stop
   * anything, and ALWAYS BEFORE THE SIGNAL: after the kill there is nothing
   * left to name, which is how #807 came to be reported as five bare pids.
   */
  let groupInspection = null;

  const budget = setTimeout(() => {
    timedOut = true;
    // A hang's group is as diagnostic as a survivor's — more so, because the
    // process holding it open is still there to be identified.
    groupInspection = inspectProcessGroup(childPid, "budget");
    stop(false);
    setTimeout(() => stop(true), STOP_GRACE_MS).unref?.();
  }, options.budgetMs);

  // A Ctrl-C on the wrapper must not leave the tree behind either.
  const relay = () => stop(true);
  process.on("SIGINT", relay);
  process.on("SIGTERM", relay);

  const exit = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: null, signal: null, error }));
    child.on("close", (code, signal) => resolve({ code, signal, error: undefined }));
  });
  clearTimeout(budget);
  process.off("SIGINT", relay);
  process.off("SIGTERM", relay);
  if (pending.trim()) {
    lastLine = pending;
    log.write(`${new Date().toISOString()} ${pending}\n`);
  }

  /**
   * THE GROUP IS OVER WHEN THE RUN IS — WHETHER OR NOT IT TIMED OUT.
   *
   * THIS IS #807's ACTUAL ORPHAN, and the case a timeout-only wrapper misses
   * entirely: the five processes in the incident were alive AFTER their tests
   * had finished. A runner exiting is not evidence that what it spawned exited,
   * so the group is ASKED, and anything still in it is stopped rather than
   * handed to the next person as a pid.
   *
   * ONLY ESRCH MEANS GONE, per `platform.ts` — EPERM is a group that exists and
   * is not ours, and Windows answers `unanswerable`, which is never a synonym
   * for `gone`. A run that leaves one of those says so in the verdict instead
   * of claiming a clean tree.
   */
  let reapedSurvivors = false;
  /**
   * ASKED AT ONCE, WITH NO GRACE — #849, and on purpose. The leak #849 found on
   * a Mac is a real Claude Code CLI that a live test never shut down; it dies
   * about 100 ms AFTER the runner does, because the runner's exit closes its
   * stdin. A grace of even a second would have filed that as "on its way out"
   * and gone green, which is the finding hidden. Anything still in the group
   * when the runner has exited is something a test did not stop; a test that
   * stopped and awaited its children leaves the group empty here, measured.
   */
  if (group.liveness(childPid) === "alive") {
    reapedSurvivors = true;
    // NAMED BEFORE IT IS STOPPED (#849). This is the whole of the change: the
    // run exits 0, prints a clean tally, and something is still in its group —
    // and until this line the only record of it was the sentence "the run left
    // processes in its group", which cannot be acted on. `ps` here turns that
    // into a pid, a ppid and a command line, which is enough to find the test
    // file that leaked it.
    groupInspection = inspectProcessGroup(childPid, "survivors");
    stop(true);
  }
  // POLLED, NOT SAMPLED ONCE. A process killed a moment ago is still answerable
  // until it is reaped, so a single read right after the signal reports `alive`
  // for a tree that is on its way out — measured on the suite's own run.
  for (let waited = 0; waited < 2_000; waited += 50) {
    groupLiveness = group.liveness(childPid);
    if (groupLiveness !== "alive") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const tally = tallyIn(recent);
  const elapsedMs = Date.now() - startedAt;

  /**
   * THE TWO SIGNALS, COMBINED IN ONE PLACE. `exited` is this process's own
   * wall-clock verdict and is never read off the child's exit code; `tally` is
   * the child's own count. Neither is derived from the other, which is what
   * makes `hung` distinguishable from `failed` at all.
   */
  const exited = !timedOut;
  /**
   * A GREEN RUN THAT LEFT SOMETHING RUNNING IS NOT A PASS — #849.
   *
   * Until this line the wrapper reaped survivors, printed a sentence, and exited
   * 0: the exact shape the issue reports, a clean tally and a clean exit code
   * with processes still alive behind them. A sentence in a 3000-test log is a
   * thing nobody reads, and an instrument that only reports is how the leak
   * survived two green runs unexamined. So it is its own outcome with its own
   * exit code, and CI goes red on it.
   *
   * ONLY WHEN SOMETHING WAS NAMED, OR COULD NOT BE LOOKED FOR. A group that was
   * alive at the check and empty by the time `ps` ran had a process on its way
   * out, not a leak, and a red that cannot say what leaked is worse than none.
   * An inspection that could not run at all fails CLOSED: survivors were seen
   * and nothing proved they were harmless.
   *
   * A FAILING RUN STAYS `failed`. The red test is the first thing to fix, and
   * the rows are printed below either way.
   */
  const leaked =
    reapedSurvivors && groupInspection?.phase === "survivors" && (groupInspection.rows.length > 0 || !groupInspection.supported || Boolean(groupInspection.reason));
  const outcome = !exited
    ? "hung"
    : tally === undefined
      ? "unknown"
      : tally.fail > 0
        ? "failed"
        : leaked
          ? "leaked"
          : "passed";
  const verdict = {
    outcome,
    exited,
    timedOut,
    elapsedMs,
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
    lastLine: lastLine.trim(),
    command,
    ...(exit.error ? { spawnError: exit.error.message } : {}),
  };

  log.write(`# ${new Date().toISOString()} ${JSON.stringify(verdict)}\n`);
  await new Promise((resolve) => log.end(resolve));
  if (options.verdictOut) fs.writeFileSync(options.verdictOut, `${JSON.stringify(verdict, null, 2)}\n`);

  const counted = tally === undefined ? "no end-of-run tally" : `${tally.pass} pass, ${tally.fail} fail`;
  process.stdout.write(
    `[test-engine-bounded] ${outcome} — ${counted}; ` +
      `${exited ? `exited ${exit.signal ? `on ${exit.signal}` : String(exit.code)}` : `killed at the ${options.budgetMs}ms budget`} ` +
      `after ${(elapsedMs / 1000).toFixed(1)}s; process group ${groupLiveness}\n`,
  );
  if (outcome !== "passed") process.stdout.write(`[test-engine-bounded] last line: ${verdict.lastLine || "(nothing was printed)"}\n`);
  // SAID OUT LOUD, because a run that passes while leaving processes behind is
  // exactly the shape #807 reports and the one nobody would otherwise look at.
  if (reapedSurvivors) process.stdout.write(`[test-engine-bounded] the run left processes in its group after exiting; they were stopped\n`);
  if (outcome === "leaked") {
    process.stdout.write(
      `[test-engine-bounded] LEAKED: every test passed, but a test spawned something it did not stop. The rows below name it; ` +
        `find the test that starts that command and kill it in its own teardown (#849)\n`,
    );
  }
  // THE ROWS, IN THE LOG AND ON SCREEN. Printed for both phases, because the
  // reader of a hung run wants the same table as the reader of a leaky one.
  // A supported inspection that found nothing says so rather than printing
  // nothing at all: absent output and an empty group are different facts, and
  // this repository has been bitten by them being written the same way.
  if (groupInspection) {
    const { phase, supported, reason, rows, truncated } = groupInspection;
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
  process.stdout.write(`[test-engine-bounded] log: ${logPath}\n`);

  /**
   * ONE EXIT CODE PER OUTCOME. A caller that only knows zero-from-not-zero
   * still gets the right answer; one that wants to tell a hang from a red test
   * — or a leak from either — no longer has to guess, which is the whole point
   * of the file. `scripts/engine-shard.mjs` passes 2, 3 and 4 through unchanged.
   */
  process.exit({ passed: 0, failed: 1, hung: 2, unknown: 3, leaked: 4 }[outcome]);
}

await main();
