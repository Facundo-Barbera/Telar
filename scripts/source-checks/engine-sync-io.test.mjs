import { expect, test } from "bun:test";
import { syncNames } from "./engine-sync-io.mjs";

test("counts *Sync names in code, not in comments, imports or type positions", () => {
  const source = [
    'import { existsSync, spawnSync } from "node:fs";',
    "// readFileSync in a comment",
    "/* statSync in a block */",
    "if (fs.existsSync(dir)) spawnSync(git, args);",
    "const read = deps.read ?? fs.readFileSync;",
    "fs.realpathSync.native(dir);",
    "const url = 'http://x'; fs.rmSync(dir);",
    "let run: ReturnType<typeof spawnSync>;",
  ].join("\n");
  expect(syncNames(source)).toBe(5);
});
