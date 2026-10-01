import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mountRootsFor, type DirectoryListing } from "@telar/engine-client";

export type DirectoryFailure = { code: "invalid_request" | "not_found"; message: string; unreadable?: true };
export type DirectoryOutcome = DirectoryListing | DirectoryFailure;

export function isDirectoryFailure(outcome: DirectoryOutcome): outcome is DirectoryFailure {
  return "code" in outcome;
}

export const MAX_ENTRIES = 500;

export const GIT_PROBE_BUDGET_MS = 1500;

export type DirectoryDeps = {
  home?: string;
  platform?: NodeJS.Platform;
  mounts?: readonly string[];
  realpath?: (target: string) => string;
  stat?: (target: string) => fs.Stats;
  lstat?: (target: string) => fs.Stats;
  readdir?: (target: string) => fs.Dirent[];
  exists?: (target: string) => boolean;
  now?: () => number;
};

type Resolved = Required<DirectoryDeps>;

function resolveDeps(deps: DirectoryDeps): Resolved {
  const platform = deps.platform ?? process.platform;
  return {
    home: deps.home ?? os.homedir(),
    platform,
    mounts: deps.mounts ?? mountRootsFor(platform),
    realpath: deps.realpath ?? ((target) => fs.realpathSync.native(target)),
    stat: deps.stat ?? ((target) => fs.statSync(target)),
    lstat: deps.lstat ?? ((target) => fs.lstatSync(target)),
    readdir: deps.readdir ?? ((target) => fs.readdirSync(target, { withFileTypes: true })),
    exists: deps.exists ?? ((target) => fs.existsSync(target)),
    now: deps.now ?? Date.now,
  };
}

export function expandHome(raw: string | null | undefined, home: string): string {
  const input = (raw ?? "").trim();
  if (!input || input === "~") return home;
  if (input === "~/" || input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

export function browseRoots(deps: DirectoryDeps = {}): string[] {
  const { home, mounts, exists } = resolveDeps(deps);
  return [home, ...mounts.filter((mount) => exists(mount))];
}

export function within(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

function outsideMessage(roots: readonly string[]): string {
  const [home, ...mounts] = roots;
  const where = mounts.length > 0 ? `${home} or a mounted volume (${mounts.join(", ")})` : String(home);
  return `Telar only browses ${where}. Type a path inside one of those.`;
}

function inCloudFolder(target: string, home: string): boolean {
  return within(path.join(home, "Library", "CloudStorage"), target);
}

const errorCode = (cause: unknown): string | undefined => (cause as { code?: string } | null)?.code;

const absent = (code: string | undefined) => code === "ENOENT" || code === "ENOTDIR";

function unreadable(target: string, home: string, code: string | undefined): DirectoryFailure {
  const denied = code === "EACCES" || code === "EPERM";
  const failure = (message: string): DirectoryFailure => ({ code: "invalid_request", message, unreadable: true });
  if (inCloudFolder(target, home)) {
    return failure(
      denied
        ? "macOS has not let Telar read this cloud folder. Allow it in System Settings → Privacy & Security → Files & Folders, then try again."
        : `That cloud folder could not be read${code ? ` (${code})` : ""}. Check that its sync app is running and signed in, then try again.`,
    );
  }
  if (denied) return failure("That folder is not readable.");
  return failure(`That folder could not be read${code ? ` (${code})` : ""}.`);
}

export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function listDirectories(
  input: { path?: string | null; hidden?: boolean; nearest?: boolean } = {},
  deps: DirectoryDeps = {},
): DirectoryOutcome {
  const resolved = resolveDeps(deps);
  const { home, realpath, stat, lstat, readdir, exists, now } = resolved;
  const requested = expandHome(input.path, home);
  if (!path.isAbsolute(requested)) {
    return { code: "invalid_request", message: "A folder path has to be absolute, or start with ~." };
  }

  let candidate = requested;
  let walked = false;
  let target: string | undefined;
  while (target === undefined) {
    let real: string;
    let directory: boolean;
    try {
      real = realpath(candidate);
      directory = stat(real).isDirectory();
    } catch (cause) {
      const code = errorCode(cause);
      if (code === "ELOOP") return { code: "invalid_request", message: "That path loops through itself." };
      if (!absent(code)) return unreadable(candidate, home, code);
      if (!input.nearest || path.dirname(candidate) === candidate) {
        return { code: "not_found", message: "That folder does not exist." };
      }
      candidate = path.dirname(candidate);
      walked = true;
      continue;
    }
    if (directory) target = real;
    else if (!input.nearest) return { code: "invalid_request", message: "That is a file, not a folder." };
    else {
      candidate = path.dirname(candidate);
      walked = true;
    }
  }
  const folder = target;

  const roots = browseRoots(resolved);
  if (!roots.some((root) => within(root, folder))) {
    return { code: "invalid_request", message: outsideMessage(roots) };
  }

  let children: fs.Dirent[];
  try {
    children = readdir(folder);
  } catch (cause) {
    return unreadable(folder, home, errorCode(cause));
  }

  const isFolder = (entry: fs.Dirent): boolean => {
    if (entry.isDirectory()) return true;
    if (entry.isFile() || entry.isSymbolicLink() || entry.isFIFO() || entry.isSocket()) return false;
    if (entry.isBlockDevice() || entry.isCharacterDevice()) return false;
    try {
      return lstat(path.join(folder, entry.name)).isDirectory();
    } catch {
      return false;
    }
  };
  const names = children.filter(isFolder).map((entry) => entry.name);
  const visible = input.hidden ? names : names.filter((name) => !name.startsWith("."));
  const truncated = visible.length > MAX_ENTRIES;
  const deadline = now() + GIT_PROBE_BUDGET_MS;
  let gitPartial = false;
  const dirs = visible
    .sort(compareNames)
    .slice(0, MAX_ENTRIES)
    .map((name) => {
      const full = path.join(folder, name);
      let git = false;
      if (!gitPartial && now() > deadline) gitPartial = true;
      if (!gitPartial) {
        try {
          git = exists(path.join(full, ".git"));
        } catch {
        }
      }
      return { name, path: full, git, hidden: name.startsWith(".") };
    });

  const up = path.dirname(folder);
  return {
    path: folder,
    name: path.basename(folder) || folder,
    parent: up !== folder && roots.some((root) => within(root, up)) ? up : null,
    home,
    roots: listRoots(resolved),
    dirs,
    truncated,
    ...(walked ? { missing: requested } : {}),
    ...(gitPartial ? { gitPartial } : {}),
  };
}

export function listRoots(deps: DirectoryDeps = {}): { name: string; path: string }[] {
  const resolved = resolveDeps(deps);
  const { home, mounts, readdir, exists } = resolved;
  const roots = [{ name: "Home", path: home }];
  for (const mount of mounts) {
    if (!exists(mount)) continue;
    let names: string[];
    try {
      names = readdir(mount).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of names.filter((entry) => !entry.startsWith(".")).sort(compareNames)) {
      const full = path.join(mount, name);
      try {
        if (resolved.stat(full).dev === resolved.stat(mount).dev) continue;
      } catch {
        continue;
      }
      roots.push({ name, path: full });
    }
  }
  return roots;
}
