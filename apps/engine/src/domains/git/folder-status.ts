import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AsyncGitRunner } from "../../platform/git/runner";

const MIN_RECOMPUTE_MS = 3_000;
const MAX_AGE_MS = 10_000;
const MAX_FOLDERS = 64;
const MAX_STATTED_PATHS = 500;

export type FolderStatusRead = { dirtyFiles?: number; etag: string };

type Entry = { read?: FolderStatusRead; startedAt: number; stale: boolean; pending?: Promise<FolderStatusRead> };

// Fields before the path in each `--porcelain=v2` record; a rename's original path is the next NUL record.
const PATH_FIELD: Record<string, number> = { "1": 8, "2": 9, u: 10, "?": 1 };

function porcelainPaths(stdout: string): string[] {
  const records = stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const skip = PATH_FIELD[record[0] ?? ""];
    if (skip === undefined || record[1] !== " ") continue;
    paths.push(record.split(" ").slice(skip).join(" "));
    if (record[0] === "2") index++;
  }
  return paths;
}

/** Porcelain alone misses a second edit to a file already listed as modified, so each listed path's mtime and size join the tag. */
async function statusOf(git: AsyncGitRunner, folder: string): Promise<FolderStatusRead> {
  const status = await git(folder, ["status", "--porcelain=v2", "--branch", "-z"]);
  if (status.status !== 0 || status.timedOut) return { etag: '"unreadable"' };
  const paths = porcelainPaths(status.stdout);
  const stamps = await Promise.all(
    paths.slice(0, MAX_STATTED_PATHS).map((file) => fs.stat(path.join(folder, file)).then((stat) => `${stat.mtimeMs}:${stat.size}`, () => "-")),
  );
  const hash = createHash("sha1").update(status.stdout).update("\0").update(stamps.join("\0")).digest("base64url").slice(0, 20);
  return { dirtyFiles: paths.length, etag: `"${hash}"` };
}

/**
 * One `git status` per checkout folder, shared by every session and client reading it. An entry is recomputed when
 * marked stale or older than `MAX_AGE_MS`, one run at a time, and never sooner than `MIN_RECOMPUTE_MS` after the last.
 */
export class FolderStatus {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly git: AsyncGitRunner,
    private readonly now: () => number,
  ) {}

  read(folder: string): Promise<FolderStatusRead> {
    const entry = this.entries.get(folder) ?? { startedAt: -Infinity, stale: true };
    this.entries.delete(folder);
    this.entries.set(folder, entry);
    while (this.entries.size > MAX_FOLDERS) this.entries.delete(this.entries.keys().next().value!);
    if (entry.pending) return entry.pending;
    if (entry.read && !entry.stale && this.now() - entry.startedAt < MAX_AGE_MS) return Promise.resolve(entry.read);
    const wait = entry.startedAt + MIN_RECOMPUTE_MS - this.now();
    const pending = (wait > 0 ? new Promise<void>((resolve) => setTimeout(resolve, wait)) : Promise.resolve())
      .then(() => {
        entry.stale = false;
        entry.startedAt = this.now();
        return statusOf(this.git, folder);
      })
      .then((read) => (entry.read = read))
      .finally(() => {
        entry.pending = undefined;
      });
    entry.pending = pending;
    return pending;
  }

  markStaleUnder(root: string): void {
    for (const [folder, entry] of this.entries) {
      if (folder.includes(root)) entry.stale = true;
    }
  }
}
