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
});
