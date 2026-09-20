/**
 * REMOVING A TEMP PROFILE CHROMIUM HAS ONLY JUST LET GO OF (#789).
 *
 * Every `*.electron-test.js` in this directory ends by deleting the temporary
 * `userData` it ran against. `manager.destroy()` and `window.destroy()` return
 * before Chromium's network and storage children have finished flushing into
 * that directory, so a bare
 *
 *     fs.rmSync(dir, { recursive: true, force: true })
 *
 * races them: the walk lists a directory, a child writes one more journal file
 * into it, and `rmdir` throws `ENOTEMPTY`. `force` does not cover that — it
 * suppresses `ENOENT` and nothing else.
 *
 * THAT IS WHAT RUN `35494949650` WAS. `browser-persistence` printed
 * `BROWSER_PERSISTENCE_OK` — every assertion the file exists for had already
 * passed — and then threw out of its `finally` at `:400`, so the job reported a
 * persistence failure that had nothing to do with persistence. Seven files here
 * carried the identical line; `browser-persistence` drew the short straw first
 * because it is the one that opens two managers and restarts across them, so it
 * leaves the most for those children to finish writing.
 *
 * SO: RETRY, BOUNDED, AND SAY SO WHEN THE BUDGET RUNS OUT. This is not a
 * swallow. A temp profile still being written to two seconds after every
 * process that owned it was destroyed is a real fact about the tier and stays
 * red — but it is named as teardown in the message, so it can never again be
 * read as the subject of the test having failed.
 *
 * THE RETRY LOOP IS OURS RATHER THAN `rmSync`'s `maxRetries`, and that was
 * measured rather than preferred. These files run under ELECTRON's Node, but
 * this module is also unit-tested under BUN, and the two disagree about the
 * same directory: on a parent with no write bit, Node's recursive rm reports
 * `ENOTEMPTY` (which it retries) and Bun's reports `EACCES` (which it does
 * not). Delegating the budget to the runtime would mean the helper retried in
 * one place and gave up instantly in the other, and the unit test would be
 * measuring something the real caller never does.
 *
 * The negative direction — that this can still go red at all — is measured in
 * `electron-test-teardown.test.js`, because a cleanup step that always succeeds
 * is the same bug as a test nobody runs.
 */
const fs = require("node:fs");

const DEFAULT_ATTEMPTS = 20;
const DEFAULT_DELAY_MS = 100;

/**
 * Delete a test's temp `userData`, giving Chromium's stragglers a bounded
 * chance to finish first.
 *
 * `rm` and `wait` are ports so the unit test can drive the retry path without
 * a real Chromium to race; the defaults are the real filesystem and a real
 * timer. Resolves with the attempt count and the milliseconds spent, so a
 * caller that cares can print how close it came.
 */
async function removeUserData(
  dir,
  {
    attempts = DEFAULT_ATTEMPTS,
    delayMs = DEFAULT_DELAY_MS,
    rm = (target) => fs.rmSync(target, { recursive: true, force: true }),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const started = Date.now();
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rm(dir);
      return { attempts: attempt, waitedMs: Date.now() - started };
    } catch (error) {
      last = error;
      // eslint-disable-next-line no-await-in-loop
      if (attempt < attempts) await wait(delayMs);
    }
  }
  throw new Error(
    `TEARDOWN: the temp profile ${dir} was still not removable after ${attempts} attempts over ${Date.now() - started} ms ` +
      `(${last && last.code} from ${last && last.syscall}) — something was still writing into it after every process that ` +
      `owned it was destroyed. This is cleanup, not the behaviour under test.`,
    { cause: last },
  );
}

module.exports = { removeUserData, DEFAULT_ATTEMPTS, DEFAULT_DELAY_MS };
