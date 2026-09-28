const fs = require("node:fs");

const DEFAULT_ATTEMPTS = 20;
const DEFAULT_DELAY_MS = 100;

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

module.exports = { removeUserData };
