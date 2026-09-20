/**
 * WHETHER A PACKAGE MANAGER'S DOWNLOAD CACHE CAN BE CLONED INTO A WORKTREE — #633.
 *
 * WHY THIS EXISTS. A session's git worktree and the package manager's download
 * cache can land on different filesystems. When they do, `bun install` cannot
 * clone or hardlink an already-downloaded package into the worktree's
 * `node_modules` — it pays a full copy instead, per worktree. On the owner's own
 * machine that is 59 worktrees on an external volume against a cache that used
 * to sit on the internal disk. This module is the DETECTOR, not the fix: it
 * answers "can dedup happen between this worktree and this cache", and a caller
 * (the Storage report, worktree creation — neither of them this file) decides
 * what, if anything, to tell a person about the answer.
 *
 * THREE INSTRUMENTS LIE ABOUT THIS, and none of them is used here:
 *   - `du` walks a tree and sums size; it has no way to see that two files SHARE
 *     their blocks on disk, so a free clone and a paid copy read identically.
 *   - `stat.blocks` is the same fact one level down — blocks allocated to a
 *     file — and is blind to block sharing for the same reason.
 *   - a hardlink count would catch a `link`-backed dedup, but bun's macOS
 *     default backend is `clonefile`, an APFS copy-on-write clone that shares
 *     blocks WITHOUT raising `st_nlink`. A cloned file and an ordinary copy both
 *     report a link count of 1. This module is not measuring anything with any
 *     of the three — it never calls `du`, never reads `.blocks`, never counts a
 *     link — because there is no confidence level at which they tell the truth
 *     about this question.
 *
 * WHAT ACTUALLY DECIDES IT: whether the two paths are on the same filesystem,
 * i.e. whether `fs.statSync(path).dev` matches. Both `clonefile` (macOS) and a
 * hardlink (bun's fallback backend, and other package managers' own dedup) work
 * ONLY within one filesystem — that is not a heuristic standing in for dedup,
 * it is what dedup means. Comparing two `dev` numbers IS the question this
 * module answers, not a proxy for it.
 *
 * THE DELIBERATE CONTRADICTION WITH `volumes.ts`, and it is worth writing down
 * rather than leaving as a puzzle for the next reader. That module REJECTS
 * exactly this test — "does a path's device differ from another's" — for ITS
 * question, "is this project on an external drive", and it is right to reject
 * it there: APFS puts `/Users` on a Data volume firmlinked under a read-only
 * System volume, so an ordinary `~/code/anything` already has a different
 * `st_dev` than `/`, and a device walk against `/` would call every project on
 * the machine external. That failure is specific to comparing against the BOOT
 * device. This module never compares anything against `/` — it compares two
 * arbitrary, unrelated paths (a worktree root and a cache root) against EACH
 * OTHER, and "do these two specific paths share a filesystem" is exactly what a
 * `dev` comparison answers correctly. Same field, two different questions, two
 * opposite verdicts about trusting it — because the questions are different.
 *
 * WINDOWS. `fs.Stats.dev` there is the volume serial number, and an NTFS
 * hardlink (the backend package managers use for dedup on that platform) is
 * likewise restricted to a single volume. The comparison below is unchanged on
 * Windows; nothing in this module is macOS/APFS-specific except the default
 * cache-root locations themselves.
 *
 * INJECTED ENVIRONMENT AND HOME, for the same reason `volumes.ts` injects its
 * uuid reader: resolving a cache root reads `process.env` and `os.homedir()`,
 * and a test that mutated those globals would be fighting the test runner's own
 * process rather than exercising this module. An explicit `env` and `homedir`
 * make every override variable, and every platform default, a plain unit test.
 *
 * INJECTED `stat`, for the same reason `volumes.ts` injects one: a real `dev`
 * comparison needs two real filesystems, and a unit test has none of the pairs
 * this module needs to tell apart. A fake `stat` makes "same device",
 * "different device", and "this cache has never been created" three lines of
 * setup each, instead of two USB drives and a machine that has never run npm.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A package manager this module knows a cache location for. */
export type PackageManagerName = "bun" | "npm" | "pnpm" | "yarn";

/** One package manager's cache, resolved to an absolute path — not yet `stat`'d,
 *  not yet compared against anything. */
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

/**
 * bun's cache root. `BUN_INSTALL_CACHE_DIR` is the documented direct override;
 * failing that, an installation relocated via `BUN_INSTALL` carries its cache
 * with it at `install/cache` underneath; the plain default is what a bun
 * install with neither variable set uses on every platform.
 */
function bunCacheRoot(deps: Resolved): string {
  if (deps.env.BUN_INSTALL_CACHE_DIR) return deps.env.BUN_INSTALL_CACHE_DIR;
  if (deps.env.BUN_INSTALL) return path.join(deps.env.BUN_INSTALL, "install", "cache");
  return path.join(deps.homedir(), ".bun", "install", "cache");
}

