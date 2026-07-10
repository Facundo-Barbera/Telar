import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolvePlaywrightMcpBin } from "../src/verifier";

const ENV_KEY = "TELAR_PLAYWRIGHT_MCP_BIN";
const originalEnv = process.env[ENV_KEY];

beforeEach(() => {
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
});

describe("resolvePlaywrightMcpBin", () => {
  test("explicit opt wins over everything", () => {
    process.env[ENV_KEY] = "/should/not/be/used";
    expect(resolvePlaywrightMcpBin("/x/y")).toBe("/x/y");
  });

  test("env var wins when no explicit opt is given", () => {
    process.env[ENV_KEY] = "/from/env/playwright-mcp";
    expect(resolvePlaywrightMcpBin()).toBe("/from/env/playwright-mcp");
  });

  test("default resolution finds a real, portable, installed binary", () => {
    const result = resolvePlaywrightMcpBin();
    const base = path.basename(result);

    // Proves real portable resolution happened here (a discovered, existing
    // file), not the bare PATH fallback, and not the old removed default.
    expect(fs.existsSync(result)).toBe(true);
    expect(["cli.js", "playwright-mcp"]).toContain(base);
    expect(result).not.toBe(
      "/Users/facundo/Projects/personal/telar/apps/web/node_modules/.bin/playwright-mcp",
    );
  });

  test("source contains no hardcoded personal path", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../src/verifier.ts"),
      "utf8",
    );
    expect(src).not.toContain("/Users/facundo");
  });

  // Regression: Turbopack's bundled Next.js dev server can leave
  // `import.meta.dirname` undefined/empty, which used to make the walk-up
  // loop call path.dirname(undefined) and throw
  // `The "path" argument must be of type string. Received undefined` —
  // exactly the panel-error a real loom hit driving the Critic Panel from the
  // dev server. `startDir` (3rd arg) simulates that by standing in for
  // `import.meta.dirname`; "" covers both the undefined and empty-string
  // shapes since the guard treats them identically.
  describe("robust to import.meta.dirname being undefined/empty", () => {
    test("empty startDir never throws and still returns a non-empty string", () => {
      expect(() => resolvePlaywrightMcpBin(undefined, "")).not.toThrow();
      const result = resolvePlaywrightMcpBin(undefined, "");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    // This is the actual Turbopack-dev-server scenario: import.meta.dirname
    // is unusable (simulated by ""), but the resolver falls back to walking
    // up from process.cwd() — which for a real `next dev`/`bun test` process
    // is a real, usable path — so the Critic Panel's playwright-mcp bin
    // still RESOLVES (not just "doesn't throw"). Run from packages/core, cwd
    // walk-up finds the workspace-hoisted @playwright/mcp install a couple
    // levels up, same as it would from apps/web when driven by the dev
    // server.
    test("falls back to process.cwd()'s walk-up and still finds a real binary when startDir is unusable", () => {
      const result = resolvePlaywrightMcpBin(undefined, "");
      expect(fs.existsSync(result) || result === "playwright-mcp").toBe(true);
      expect(fs.existsSync(result)).toBe(true); // this checkout has it installed, so it must actually resolve
    });

    test("explicit opt still wins even when startDir is empty", () => {
      expect(resolvePlaywrightMcpBin("/x/y", "")).toBe("/x/y");
    });

    test("env var still wins even when startDir is empty", () => {
      process.env[ENV_KEY] = "/from/env/playwright-mcp";
      expect(resolvePlaywrightMcpBin(undefined, "")).toBe("/from/env/playwright-mcp");
    });

    test("a real startDir still walks up and finds the installed cli.js (guard doesn't break the found-path case)", () => {
      const result = resolvePlaywrightMcpBin(undefined, import.meta.dirname);
      expect(fs.existsSync(result)).toBe(true);
      expect(["cli.js", "playwright-mcp"]).toContain(path.basename(result));
    });
  });
});
