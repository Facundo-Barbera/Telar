/**
 * WHAT IS IN A CHECKOUT, and what one file says.
 *
 * The cockpit grew a Files tree, and a tree needs two reads nothing else in the
 * engine offered: the list of paths, and the text at one of them. Both are here
 * rather than in ./git.ts because only the first is a git question.
 *
 * `git ls-files` IS THE LIST, AND THAT IS THE WHOLE DESIGN. `--cached --others
 * --exclude-standard` is every tracked file plus every untracked one git would
 * not ignore, which means `.gitignore` — the file the repository already
 * maintains for exactly this purpose — decides what a person sees. A hand-kept
 * deny list would have to guess at `node_modules`, `.next`, `target`, `vendor`,
 * `__pycache__`, `.venv` and whatever the next ecosystem calls its cache, and it
 * would be wrong about somebody's repository within a week. It is also fast:
 * 1,125 paths out of this repository in 18ms, because git is reading an index it
 * already has rather than walking a disk.
 *
 * THE WALK IS THE FALLBACK, NOT THE PLAN. `envMode: "local"` lets a session run
 * in an unversioned directory on purpose, and there is no ignore file to obey
 * there — so the engine walks, with its own small deny list, and the listing says
 * `source: "walk"` so a surface can be honest about which question it answered.
 *
 * THERE IS ONE MUTATION, `writeWorkspaceFile`, and it is the same shape as the
 * one in ./git.ts: a human pressed a key, the change is theirs, and it cannot
 * silently destroy somebody else's. That last part is the whole design — an
 * AGENT may be writing the same file while a person types in the panel, so the
 * write carries the hash the reader saw and is REFUSED when disk has moved. The
 * fencing that keeps a path inside its own checkout lives at the store boundary
 * (see state.ts) for the same reason the patch read's does.
 */
import crypto from "node:crypto";
import { createReadStream, promises as fsAsync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import path from "node:path";
import type { WorkspaceFile, WorkspaceListing } from "@telar/engine-client";
import { nulFields } from "./git.js";
import type { AsyncGitRunner, GitRunner } from "./worktree.js";

/**
 * How many paths one listing may carry.
 *
 * A TRANSPORT LIMIT, unlike the review's — this list is one string per file and
 * a tree renders it all. Five thousand paths is roughly 180KB of JSON, which is
 * fine for a read a human asks for and would not be fine on a timer (which is
 * why nothing polls it). Past that a person is not browsing a tree, and the
 * surface says the list was cut rather than pretending it is the repository.
 */
export const MAX_WORKSPACE_FILES = 5_000;

/**
 * How much of a file a viewer gets.
 *
 * 512KB is far more than anybody reads and far less than a checked-in binary or
 * a generated bundle. A file past it arrives cut, WITH ITS REAL SIZE, so the
 * viewer can say so instead of showing a syntax error that is not in the source.
 */
export const MAX_FILE_BYTES = 512 * 1024;

/**
 * How much of a file the RAW route serves.
 *
 * A different ceiling from `MAX_FILE_BYTES` because it answers a different
 * question: the text route feeds an editor, where 512KB is already past what
 * anybody edits, while the raw route feeds an `<img>`, a PDF viewer or a
 * `<video>` — things that are legitimately tens of megabytes. Past this a
 * file is a download, not a preview, and the route refuses rather than
 * buffering half a gigabyte into the daemon.
 */
export const MAX_RAW_FILE_BYTES = 64 * 1024 * 1024;

/** How deep a walk goes. Only reached in an unversioned directory; deep enough
 *  for a real source tree, shallow enough that a symlink cycle cannot hang the
 *  daemon. */
const MAX_WALK_DEPTH = 12;

/**
 * What a WALK skips. Deliberately short: this list exists only for directories
 * git is not managing, and every entry is a directory nobody has ever wanted to
 * read source out of. A repository never reaches this code — its `.gitignore`
 * does a better job than this list ever could.
 */
const WALK_DENY = new Set([".git", "node_modules", ".next", ".turbo", "dist", "build", ".venv", "__pycache__", ".cache", "target"]);

/** Repo-relative, forward-slashed. A backslash is a legal character in a POSIX
 *  filename, so this converts only the separator the platform actually used. */
function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

/**
 * Every file under `cwd`, as git sees it.
 *
 * Returns `undefined` when this is not a work tree, which is the caller's signal
 * to walk instead. Not an error: an unversioned workspace is a supported
 * configuration, and throwing here would make the Files tree a failure state for
 * it.
 */
export function gitWorkspaceFiles(git: GitRunner, cwd: string): string[] | undefined {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return undefined;
  /**
   * `--deduplicate` matters and is not decoration: without it a path that is
   * both staged and modified is listed twice, and a tree built from the result
   * grows two rows for one file. `-z` for the same reason every other read here
   * uses it — a filename may contain a newline.
   */
  const listed = git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"]);
  if (listed.status !== 0) return [];
  return nulFields(listed.stdout).filter((entry) => entry.length > 0);
}

/**
 * Every file under `root`, by walking it.
 *
 * BREADTH-FIRST, so a cap truncates the DEEPEST paths rather than everything
 * after whichever directory happened to sort first. A tree cut off at
 * `apps/engine/...` because `apps` sorted before `packages` would look like a
 * repository that has no packages.
 */
export function walkWorkspaceFiles(root: string, limit = MAX_WORKSPACE_FILES): string[] {
  const files: string[] = [];
  let frontier: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (frontier.length > 0 && files.length < limit) {
    const next: { dir: string; depth: number }[] = [];
    for (const { dir, depth } of frontier) {
      if (files.length >= limit) break;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // An unreadable directory is one directory, not a failed listing.
        continue;
      }
      for (const entry of entries) {
        if (files.length >= limit) break;
        if (entry.name.startsWith(".") && entry.isDirectory()) continue;
        if (entry.isDirectory()) {
          if (!WALK_DENY.has(entry.name) && depth + 1 <= MAX_WALK_DEPTH) next.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
          continue;
        }
        // A SYMLINK IS NOT FOLLOWED. `isFile()` is false for one, so a link into
        // a parent directory cannot turn this walk into a cycle.
        if (entry.isFile()) files.push(relative(root, path.join(dir, entry.name)));
      }
    }
    frontier = next;
  }
  return files;
}

