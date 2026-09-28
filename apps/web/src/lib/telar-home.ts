import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Resolve existing symlinks while allowing a newly-created dedicated home. */
export function canonicalPath(input: string): string {
  const resolved = path.resolve(input);
  let existing = resolved;
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  let canonical = fs.realpathSync.native(existing);
  for (const segment of missing) canonical = path.join(canonical, segment);
  return canonical;
}

/** `~/.telar` and `~/.telar-dev` belong to the legacy product; never use them as TELAR_HOME. */
export function isLegacyTelarHome(canonicalHome: string): boolean {
  const userHome = canonicalPath(os.homedir());
  return path.dirname(canonicalHome) === userHome && [".telar", ".telar-dev"].includes(path.basename(canonicalHome));
}
