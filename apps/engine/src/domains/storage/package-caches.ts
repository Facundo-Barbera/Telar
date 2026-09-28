import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type PackageManagerName = "bun" | "npm" | "pnpm" | "yarn";

export type PackageCache = {
  readonly name: PackageManagerName;
  readonly path: string;
};

export type PackageCacheDeps = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  stat?: (target: string) => fs.Stats;
};

type Resolved = Required<PackageCacheDeps>;

function resolveDeps(deps: PackageCacheDeps): Resolved {
  return {
    env: deps.env ?? process.env,
    homedir: deps.homedir ?? (() => os.homedir()),
    platform: deps.platform ?? process.platform,
    stat: deps.stat ?? ((target) => fs.statSync(target)),
  };
}

function bunCacheRoot(deps: Resolved): string {
  if (deps.env.BUN_INSTALL_CACHE_DIR) return deps.env.BUN_INSTALL_CACHE_DIR;
  if (deps.env.BUN_INSTALL) return path.join(deps.env.BUN_INSTALL, "install", "cache");
  return path.join(deps.homedir(), ".bun", "install", "cache");
}

function npmCacheRoot(deps: Resolved): string {
  return deps.env.npm_config_cache || path.join(deps.homedir(), ".npm", "_cacache");
}

function pnpmCacheRoot(deps: Resolved): string {
  if (deps.env.XDG_CACHE_HOME) return path.join(deps.env.XDG_CACHE_HOME, "pnpm");
  return deps.platform === "darwin" ? path.join(deps.homedir(), "Library", "pnpm") : path.join(deps.homedir(), ".cache", "pnpm");
}

function yarnCacheRoot(deps: Resolved): string {
  if (deps.env.YARN_CACHE_FOLDER) return deps.env.YARN_CACHE_FOLDER;
  return deps.platform === "darwin" ? path.join(deps.homedir(), "Library", "Caches", "Yarn") : path.join(deps.homedir(), ".cache", "yarn");
}

export function packageCaches(deps: PackageCacheDeps = {}): PackageCache[] {
  const resolved = resolveDeps(deps);
  return [
    { name: "bun", path: path.resolve(bunCacheRoot(resolved)) },
    { name: "npm", path: path.resolve(npmCacheRoot(resolved)) },
    { name: "pnpm", path: path.resolve(pnpmCacheRoot(resolved)) },
    { name: "yarn", path: path.resolve(yarnCacheRoot(resolved)) },
  ];
}

type DedupOutcome = "same-device" | "different-device" | "unreachable";

export type CacheDedupVerdict = PackageCache & { readonly dedup: DedupOutcome };

export function detectCacheDedup(worktreeRoot: string, deps: PackageCacheDeps = {}, caches?: readonly PackageCache[]): CacheDedupVerdict[] {
  const resolved = resolveDeps(deps);
  const targets = caches ?? packageCaches(resolved);

  let worktreeDev: number | undefined;
  try {
    worktreeDev = resolved.stat(worktreeRoot).dev;
  } catch {
    worktreeDev = undefined;
  }

  return targets.map((cache): CacheDedupVerdict => {
    if (worktreeDev === undefined) return { ...cache, dedup: "unreachable" };
    try {
      const cacheDev = resolved.stat(cache.path).dev;
      return { ...cache, dedup: cacheDev === worktreeDev ? "same-device" : "different-device" };
    } catch {
      return { ...cache, dedup: "unreachable" };
    }
  });
}
