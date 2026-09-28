import crypto from "node:crypto";
import { createReadStream, promises as fsAsync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import path from "node:path";
import type { WorkspaceFile, WorkspaceListing } from "@telar/engine-client";
import { nulFields } from "../../git.js";
import type { AsyncGitRunner } from "../../worktree.js";

export const MAX_WORKSPACE_FILES = 5_000;

const MAX_FILE_BYTES = 512 * 1024;

const MAX_RAW_FILE_BYTES = 64 * 1024 * 1024;

const MAX_WALK_DEPTH = 12;

const WALK_DENY = new Set([".git", "node_modules", ".next", ".turbo", "dist", "build", ".venv", "__pycache__", ".cache", "target"]);

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0);
}

export function contentHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function readWorkspaceFile(input: { cwd: string; path: string; maxBytes?: number }): WorkspaceFile {
  const limit = input.maxBytes ?? MAX_FILE_BYTES;
  const absolute = path.resolve(input.cwd, input.path);
  const bytes = statSync(absolute).size;
  const buffer = readFileSync(absolute);
  const sha256 = contentHash(buffer);
  if (looksBinary(buffer)) return { path: input.path, text: "", bytes, sha256, binary: true, truncated: false };
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

export type WriteRefusal = "not_found" | "binary" | "too_large" | "conflict";

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
  if (sha256 !== input.expected) return { written: false, refusal: "conflict", sha256 };

  const next = Buffer.from(input.text, "utf8");
  const temporary = `${absolute}.telar-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, next);
    renameSync(temporary, absolute);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
    }
    throw error;
  }
  return {
    written: true,
    file: { path: input.path, text: input.text, bytes: next.length, sha256: contentHash(next), binary: false, truncated: false },
  };
}

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

export async function readWorkspaceFileBytes(input: { cwd: string; path: string; maxBytes?: number }): Promise<{ data: Buffer; mediaType: string; bytes: number }> {
  const limit = input.maxBytes ?? MAX_RAW_FILE_BYTES;
  const absolute = path.resolve(input.cwd, input.path);
  const bytes = (await fsAsync.stat(absolute)).size;
  if (bytes > limit) throw new Error(`this file is ${bytes} bytes, larger than the ${limit}-byte preview ceiling`);
  return { data: await fsAsync.readFile(absolute), mediaType: mediaTypeFor(input.path), bytes };
}

async function gitWorkspaceFilesAsync(git: AsyncGitRunner, cwd: string): Promise<string[] | undefined> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
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