export function listWorkspaceFiles(git: GitRunner, input: { cwd: string; now: number }): WorkspaceListing {
  const tracked = gitWorkspaceFiles(git, input.cwd);
  const repository = tracked !== undefined;
  const all = tracked ?? walkWorkspaceFiles(input.cwd, MAX_WORKSPACE_FILES + 1);
  /**
   * SORTED HERE, ONCE. `ls-files` is already sorted and a walk is not, and a
   * tree whose order depends on which reader answered is a tree that reorders
   * under the cursor when a project stops being a repository. Plain codepoint
   * order — the client groups and sorts per directory, which is a different
   * question and belongs where the grouping happens.
   */
  const files = all.slice(0, MAX_WORKSPACE_FILES).sort();
  return {
    workspacePath: input.cwd,
    repository,
    files,
    source: repository ? "git" : "walk",
    truncated: all.length > MAX_WORKSPACE_FILES,
    readAt: input.now,
  };
}

/**
 * A NUL byte in the first block means binary, which is the same test `git diff`
 * uses. Cheaper and more honest than sniffing extensions: a `.txt` full of bytes
 * is binary and a `.dat` full of JSON is not.
 */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0);
}

/**
 * THE HASH OF WHAT IS ON DISK, and the reason writes are safe.
 *
 * Of the WHOLE file, always — never of the truncated view a reader received.
 * That is deliberate: it is a precondition, and a precondition computed over a
 * prefix would happily authorise a write that discards everything after it.
 */
export function contentHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * One file's text.
 *
 * The path arriving here is already fenced inside its checkout by the caller —
 * this function does the reading, not the deciding.
 */
export function readWorkspaceFile(input: { cwd: string; path: string; maxBytes?: number }): WorkspaceFile {
  const limit = input.maxBytes ?? MAX_FILE_BYTES;
  const absolute = path.resolve(input.cwd, input.path);
  const bytes = statSync(absolute).size;
  const buffer = readFileSync(absolute);
  const sha256 = contentHash(buffer);
  if (looksBinary(buffer)) return { path: input.path, text: "", bytes, sha256, binary: true, truncated: false };
  /**
   * CUT ON BYTES, THEN DECODED — the other order would mean decoding a
   * multi-megabyte file in order to throw most of it away. A multi-byte
   * character straddling the cut decodes to one replacement character at the
   * very end of a view that already says it is truncated.
   */
  const truncated = buffer.length > limit;
  return {
    path: input.path,
    text: (truncated ? buffer.subarray(0, limit) : buffer).toString("utf8"),
    bytes,
    sha256,
    binary: false,
    truncated,
  };
}

