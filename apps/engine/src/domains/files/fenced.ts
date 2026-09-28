import fs from "node:fs";
import path from "node:path";
import type { WorkspaceFile, WorkspaceWriteResult } from "@telar/engine-client";
import { EngineStateError } from "../../platform/kernel";
import { readWorkspaceFile, readWorkspaceFileAsync, readWorkspaceFileBytes, writeWorkspaceFile } from "./workspace";

const MAX_WRITE_CHARS = 2_000_000;

// The engine listens with no login, so the check sits here rather than at a route an in-process caller could skip.
function fence(root: string, target: string, label: string): { resolved: string; relative: string } {
  if (!target.trim()) throw new EngineStateError("invalid_request", "a file path is required");
  const resolved = path.resolve(root, target);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new EngineStateError("invalid_request", `that path is outside the ${label}`);
  return { resolved, relative: path.relative(root, resolved) };
}

function requireFile(stats: fs.Stats | undefined): void {
  if (!stats) throw new EngineStateError("not_found", "no such file in this workspace");
  if (stats.isDirectory()) throw new EngineStateError("invalid_request", "that path is a directory");
  if (!stats.isFile()) throw new EngineStateError("invalid_request", "that path is not a regular file");
}

/** Reads one file inside `root` and nowhere else; `label` names the place in the refusal. */
export function readFenced(root: string, target: string, label: string, maxBytes?: number): WorkspaceFile {
  const { resolved, relative } = fence(root, target, label);
  let stats: fs.Stats | undefined;
  try {
    stats = fs.statSync(resolved);
  } catch { /* any failure to stat reads as missing */ }
  requireFile(stats);
  return readWorkspaceFile({ cwd: root, path: relative, ...(maxBytes ? { maxBytes } : {}) });
}

export async function readFencedAsync(root: string, target: string, label: string): Promise<WorkspaceFile> {
  const { resolved, relative } = fence(root, target, label);
  requireFile(await fs.promises.stat(resolved).catch(() => undefined));
  return readWorkspaceFileAsync({ cwd: root, path: relative });
}

/** Whole content and a media type for the media viewers; a size refusal is a sentence, not a 500. */
export async function readFencedBytes(root: string, target: string, label: string): Promise<{ data: Buffer; mediaType: string; bytes: number }> {
  const { resolved, relative } = fence(root, target, label);
  requireFile(await fs.promises.stat(resolved).catch(() => undefined));
  try {
    return await readWorkspaceFileBytes({ cwd: root, path: relative });
  } catch (error) {
    throw new EngineStateError("invalid_request", error instanceof Error ? error.message : "the file could not be read");
  }
}

/** A missing file is a refusal the editor renders inline, not a 404, so the write leaves the stat to `writeWorkspaceFile`. */
export function writeFenced(root: string, target: string, text: string, expected: string, label: string, maxBytes?: number): WorkspaceWriteResult {
  if (!target.trim()) throw new EngineStateError("invalid_request", "a file path is required");
  if (!expected.trim()) throw new EngineStateError("invalid_request", "a write must carry the hash it expects on disk");
  if (text.length > (maxBytes ?? MAX_WRITE_CHARS)) throw new EngineStateError("invalid_request", "that file is too large to save");
  return writeWorkspaceFile({ cwd: root, path: fence(root, target, label).relative, text, expected, ...(maxBytes ? { maxBytes } : {}) });
}
