// WHAT THE ENGINE'S EXIT CODE MEANS IS A CONTRACT BETWEEN TWO LANGUAGES —
// issue #894.
//
// The engine is forked with `stdio: "inherit"`, so in a packaged app every line
// it prints goes to a stdout nobody can read. The exit code is the only thing
// that survives the process boundary, and the shell has to tell two cases apart
// with it: an engine that DIED, where quitting is right, and an engine that
// refused a lock a live daemon already holds, where quitting silently is the
// bug that was reported — Telar opening and closing again with nothing on
// screen.
//
// `ENGINE_EXIT_LOCK_HELD` is declared in apps/engine/src/state.ts and again in
// apps/desktop/main.js, because main.js is plain CommonJS that Electron loads
// before anything of the engine app exists and cannot import a TypeScript
// constant. Neither half can see the other's number, so a change to one is not
// a type error, not a lint error and not a failing route test — it is the shell
// quietly going back to quitting on a condition it was taught to explain.
//
// Same arrangement, and the same reasoning, as host-header.test.js.
//
// THE LOAD-BEARING ASSERTION IS THE COMPARISON, not a string either file could
// contain for another reason: both numbers are extracted and matched against
// each other, so the test fails if either declaration goes missing, if either
// stops being a number, or if the two disagree.

const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");

const engineSource = (...parts) => fs.readFileSync(path.join(__dirname, "..", "engine", "src", ...parts), "utf8");
const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

describe("the engine and the shell agree what a held lock exits with", () => {
  const declared = engineSource("state.ts").match(/export const ENGINE_EXIT_LOCK_HELD = (\d+);/)?.[1];
  const copied = main.match(/^const ENGINE_EXIT_LOCK_HELD = (\d+);$/m)?.[1];

  test("both files declare the number", () => {
    expect(declared).toBeDefined();
    expect(copied).toBeDefined();
  });

  test("and it is the same number", () => {
    expect(copied).toBe(declared);
  });

  test("it is not 1, which is what an engine that died exits with", () => {
    // The whole point is that the shell can distinguish the two. Node exits 1
    // on an uncaught throw and a shell reserves 2 for its own misuse, so
    // anything at or below 2 would be a code the failure state can also
    // produce — which is the shape of check this repository has shipped before
    // and had to go back and unpick.
    expect(Number(declared)).toBeGreaterThan(2);
  });
});

describe("each side uses it for the case it was minted for", () => {
  test("the engine exits with it on a lock conflict and rethrows everything else", () => {
    const entry = engineSource("main.ts");
    expect(entry).toMatch(/error\.code !== "conflict"\) throw error;/);
    expect(entry).toMatch(/process\.exit\(ENGINE_EXIT_LOCK_HELD\)/);
    // One exit path, so a second conflict branch cannot appear beside this one
    // and disagree with it.
    expect(entry.match(/ENGINE_EXIT_LOCK_HELD/g)).toHaveLength(2);
  });

  test("the shell branches on it before the blanket quit", () => {
    expect(main).toMatch(/code === ENGINE_EXIT_LOCK_HELD/);
    // And the branch is reachable: the quit it guards is the one in the engine
    // child's own `exit` handler, which is where the mute quit lived.
    expect(main).toMatch(/engineChild\.on\("exit"/);
  });
});

describe("no engine exit is silent any more", () => {
  /**
   * THE `console.error` WAS THE DEFECT, not an incidental detail. A packaged
   * mac app's stdout goes nowhere a person can reach, so the only record of
   * "the engine exited" was written to a stream that does not exist. `logShell`
   * appends to shell.log in userData, which is where update.log already lives
   * and for the same reason (see its comment in main.js).
   */
  test("the engine's exit is written to the shell log rather than the console", () => {
    expect(main).toMatch(/logShell\("error", `engine exited \(code=\$\{code\} signal=\$\{signal\}\)`\)/);
    expect(main).not.toMatch(/console\.error\(`\[telar-desktop\] engine exited/);
  });

  test("a failure before the first paint puts a dialog up, and only before it", () => {
    // `mainWindowShown` is the gate: after the first paint there is a window to
    // report in and a modal over a live cockpit is the wrong shape.
    expect(main).toMatch(/function reportStartupFailure\(title, detail\) \{\n\s*if \(mainWindowShown \|\| startupFailureReported\) return;/);
    // Both silent quits now go through it — the engine child's exit, and the
    // `waitForEngine` timeout that used to be caught, logged to nowhere and
    // quit on.
    expect(main.match(/reportStartupFailure\(\n/g)).toHaveLength(2);
    expect(main).toMatch(/mainWindowShown = true;/);
  });
});