/** npm's cache root — `npm_config_cache` is what npm itself sets/reads for a
 *  relocated cache (the `npm_config_` prefix is npm's own env-config surface,
 *  not one this module invents); the default is npm's own undocumented-by-name
 *  but stable `_cacache` layout under its config home. */
function npmCacheRoot(deps: Resolved): string {
  return deps.env.npm_config_cache || path.join(deps.homedir(), ".npm", "_cacache");
}

/** pnpm's cache root. pnpm follows the XDG base-directory spec where it applies
 *  and falls back to a platform-conventional location otherwise — pnpm does not
 *  honour `XDG_CACHE_HOME` on darwin by default, so the override here is the one
 *  pnpm itself documents as portable across platforms, and the darwin default
 *  matches pnpm's own choice of `~/Library/pnpm` rather than a Linux-style dot
 *  directory. */
function pnpmCacheRoot(deps: Resolved): string {
  if (deps.env.XDG_CACHE_HOME) return path.join(deps.env.XDG_CACHE_HOME, "pnpm");
  return deps.platform === "darwin" ? path.join(deps.homedir(), "Library", "pnpm") : path.join(deps.homedir(), ".cache", "pnpm");
}

/** yarn's cache root — `YARN_CACHE_FOLDER` is yarn's own documented override;
 *  the default mirrors yarn classic's platform-conventional cache directory. */
function yarnCacheRoot(deps: Resolved): string {
  if (deps.env.YARN_CACHE_FOLDER) return deps.env.YARN_CACHE_FOLDER;
  return deps.platform === "darwin" ? path.join(deps.homedir(), "Library", "Caches", "Yarn") : path.join(deps.homedir(), ".cache", "yarn");
}

/**
 * Every supported package manager's cache root, resolved from `deps` (real
 * environment and home directory by default; see this module's header for why
 * both are injectable). `path` is always `path.resolve`d: an override variable
 * is free to hold a relative path and the rest of this module treats a cache
 * root as something it can `stat` and compare, not something it must also
 * normalize.
 */
export function packageCaches(deps: PackageCacheDeps = {}): PackageCache[] {
  const resolved = resolveDeps(deps);
  return [
    { name: "bun", path: path.resolve(bunCacheRoot(resolved)) },
    { name: "npm", path: path.resolve(npmCacheRoot(resolved)) },
    { name: "pnpm", path: path.resolve(pnpmCacheRoot(resolved)) },
    { name: "yarn", path: path.resolve(yarnCacheRoot(resolved)) },
  ];
}

/**
 * The three, and only three, outcomes for one cache against one worktree.
 *
 * `"same-device"` is deliberately not richer than a bare tag: it is the single
 * most common case (most developers have one disk) and the caller's whole
 * obligation for it is to show nothing — see this module's header. Making it
 * carry data would invite a caller to find something to print.
 *
 * `"unreachable"` is NOT `"different-device"`. A cache root that does not exist
 * yet is the ordinary state of a fresh machine, or of a package manager nobody
 * has run — it is not evidence of a different filesystem, and reporting it as
 * one would be a wrong answer dressed as a precise one.
 */
export type DedupOutcome = "same-device" | "different-device" | "unreachable";

/** One cache, and the verdict for installing into `worktreeRoot` from it. */
export type CacheDedupVerdict = PackageCache & { readonly dedup: DedupOutcome };

/**
 * One verdict per cache: can an install into `worktreeRoot` clone/hardlink from
 * each cache, or would it pay a full copy.
 *
 * `caches` defaults to every package manager this module knows about
 * (`packageCaches(deps)`); a caller that only cares about the package manager
 * actually in use may pass a narrower list instead of paying four `stat`s for
 * three it will ignore.
 *
 * A CACHE ROOT THAT FAILS TO `stat` NEVER THROWS OUT OF THIS FUNCTION — it
 * becomes `"unreachable"` for that one cache and every other cache is still
 * reported. One bad cache (a stale env var pointing at a deleted directory, a
 * permissions error) must not take the whole report down; see this module's
 * header on `"unreachable"` for why that state is not an error either.
 *
 * If `worktreeRoot` ITSELF cannot be `stat`'d, nothing here can be compared to
 * anything, so every cache is reported `"unreachable"` rather than guessed at.
 */
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
      // ENOENT is the ordinary case (see header), but ANY error here — a
      // permissions failure, a stat on a path that turned out to be a dangling
      // mount — gets the same verdict for the same reason: this function is
      // not in the business of telling those apart from here, only of not
      // mistaking any of them for "different filesystem".
      return { ...cache, dedup: "unreachable" };
    }
  });
}
