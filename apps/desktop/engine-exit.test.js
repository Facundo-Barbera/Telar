const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const { mainSource } = require("./main-source");

const engineSource = (...parts) => fs.readFileSync(path.join(__dirname, "..", "engine", "src", ...parts), "utf8");
const main = mainSource();

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
    expect(Number(declared)).toBeGreaterThan(2);
  });
});

describe("each side uses it for the case it was minted for", () => {
  test("the engine exits with it on a lock conflict and rethrows everything else", () => {
    const entry = engineSource("main.ts");
    expect(entry).toMatch(/error\.code !== "conflict"\) throw error;/);
    expect(entry).toMatch(/process\.exit\(ENGINE_EXIT_LOCK_HELD\)/);

    expect(entry.match(/ENGINE_EXIT_LOCK_HELD/g)).toHaveLength(2);
  });

  test("the shell branches on it before the blanket quit", () => {
    expect(main).toMatch(/code === ENGINE_EXIT_LOCK_HELD/);

    expect(main).toMatch(/engineChild\.on\("exit"/);
  });
});

describe("no engine exit is silent any more", () => {
  test("the engine's exit is written to the shell log rather than the console", () => {
    expect(main).toMatch(/logShell\("error", `engine exited \(code=\$\{code\} signal=\$\{signal\}\)`\)/);
    expect(main).not.toMatch(/console\.error\(`\[telar-desktop\] engine exited/);
  });

  test("a failure before the first paint puts a dialog up, and only before it", () => {
    expect(main).toMatch(/function reportStartupFailure\(title, detail\) \{\n\s*if \(mainWindowShown \|\| startupFailureReported\) return;/);

    expect(main.match(/reportStartupFailure\(\n/g)).toHaveLength(2);
    expect(main).toMatch(/mainWindowShown = true;/);
  });
});
