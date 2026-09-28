import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskOutputPage } from "@telar/engine-client";

export const TASK_OUTPUT_TAIL_BYTES = 256 * 1024;
const TASK_OUTPUT_CHUNK_BYTES = 512 * 1024;

export function taskOutputFileFrom(text: string): string | undefined {
  return /Output is being written to: (\/[^\n]*?\.output)(?=[.\s]|$)/.exec(text)?.[1];
}

function claudeTempRoots(): string[] {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const bases = [process.env.CLAUDE_CODE_TMPDIR, "/tmp", os.tmpdir()].filter((base): base is string => Boolean(base));
  const roots = new Set<string>();
  for (const base of bases) {
    try {
      roots.add(path.join(fs.realpathSync(base), `claude-${uid}`));
    } catch {
    }
  }
  return [...roots];
}

export function resolveTaskOutputFile(file: string, providerTaskId: string | undefined, roots = claudeTempRoots()): string | undefined {
  if (!providerTaskId || !path.isAbsolute(file)) return undefined;
  if (path.basename(file) !== `${providerTaskId}.output` || path.basename(path.dirname(file)) !== "tasks") return undefined;
  let dir: string;
  try {
    dir = fs.realpathSync(path.dirname(file));
  } catch {
    dir = path.resolve(path.dirname(file));
  }
  if (!roots.some((root) => dir.startsWith(root + path.sep))) return undefined;
  const resolved = path.join(dir, path.basename(file));
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) return undefined;
  } catch {
  }
  return resolved;
}

function incompleteTail(buffer: Buffer): number {
  for (let back = 1; back <= Math.min(3, buffer.length); back += 1) {
    const byte = buffer[buffer.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return width > back ? back : 0;
  }
  return 0;
}

export async function readTaskOutput(file: string, after?: number): Promise<TaskOutputPage> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: "", cursor: after ?? 0, size: 0, truncated: false, more: false, missing: true };
    }
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const fresh = after === undefined || after > size;
    const start = fresh ? Math.max(0, size - TASK_OUTPUT_TAIL_BYTES) : after;
    const length = Math.min(size - start, TASK_OUTPUT_CHUNK_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let page = buffer.subarray(0, bytesRead);
    let skipped = 0;
    if (fresh && start > 0) {
      const newline = page.indexOf(10);
      skipped = newline >= 0 ? newline + 1 : 0;
      page = page.subarray(skipped);
    }
    page = page.subarray(0, page.length - incompleteTail(page));
    const cursor = start + skipped + page.length;
    return { text: page.toString("utf8"), cursor, size, truncated: start > 0 && fresh, more: start + bytesRead < size, missing: false };
  } finally {
    await handle.close();
  }
}
