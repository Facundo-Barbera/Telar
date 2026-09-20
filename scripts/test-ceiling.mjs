/**
 * THE PER-TEST CEILING, SET WHERE EVERY INVOCATION READS IT (#740).
 *
 * The ceiling used to live only on each workspace's `test` script, as
 * `--timeout 20000`. That covers `bun run test:engine` — what CI types — and
 * silently does not cover `bun test apps/engine/test/one.test.ts`, which is what
 * a person types. Bun's own 5 s default applies there instead, and nothing said
 * so: same file, same tree, same machine, one passing and one timing out
 * seconds apart. Four engine failures were relayed to four workers as machine
 * contention on the strength of durations — 5007, 10007, 5107, 5040 ms — that
 * are not a machine running late. They are a default ceiling, exactly.
 *
 * IT CANNOT MOVE TO bunfig.toml's `[test]` TABLE, and this file is not that idea
 * again: `timeout` is not a key there, bun ignores keys it does not recognise
 * WITHOUT A WORD, and #414 shipped precisely that — the engine suite then ran on
 * 5 s for every day it was believed fixed, which is why #266 and #458 kept
 * collecting engine timeouts afterwards. apps/engine/bunfig.toml carries that
 * history where someone would next be tempted.
 *
 * WHAT DOES WORK is `setDefaultTimeout` from bun:test, called from a preload —
 * and `preload` IS a key bunfig reads, out of whichever directory bun was
 * invoked in. So the ceiling travels with the run rather than with the command
 * line, and the invocation that used to be stricter than CI is now the same.
 *
 * AN EXPLICIT `--timeout` IS HONOURED, AND THAT IS NOT DECORATION. Measured on
 * bun 1.3.11: `setDefaultTimeout` called from a preload overrides the flag in
 * BOTH directions, because the preload runs after bun has parsed argv and is
 * simply the last writer. Setting it unconditionally would therefore have left
 * `bun test --timeout 60000 one.test.ts` silently running at 20 s — a knob that
 * reads as configured and does nothing, which is #740's own defect relocated one
 * layer up, and worse for having this file as evidence that timeouts here are
 * handled. So the flag is read back off the operating system (bun strips it from
 * `Bun.argv` — probed) and deferred to exactly, high or low: what a person typed
 * is what runs. `TELAR_TEST_TIMEOUT_MS` does the same for a run that cannot pass
 * a flag, and a test's own third-argument ceiling beats both — this sets a
 * DEFAULT, not a cap, so `test(name, fn, 60_000)` keeps meaning what it says.
 *
 * NONE OF THAT IS ARGUED IN A COMMENT ALONE. apps/engine/test/test-ceiling.test.ts
 * spawns `bun test` four ways and asserts what the child REPORTED — including the
 * case this paragraph exists to prevent, a higher explicit value surviving. A
 * scan that cannot fail demonstrates nothing (#721), and a guard keyed on a
 * string both the passing and the failing state can emit is worse than none
 * (#772, where a "prove it ran" grep matched the skipped block's own name).
 *
 * WHY 20 s: the engine suite runs a real daemon, a worker and child processes
 * per test. The `eventually`/`until` helpers hold a 15 s wall-clock bound
 * underneath it, so a wait can outlast a loaded runner without outlasting the
 * ceiling; `test-wait-fits-its-ceiling` in scripts/source-invariants.mjs keeps
 * that pairing the right way round, and `test-ceiling-is-registered` keeps this
 * file registered everywhere tests are run from.
 */
import { setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** The ceiling CI runs with — and now the one every other invocation gets too. */
export const TEST_CEILING_MS = 20_000;

/**
 * An explicit `--timeout` in a command line, in either spelling bun accepts.
 * Exported so the samples that prove it reads what it claims live in a test
 * rather than in a comment.
 */
export function timeoutFlagIn(commandLine) {
  const match = /(?:^|\s)--timeout(?:=|\s+)([0-9]+)(?=\s|$)/.exec(commandLine);
  return match ? Number(match[1]) : null;
}

/**
 * THIS PROCESS'S OWN COMMAND LINE, FROM THE OPERATING SYSTEM. Bun strips
 * `--timeout` out of `Bun.argv` and `process.argv` before a preload can see it
 * (probed on 1.3.11: both hold only the interpreter and the test file), so the
 * flag has to be read where it still exists. `/proc/self/cmdline` is exact and
 * is the path CI takes; `ps -ww` is the BSD equivalent, with `-ww` because BSD
 * `ps` otherwise truncates a long argument list.
 *
 * `null` means neither worked, which is reported rather than guessed at: the
 * alternative is deferring to a flag that might not be there, or clamping one
 * that is.
 */
export function ownCommandLine() {
  try {
    const cmdline = readFileSync("/proc/self/cmdline", "utf8");
    if (cmdline !== "") return cmdline.split("\0").filter(Boolean).join(" ");
  } catch {
    // Not Linux; fall through to ps.
  }
  try {
    const ps = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(process.pid)], { encoding: "utf8" });
    const line = typeof ps.stdout === "string" ? ps.stdout.trim() : "";
    if (ps.status === 0 && line !== "") return line;
  } catch {
    // No ps either.
  }
  return null;
}

const commandLine = ownCommandLine();
const explicit = commandLine === null ? null : timeoutFlagIn(commandLine);
const requested = Number(process.env.TELAR_TEST_TIMEOUT_MS);
const fromEnv = Number.isFinite(requested) && requested > 0 ? requested : null;

let ceilingMs;
let ceilingSource;
if (explicit !== null) {
  // Bun has already applied it. Touching the default here would overwrite it.
  ceilingMs = explicit;
  ceilingSource = "flag";
} else if (fromEnv !== null) {
  setDefaultTimeout(fromEnv);
  ceilingMs = fromEnv;
  ceilingSource = "env";
} else {
  setDefaultTimeout(TEST_CEILING_MS);
  ceilingMs = TEST_CEILING_MS;
  ceilingSource = commandLine === null ? "default-unchecked" : "default";
}

/**
 * THE ONE CASE THAT CANNOT BE SILENT. If the command line was unreadable, an
 * explicit `--timeout` may have just been overwritten — the exact thing the
 * paragraph above refuses to ship. It cannot be detected, so it is said out
 * loud, once, on the only platform that could produce it.
 */
if (ceilingSource === "default-unchecked") {
  console.error(
    `[test-ceiling] could not read this process's own command line, so an explicit --timeout could not be honoured; ` +
      `applied ${TEST_CEILING_MS}ms. Use TELAR_TEST_TIMEOUT_MS to set the ceiling on this machine.`,
  );
}

/**
 * SO A TEST CAN PROVE THIS RAN, rather than a reader trusting a preload list.
 * A registration that quietly stops happening is the #414 failure itself, and
 * what #414 lacked was any assertion that the mechanism applied at all. These
 * are this file's own account of what it did, so they are corroboration and not
 * evidence: what the ceiling actually IS gets proved in test-ceiling.test.ts by
 * running a test to death against it.
 */
globalThis.__telarTestCeilingMs = ceilingMs;
globalThis.__telarTestCeilingSource = ceilingSource;
