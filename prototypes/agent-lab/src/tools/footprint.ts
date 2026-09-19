/**
 * WHAT THE VARIANT COSTS ON DISK, AND WHAT IT PULLED IN.
 *
 * The issue asks for `du` of node_modules per variant and install time, because
 * "it is only one dependency" is a claim people make about packages with eighty
 * transitive ones. This prints the number rather than the impression.
 *
 * Run: `bun run footprint`
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { LAB_ROOT } from "../scenarios/support";

function bytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += bytes(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

function mb(value: number): string {
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

const modules = path.join(LAB_ROOT, "node_modules");
const top = readdirSync(modules, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));

let packages = 0;
const rows: Array<[string, number]> = [];
for (const entry of top) {
  const full = path.join(modules, entry.name);
  if (entry.name.startsWith("@")) {
    for (const scoped of readdirSync(full, { withFileTypes: true })) {
      if (!scoped.isDirectory()) continue;
      packages += 1;
      rows.push([`${entry.name}/${scoped.name}`, bytes(path.join(full, scoped.name))]);
    }
    continue;
  }
  packages += 1;
  rows.push([entry.name, bytes(full)]);
}

rows.sort(([, a], [, b]) => b - a);
const total = rows.reduce((sum, [, size]) => sum + size, 0);

const manifest = JSON.parse(readFileSync(path.join(LAB_ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

console.log(`prototypes/agent-lab node_modules: ${mb(total)} across ${packages} packages`);
console.log(`direct dependencies: ${Object.keys(manifest.dependencies ?? {}).join(", ")}`);
console.log(`dev dependencies: ${Object.keys(manifest.devDependencies ?? {}).join(", ")}`);
console.log("\nten largest:");
for (const [name, size] of rows.slice(0, 10)) console.log(`  ${mb(size).padStart(9)}  ${name}`);
console.log("\nInstall time is not measured here — time a clean `bun install` yourself:");
console.log("  rm -rf node_modules && time bun install");
