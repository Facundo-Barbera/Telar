import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Repo-relative paths under `dir` whose name matches `pattern`, skipping tests, node_modules and build output. */
export function filesUnder(dir, pattern, { tests = false } = {}) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(ROOT, current), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".next")) walk(rel);
      } else if (pattern.test(entry.name) && (tests || !/\.(test|electron-test)\./.test(entry.name))) {
        out.push(rel);
      }
    }
  };
  walk(dir);
  return out.sort();
}

export const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
