/**
 * THE ONE PLACE A TEST WAITS FOR SOMETHING — #760's option B.
 *
 * Twenty-six engine test files had grown their own `eventually` or `until`, no
 * two quite alike: budgets from 4 s to 15 s, poll intervals from 15 ms to 25 ms,
 * some throwing the last assertion error and some returning a bare `false` that
 * the caller had to remember to assert on. None of that variation was ever
 * decided; it is what copying a helper into the next file looks like after a
 * year. The cost is not the duplication, it is that the 15 s wall-clock bound
 * `bunfig.toml` and `scripts/test-ceiling.mjs` both promise is only true of
 * whichever copies happen to carry it.
 *
 * THE BOUND IS A WALL CLOCK, NOT A RETRY COUNT, and that is the one piece of
 * this worth arguing. A "60 × 5 ms" window is ~300 ms only when every check is
 * instant; give it a check that makes an HTTP round trip on a loaded runner and
 * it is minutes, or it is one poll. The deadline below is read from the clock,
 * so a slow machine gets more polls rather than a shorter wait.
 *
 * WHY 15 s UNDER A 20 s CEILING: the test dies at the ceiling, and a test that
 * dies mid-wait reports only that it timed out — the assertion that never
 * settled, which is the thing you actually need, goes in the bin. Leaving 5 s
 * between the two means the wait always gets to say what it was waiting for.
 * `test-wait-fits-its-ceiling` in scripts/source-invariants.mjs keeps that
 * pairing the right way round for every file that imports this one, so lowering
 * a test's own third-argument ceiling under this budget is caught here rather
 * than months later in a misread timeout.
 */

/**
 * The wall-clock budget every wait in this suite gets unless it asks for
 * another. Read by scripts/source-invariants.mjs, which compares it against the
 * per-test ceilings of every file importing this module — keep it a plain
 * literal it can parse.
 */
export const WAIT_BUDGET_MS = 15_000;

/** How often a wait re-checks. Small enough not to be the latency being measured. */
export const WAIT_POLL_MS = 20;

export type WaitOptions = {
  /** Wall-clock bound. Must stay under the per-test ceiling of the file using it. */
  budgetMs?: number;
  /** Gap between checks. */
  pollMs?: number;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Re-run an assertion until it stops throwing.
 *
 * Settles on the first pass, and on failure throws the LAST error the assertion
 * produced rather than a timeout of its own — the expected/received diff is the
 * whole reason to have waited.
 */
export async function eventually(
  assertion: () => void | Promise<void>,
  { budgetMs = WAIT_BUDGET_MS, pollMs = WAIT_POLL_MS }: WaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let last: unknown;
  let polls = 0;
  do {
    polls += 1;
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
      await sleep(pollMs);
    }
  } while (Date.now() < deadline);
  if (last instanceof Error) {
    last.message = `${last.message}\n  (still failing after ${polls} polls over ${budgetMs}ms)`;
  }
  throw last;
}

/**
 * Poll a predicate until it holds, and throw a sentence naming what never
 * happened when it does not.
 *
 * `what` is not decoration: a bare `until(() => flag)` that times out reports a
 * line number, and the reader is then reconstructing from the source what the
 * flag meant. Say it here and the failure says it too.
 */
export async function until(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  { budgetMs = WAIT_BUDGET_MS, pollMs = WAIT_POLL_MS }: WaitOptions = {},
): Promise<void> {
  const started = Date.now();
  const deadline = started + budgetMs;
  let polls = 0;
  do {
    polls += 1;
    if (await predicate()) return;
    await sleep(pollMs);
  } while (Date.now() < deadline);
  if (await predicate()) return;
  throw new Error(`waited ${Date.now() - started}ms over ${polls} polls for ${what}, and it never happened`);
}