/** Why a write was refused. Four distinct reasons, because they need four
 *  different responses from a reader — see `writeWorkspaceFile`. */
export type WriteRefusal = "not_found" | "binary" | "too_large" | "conflict";

/**
 * REPLACE A FILE'S TEXT, IF DISK STILL LOOKS THE WAY THE EDITOR THINKS.
 *
 * `expected` is the `sha256` from the read the editor is showing. Every refusal
 * below is a case where writing would destroy something:
 *
 *   - `conflict` — disk moved. Usually the AGENT, mid-turn, writing the file you
 *     have open. This is the reason the whole endpoint takes a hash: a
 *     last-write-wins save beside a running agent is a data-loss button with a
 *     500ms fuse. t3 code's editor sends no precondition, which is fine in an app
 *     where nothing else writes; it is not fine here.
 *   - `too_large` — the read was CUT, so the editor is holding a prefix. Saving it
 *     would delete everything past the cut. Refused at the engine as well as
 *     hidden in the client, because one client's bug should not be able to
 *     truncate a file.
 *   - `binary` — no text was ever sent, so there is nothing to save back.
 *   - `not_found` — this endpoint replaces; it does not create. Creating a file is
 *     a different gesture with a different safety question, and `expected` has no
 *     meaning for a file that does not exist yet.
 *
 * ATOMIC: written beside the target and renamed over it, so a crash or a full
 * disk leaves the original rather than half a file. Same rule as every other
 * write this engine makes.
 */
