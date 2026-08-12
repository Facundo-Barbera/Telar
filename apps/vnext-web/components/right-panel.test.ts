// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("vNext right utility panel", () => {
  test("names only engine-backed facts and declares unsupported data honestly", () => {
    const source = fs.readFileSync(path.join(here, "right-panel.tsx"), "utf8");
    expect(source).toContain("Engine session");
    expect(source).toContain("Project");
    expect(source).toContain("Session");
    expect(source).toContain("no browser, Git, loom, account, or agent controls");
    expect(source).not.toContain("Open browser");
    expect(source).not.toContain("Git changes");
  });
});
