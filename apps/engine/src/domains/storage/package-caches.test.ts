import { expect, test } from "bun:test";
import type { Stats } from "node:fs";
import { detectCacheDedup, packageCaches, type PackageCache } from "./package-caches";

function fakeStat(devices: Record<string, number>, errorCode = "ENOENT") {
  return (target: string): Stats => {
    if (!(target in devices)) {
      const error = new Error(`stat '${target}': no such file or directory`) as NodeJS.ErrnoException;
      error.code = errorCode;
      throw error;
    }
    return { dev: devices[target] } as Stats;
  };
}

const CACHE: PackageCache = { name: "bun", path: "/cache/bun" };
const OTHER: PackageCache = { name: "npm", path: "/cache/npm" };
const WORKTREE = "/worktrees/one";

test("equal devices are the same filesystem, and a caller shows nothing for it", () => {
  const stat = fakeStat({ [WORKTREE]: 7, [CACHE.path]: 7 });
  const [verdict] = detectCacheDedup(WORKTREE, { stat }, [CACHE]);
  expect(verdict).toEqual({ ...CACHE, dedup: "same-device" });
});

test("a cache root that ENOENTs is unreachable, never different-device", () => {
  const stat = fakeStat({ [WORKTREE]: 7 });
  const [verdict] = detectCacheDedup(WORKTREE, { stat }, [CACHE]);
  expect(verdict.dedup).toBe("unreachable");
  expect(verdict.dedup).not.toBe("different-device");
});

test("different devices means a real copy, not a clone", () => {
  const stat = fakeStat({ [WORKTREE]: 7, [CACHE.path]: 9 });
  const [verdict] = detectCacheDedup(WORKTREE, { stat }, [CACHE]);
  expect(verdict).toEqual({ ...CACHE, dedup: "different-device" });
});

test("a non-ENOENT stat error is still unreachable, not a throw", () => {
  const stat = fakeStat({ [WORKTREE]: 7 }, "EACCES");
  expect(() => detectCacheDedup(WORKTREE, { stat }, [CACHE])).not.toThrow();
  const [verdict] = detectCacheDedup(WORKTREE, { stat }, [CACHE]);
  expect(verdict.dedup).toBe("unreachable");
});

test("one unreachable cache does not take the rest of the report down", () => {
  const stat = fakeStat({ [WORKTREE]: 7, [OTHER.path]: 7 });
  const verdicts = detectCacheDedup(WORKTREE, { stat }, [CACHE, OTHER]);
  expect(verdicts).toEqual([
    { ...CACHE, dedup: "unreachable" },
    { ...OTHER, dedup: "same-device" },
  ]);
});

test("a worktree root that cannot itself be stat'd reports every cache unreachable", () => {
  const stat = fakeStat({ [CACHE.path]: 7, [OTHER.path]: 9 });
  const verdicts = detectCacheDedup(WORKTREE, { stat }, [CACHE, OTHER]);
  expect(verdicts).toHaveLength(2);
  expect(verdicts.map((v) => v.dedup)).toEqual(["unreachable", "unreachable"]);
});

const HOME_DARWIN = "/Users/fixture";
const HOME_LINUX = "/home/fixture";

test("bun: BUN_INSTALL_CACHE_DIR wins outright, even over BUN_INSTALL", () => {
  const caches = packageCaches({
    env: { BUN_INSTALL_CACHE_DIR: "/override/bun-cache", BUN_INSTALL: "/opt/bun" },
    homedir: () => HOME_DARWIN,
    platform: "darwin",
  });
  expect(caches.find((c) => c.name === "bun")?.path).toBe("/override/bun-cache");
});

test("bun: BUN_INSTALL relocates the cache under it, absent the direct override", () => {
  const caches = packageCaches({ env: { BUN_INSTALL: "/opt/bun" }, homedir: () => HOME_DARWIN, platform: "darwin" });
  expect(caches.find((c) => c.name === "bun")?.path).toBe("/opt/bun/install/cache");
});

test("bun: the plain default sits under the home directory, on darwin and on linux", () => {
  const darwin = packageCaches({ env: {}, homedir: () => HOME_DARWIN, platform: "darwin" });
  expect(darwin.find((c) => c.name === "bun")?.path).toBe(`${HOME_DARWIN}/.bun/install/cache`);

  const linux = packageCaches({ env: {}, homedir: () => HOME_LINUX, platform: "linux" });
  expect(linux.find((c) => c.name === "bun")?.path).toBe(`${HOME_LINUX}/.bun/install/cache`);
});

test("npm: npm_config_cache wins, else ~/.npm/_cacache", () => {
  const overridden = packageCaches({ env: { npm_config_cache: "/override/npm-cache" }, homedir: () => HOME_DARWIN, platform: "darwin" });
  expect(overridden.find((c) => c.name === "npm")?.path).toBe("/override/npm-cache");

  const darwin = packageCaches({ env: {}, homedir: () => HOME_DARWIN, platform: "darwin" });
  expect(darwin.find((c) => c.name === "npm")?.path).toBe(`${HOME_DARWIN}/.npm/_cacache`);

  const linux = packageCaches({ env: {}, homedir: () => HOME_LINUX, platform: "linux" });
  expect(linux.find((c) => c.name === "npm")?.path).toBe(`${HOME_LINUX}/.npm/_cacache`);
});

test("pnpm: XDG_CACHE_HOME wins, regardless of platform", () => {
  const caches = packageCaches({ env: { XDG_CACHE_HOME: "/override/xdg" }, homedir: () => HOME_DARWIN, platform: "darwin" });
  expect(caches.find((c) => c.name === "pnpm")?.path).toBe("/override/xdg/pnpm");
});

test("pnpm: absent XDG_CACHE_HOME, the default is ~/Library/pnpm on darwin, ~/.cache/pnpm elsewhere", () => {
  const darwin = packageCaches({ env: {}, homedir: () => HOME_DARWIN, platform: "darwin" });
  expect(darwin.find((c) => c.name === "pnpm")?.path).toBe(`${HOME_DARWIN}/Library/pnpm`);

  const linux = packageCaches({ env: {}, homedir: () => HOME_LINUX, platform: "linux" });
  expect(linux.find((c) => c.name === "pnpm")?.path).toBe(`${HOME_LINUX}/.cache/pnpm`);
});

test("yarn: YARN_CACHE_FOLDER wins, regardless of platform", () => {
  const caches = packageCaches({ env: { YARN_CACHE_FOLDER: "/override/yarn-cache" }, homedir: () => HOME_DARWIN, platform: "darwin" });
  expect(caches.find((c) => c.name === "yarn")?.path).toBe("/override/yarn-cache");
});

test("yarn: absent YARN_CACHE_FOLDER, the default is ~/Library/Caches/Yarn on darwin, ~/.cache/yarn elsewhere", () => {
  const darwin = packageCaches({ env: {}, homedir: () => HOME_DARWIN, platform: "darwin" });
  expect(darwin.find((c) => c.name === "yarn")?.path).toBe(`${HOME_DARWIN}/Library/Caches/Yarn`);

  const linux = packageCaches({ env: {}, homedir: () => HOME_LINUX, platform: "linux" });
  expect(linux.find((c) => c.name === "yarn")?.path).toBe(`${HOME_LINUX}/.cache/yarn`);
});

test("all four supported package managers are resolved, and only those four", () => {
  const caches = packageCaches({ env: {}, homedir: () => HOME_DARWIN, platform: "darwin" });
  expect(caches.map((c) => c.name).sort()).toEqual(["bun", "npm", "pnpm", "yarn"]);
});
