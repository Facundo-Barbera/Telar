import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStateError } from "../kernel";

export function engineRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.TELAR_HOME?.trim();
  if (!home) {
    throw new EngineStateError("invalid_request", "TELAR_HOME must be explicitly set for the engine");
  }
  if (!path.isAbsolute(home)) {
    throw new EngineStateError("invalid_request", "TELAR_HOME must be an absolute path for the engine");
  }
  const resolved = canonicalPath(home);
  for (const legacy of [".telar", ".telar-dev"]) {
    const legacyRoot = canonicalPath(path.join(os.homedir(), legacy));
    if (resolved === legacyRoot || resolved.startsWith(`${legacyRoot}${path.sep}`)) {
      throw new EngineStateError("invalid_request", "TELAR_HOME must not point at legacy Telar state");
    }
  }
  return path.join(resolved, "engine");
}

// The engine keeps a subtree because the packaged shell's TELAR_HOME is Electron's userData, which has files of its own.
const LEGACY_ROOT_NAME = "vnext";

/** Renames a `vnext/` store into place once, atomically; answers whether it moved one so the daemon can say so. */
export function migrateLegacyEngineRoot(engineRoot: string): boolean {
  const resolved = path.resolve(engineRoot);
  const legacy = path.join(path.dirname(resolved), LEGACY_ROOT_NAME);
  if (legacy === resolved) return false;
  if (fs.existsSync(resolved) || !fs.existsSync(legacy)) return false;
  fs.renameSync(legacy, resolved);
  return true;
}

function canonicalPath(input: string): string {
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
