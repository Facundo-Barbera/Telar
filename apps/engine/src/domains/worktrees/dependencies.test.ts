import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultWorktreeGitRunner } from "./checkout";
import { DEPENDENCY_LIMITS, pruneBuildOutputs, shareDependencies } from "./dependencies";
import { WorktreeSetups } from "./setup";
import type { RunLauncher } from "../terminal";

const roots: string[] = [];
const limits = { ...DEPENDENCY_LIMITS };
afterEach(() => {
  Object.assign(DEPENDENCY_LIMITS, limits);
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function write(root: string, relative: string, text = "x"): void {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), text);
}

function fixture(): { checkout: string; worktree: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telar-deps-")));
  roots.push(base);
  const checkout = path.join(base, "checkout");
  fs.mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "config", "user.email", "test@telar.local");
  git(checkout, "config", "user.name", "Telar Test");
  write(checkout, ".gitignore", "node_modules/\n.venv/\n.next/\ndist/\n");
  write(checkout, "packages/lib/index.js", "checkout lib");
  write(checkout, "apps/web/package.json", "{}");
  write(checkout, "shipped/dist/keep.js", "tracked");
  git(checkout, "add", "-A");
  git(checkout, "add", "-f", "shipped/dist/keep.js");
  git(checkout, "commit", "-qm", "initial");

  write(checkout, "node_modules/left-pad/index.js", "left-pad");
  write(checkout, "node_modules/@types/node/index.d.ts", "types");
  fs.mkdirSync(path.join(checkout, "node_modules/@acme"), { recursive: true });
  fs.symlinkSync("../../packages/lib", path.join(checkout, "node_modules/@acme/lib"));
  write(checkout, "apps/web/node_modules/next/index.js", "next");
  write(checkout, ".venv/pyvenv.cfg", "home = /usr/bin");

  const worktree = path.join(base, "worktree");
  git(checkout, "worktree", "add", "-q", "-b", "session", worktree);
  write(worktree, "packages/lib/index.js", "worktree lib");
  return { checkout, worktree };
}

const read = (file: string) => fs.readFileSync(file, "utf8");

test("share links the checkout's dependencies, but workspace packages resolve to the worktree's own", async () => {
  const { checkout, worktree } = fixture();

  expect((await shareDependencies(checkout, worktree)).sort()).toEqual([".venv", path.join("apps/web/node_modules"), "node_modules"]);

  expect(read(path.join(worktree, "node_modules/left-pad/index.js"))).toBe("left-pad");
  expect(read(path.join(worktree, "node_modules/@types/node/index.d.ts"))).toBe("types");
  expect(read(path.join(worktree, "apps/web/node_modules/next/index.js"))).toBe("next");
  expect(read(path.join(worktree, ".venv/pyvenv.cfg"))).toBe("home = /usr/bin");
  expect(read(path.join(worktree, "node_modules/@acme/lib/index.js"))).toBe("worktree lib");
  expect(fs.lstatSync(path.join(worktree, "node_modules")).isDirectory()).toBe(true);
  expect(git(worktree, "status", "--porcelain")).toBe(" M packages/lib/index.js\n");
});

test("share leaves dependencies the worktree already has", async () => {
  const { checkout, worktree } = fixture();
  write(worktree, "node_modules/own/index.js", "own");

  expect(await shareDependencies(checkout, worktree)).not.toContain("node_modules");
  expect(fs.readdirSync(path.join(worktree, "node_modules"))).toEqual(["own"]);
});

test("pruning removes ignored build output and keeps tracked output and the checkout's files", async () => {
  const { checkout, worktree } = fixture();
  await shareDependencies(checkout, worktree);
  write(worktree, "apps/web/.next/cache/big", "cache");
  write(worktree, "dist/bundle.js", "bundle");
  write(checkout, "node_modules/left-pad/dist/index.js", "shipped by the package");

  const pruned = await pruneBuildOutputs(defaultWorktreeGitRunner, worktree);

  expect(pruned.sort()).toEqual([path.join("apps/web/.next"), "dist"]);
  expect(fs.existsSync(path.join(worktree, "apps/web/.next"))).toBe(false);
  expect(fs.existsSync(path.join(worktree, "dist"))).toBe(false);
  expect(read(path.join(worktree, "shipped/dist/keep.js"))).toBe("tracked");
  expect(read(path.join(checkout, "node_modules/left-pad/dist/index.js"))).toBe("shipped by the package");
});

test("share skips a dependency directory too large to link, leaving nothing half-linked", async () => {
  const { checkout, worktree } = fixture();
  for (const name of ["a", "b", "c", "d", "e", "f"]) write(checkout, `apps/web/node_modules/${name}/index.js`);
  DEPENDENCY_LIMITS.linksPerDirectory = 5;

  const shared = await shareDependencies(checkout, worktree);

  expect(shared).toContain("node_modules");
  expect(shared).not.toContain(path.join("apps/web/node_modules"));
  expect(fs.existsSync(path.join(worktree, "apps/web/node_modules"))).toBe(false);
});

test("the scan stops after its entry budget instead of walking the whole tree", async () => {
  const { checkout, worktree } = fixture();
  write(worktree, "dist/bundle.js");
  DEPENDENCY_LIMITS.scannedEntries = 0;

  expect(await shareDependencies(checkout, worktree)).toEqual([]);
  expect(await pruneBuildOutputs(defaultWorktreeGitRunner, worktree)).toEqual([]);
  expect(fs.existsSync(path.join(worktree, "dist/bundle.js"))).toBe(true);
});

test("setup runs the command only when dependencies are installed", async () => {
  const { checkout, worktree } = fixture();
  const launched: string[] = [];
  const launcher: RunLauncher = {
    kind: "pipes",
    launch: async (request, events) => {
      launched.push(request.cwd ?? "");
      queueMicrotask(() => events.exited({ exitCode: 0 }));
      return { close: async () => undefined } as never;
    },
  };
  const setups = new WorktreeSetups({ directoryOf: (id) => path.join(worktree, "..", id), launcher });
  const setup = { command: "bun install" };

  expect(await setups.start("none", { checkout, worktree, config: { setup, dependencies: "none" } })).toBeUndefined();
  expect(await setups.start("share", { checkout, worktree, config: { setup, dependencies: "share" } })).toBeUndefined();
  expect(fs.existsSync(path.join(worktree, "node_modules/left-pad"))).toBe(true);
  expect(launched).toEqual([]);

  await setups.start("install", { checkout, worktree, config: { setup } });
  expect((await setups.wait("install"))?.state).toBe("succeeded");
  expect(launched).toEqual([worktree]);
});
