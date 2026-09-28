/**
 * A BACKGROUND TASK'S LOG, read back from where the provider wrote it.
 *
 * Claude Code writes every backgrounded shell to a file of its own —
 * `<tmp>/claude-<uid>/<cwd slug>/<session>/tasks/<task id>.output` — and says
 * so twice: in the Bash call's result text when the shell starts, and as
 * `output_file` on the `task_notification` when it ends. The driver records the
 * path on the task (`Task.outputFile`); this module is the one place that turns
 * that path back into bytes for the Processes tab.
 *
 * THE PATH IS NEVER TAKEN FROM A CLIENT. The route reads the path the driver
 * stored on the task, and even that is checked here: it must sit under Claude
 * Code's own temp root, be named after the task's provider id, and not be a
 * symlink — so a stored row cannot be turned into a read of anything else.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskOutputPage } from "@telar/engine-client";

/** How far back the first read of a log reaches. A watcher can write
 *  gigabytes; the panel is a place to see what it is doing now. */
export const TASK_OUTPUT_TAIL_BYTES = 256 * 1024;
/** The most one read returns; `more` says there is another page. */
const TASK_OUTPUT_CHUNK_BYTES = 512 * 1024;

/** The path in a backgrounded Bash call's result text, if it states one. */
export function taskOutputFileFrom(text: string): string | undefined {
  return /Output is being written to: (\/[^\n]*?\.output)(?=[.\s]|$)/.exec(text)?.[1];
}

/** Claude Code's temp roots for this user. `CLAUDE_CODE_TMPDIR` moves it;
 *  otherwise it is `/tmp` (on macOS, `/private/tmp` once resolved). */
function claudeTempRoots(): string[] {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const bases = [process.env.CLAUDE_CODE_TMPDIR, "/tmp", os.tmpdir()].filter((base): base is string => Boolean(base));
  const roots = new Set<string>();
  for (const base of bases) {
    try {
      roots.add(path.join(fs.realpathSync(base), `claude-${uid}`));
    } catch {
      // A base that does not exist holds no logs.
    }
  }
  return [...roots];
}

/**
 * The real path of a task's log, or `undefined` when the stored path is not a
 * Claude task log for THIS task. A log that does not exist yet (or any more)
 * still resolves — `readTaskOutput` answers `missing` for it.
 */
export function resolveTaskOutputFile(file: string, providerTaskId: string | undefined, roots = claudeTempRoots()): string | undefined {
  if (!providerTaskId || !path.isAbsolute(file)) return undefined;
  if (path.basename(file) !== `${providerTaskId}.output` || path.basename(path.dirname(file)) !== "tasks") return undefined;
  let dir: string;
  try {
    dir = fs.realpathSync(path.dirname(file));
  } catch {
    // The directory is gone with the file: answerable, as missing, only if the
    // stated path is lexically under a root.
    dir = path.resolve(path.dirname(file));
  }
  if (!roots.some((root) => dir.startsWith(root + path.sep))) return undefined;
  const resolved = path.join(dir, path.basename(file));
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) return undefined;
  } catch {
    // Missing — see above.
  }
  return resolved;
}

/** Bytes at the end of `buffer` that start a character the buffer does not
 *  finish, so a read never splits a UTF-8 sequence across two pages. */
function incompleteTail(buffer: Buffer): number {
  for (let back = 1; back <= Math.min(3, buffer.length); back += 1) {
    const byte = buffer[buffer.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return width > back ? back : 0;
  }
  return 0;
}

/**
 * One page of a log from byte `after`. With no `after` — or one past the end,
 * which means the file was rewritten — the read starts at the tail, on a line
 * boundary.
 */
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
      // Mid-line and possibly mid-character: begin at the next whole line.
      const newline = page.indexOf(10);
      skipped = newline >= 0 ? newline + 1 : 0;
      page = page.subarray(skipped);
    }
    page = page.subarray(0, page.length - incompleteTail(page));
    const cursor = start + skipped + page.length;
    // "More" is bytes past what this read reached, not the half character held
    // back above — asking again at once for that would spin until it lands.
    return { text: page.toString("utf8"), cursor, size, truncated: start > 0 && fresh, more: start + bytesRead < size, missing: false };
  } finally {
    await handle.close();
  }
}