export function writeWorkspaceFile(input: {
  cwd: string;
  path: string;
  text: string;
  expected: string;
  maxBytes?: number;
}): { written: true; file: WorkspaceFile } | { written: false; refusal: WriteRefusal; sha256?: string } {
  const limit = input.maxBytes ?? MAX_FILE_BYTES;
  const absolute = path.resolve(input.cwd, input.path);
  let current: Buffer;
  try {
    current = readFileSync(absolute);
  } catch {
    return { written: false, refusal: "not_found" };
  }
  if (looksBinary(current)) return { written: false, refusal: "binary", sha256: contentHash(current) };
  if (current.length > limit) return { written: false, refusal: "too_large", sha256: contentHash(current) };
  const sha256 = contentHash(current);
  // Compared against the WHOLE file, which is what `readWorkspaceFile` hashes.
  if (sha256 !== input.expected) return { written: false, refusal: "conflict", sha256 };

  const next = Buffer.from(input.text, "utf8");
  const temporary = `${absolute}.telar-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, next);
    renameSync(temporary, absolute);
  } catch (error) {
    // Never leave the scratch file behind: it would show up in the tree, in
    // `git status`, and in the next person's diff.
    try {
      unlinkSync(temporary);
    } catch {
      // Already gone, or never created. Either way there is nothing to clean.
    }
    throw error;
  }
  return {
    written: true,
    file: { path: input.path, text: input.text, bytes: next.length, sha256: contentHash(next), binary: false, truncated: false },
  };
}


/**
 * The media type the raw route declares, FROM THE NAME — the same trade
 * `file-kinds.ts` makes in the cockpit. Sniffing bytes would be more honest
 * about a mislabelled file, but the consumer is a browser rendering `<img>`,
 * `<iframe>` or `<video>`, and a browser presented with a wrong declared type
 * fails safe (it refuses to render) rather than dangerously. Only the types a
 * viewer exists for are named; everything else is opaque bytes.
 */
const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
};

export function mediaTypeFor(target: string): string {
  const name = target.split("/").at(-1) ?? target;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MEDIA_TYPES[extension] ?? "application/octet-stream";
}

/**
 * One file's BYTES, whole — what the media viewers eat.
 *
 * The text read above deliberately withholds a binary file's content; this is
 * the counterpart that serves it. REFUSED over the raw ceiling rather than
 * truncated: half a PNG is not a smaller picture, it is a broken one, and a
 * viewer fed a cut PDF renders an error page that looks like engine failure.
 */
export async function readWorkspaceFileBytes(input: { cwd: string; path: string; maxBytes?: number }): Promise<{ data: Buffer; mediaType: string; bytes: number }> {
  const limit = input.maxBytes ?? MAX_RAW_FILE_BYTES;
  const absolute = path.resolve(input.cwd, input.path);
  const bytes = (await fsAsync.stat(absolute)).size;
  if (bytes > limit) throw new Error(`this file is ${bytes} bytes, larger than the ${limit}-byte preview ceiling`);
  return { data: await fsAsync.readFile(absolute), mediaType: mediaTypeFor(input.path), bytes };
}

/** Async reads keep Files and the composer's file picker off the daemon loop. */
export async function gitWorkspaceFilesAsync(git: AsyncGitRunner, cwd: string): Promise<string[] | undefined> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  // A timed-out repository is not evidence of an unversioned directory. Walking
  // it would add filesystem work precisely when the checkout is already stalled.
  if (inside.timedOut) throw new Error(inside.stderr || "Git file listing timed out");
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return undefined;
  const listed = await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"]);
  if (listed.timedOut) throw new Error(listed.stderr || "Git file listing timed out");
  if (listed.status !== 0) return [];
  return nulFields(listed.stdout).filter((entry) => entry.length > 0);
}

export async function walkWorkspaceFilesAsync(root: string, limit = MAX_WORKSPACE_FILES): Promise<string[]> {
  const files: string[] = [];
  let frontier: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (frontier.length > 0 && files.length < limit) {
    const next: { dir: string; depth: number }[] = [];
    for (const { dir, depth } of frontier) {
      if (files.length >= limit) break;
      let entries: Dirent[];
      try {
        entries = await fsAsync.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (files.length >= limit) break;
        if (entry.name.startsWith(".") && entry.isDirectory()) continue;
        if (entry.isDirectory()) {
          if (!WALK_DENY.has(entry.name) && depth + 1 <= MAX_WALK_DEPTH) next.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
          continue;
        }
        if (entry.isFile()) files.push(relative(root, path.join(dir, entry.name)));
      }
    }
    frontier = next;
  }
  return files;
}

export async function listWorkspaceFilesAsync(git: AsyncGitRunner, input: { cwd: string; now: number }): Promise<WorkspaceListing> {
  const tracked = await gitWorkspaceFilesAsync(git, input.cwd);
  const repository = tracked !== undefined;
  const all = tracked ?? await walkWorkspaceFilesAsync(input.cwd, MAX_WORKSPACE_FILES + 1);
  return {
    workspacePath: input.cwd,
    repository,
    files: all.slice(0, MAX_WORKSPACE_FILES).sort(),
    source: repository ? "git" : "walk",
    truncated: all.length > MAX_WORKSPACE_FILES,
    readAt: input.now,
  };
}

/** Stream the complete hash for optimistic writes, but retain only the preview.
 * Opening a large generated file must not allocate its entire contents in RAM.
 */
export async function readWorkspaceFileAsync(input: { cwd: string; path: string; maxBytes?: number }): Promise<WorkspaceFile> {
  const limit = input.maxBytes ?? MAX_FILE_BYTES;
  const absolute = path.resolve(input.cwd, input.path);
  const previewLimit = Math.max(8_192, limit);
  const chunks: Buffer[] = [];
  let previewBytes = 0;
  let bytes = 0;
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(absolute, { highWaterMark: 64 * 1024, signal: AbortSignal.timeout(30_000) });
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
    if (previewBytes < previewLimit) {
      const saved = Buffer.from(buffer.subarray(0, previewLimit - previewBytes));
      chunks.push(saved);
      previewBytes += saved.length;
    }
  }
  const preview = Buffer.concat(chunks, previewBytes);
  const sha256 = hash.digest("hex");
  if (looksBinary(preview)) return { path: input.path, text: "", bytes, sha256, binary: true, truncated: false };
  return {
    path: input.path,
    text: preview.subarray(0, limit).toString("utf8"),
    bytes,
    sha256,
    binary: false,
    truncated: bytes > limit,
  };
}
