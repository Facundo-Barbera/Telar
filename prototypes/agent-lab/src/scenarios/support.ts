/**
 * WHAT EVERY SCENARIO SHARES: where a thread lives, how a restart is really a
 * restart, and how a result is printed so a test and a person read the same
 * thing.
 *
 * ── A RESTART IS A PROCESS, NOT A NEW OBJECT ────────────────────────────────
 * Three scenarios claim a thread survives the process going away. Building a
 * second agent object in the same process would prove only that a Map was still
 * in memory. `spawnResume` runs the SAME script again with `--resume`, through
 * `Bun.spawn`, and waits for it to exit — a real fork, a real reopen of the
 * sqlite file, real deserialisation of the checkpoint.
 *
 * ── AND IT EXITS WITH THE TEST ──────────────────────────────────────────────
 * The child is awaited, its output is captured, and a non-zero exit fails the
 * scenario loudly. Nothing here starts a server, a shell or a watcher; the only
 * child process any scenario creates is this one, and it is short-lived by
 * construction.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const LAB_ROOT = path.resolve(here, "../..");
export const THREADS_DIR = path.join(LAB_ROOT, ".threads");

/** A fresh sqlite file for one scenario run. Removed first, WAL and all: a
 *  thread left over from the last run would make "it resumed" meaningless. */
export function freshThreadFile(name: string): string {
  mkdirSync(THREADS_DIR, { recursive: true });
  const file = path.join(THREADS_DIR, `${name}.sqlite`);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
  return file;
}

export function threadFile(name: string): string {
  mkdirSync(THREADS_DIR, { recursive: true });
  return path.join(THREADS_DIR, `${name}.sqlite`);
}

/** This module's own file path. `new URL(import.meta.url).pathname` is NOT it:
 *  Telar's own directory has a space in it, and a percent-encoded path is a
 *  module Bun cannot find. */
export function scriptPath(importMetaUrl: string): string {
  return fileURLToPath(importMetaUrl);
}

export type ChildRun = { code: number; stdout: string; stderr: string };

/**
 * Run this scenario's own script again, in a new process, and wait for it.
 *
 * `bun run <script>` rather than a worker or a re-import: the point is a
 * process boundary, and anything that shares this heap is not one.
 */
export async function spawnResume(scriptPath: string, args: string[]): Promise<ChildRun> {
  const child = Bun.spawn(["bun", "run", scriptPath, ...args], {
    cwd: LAB_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TELAR_AGENT_LAB_CHILD: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

/** The one line a child prints for its parent to parse. Prefixed so a child's
 *  ordinary logging cannot be mistaken for its result. */
export const CHILD_RESULT = "@@RESULT@@";

export function emitChildResult(payload: unknown): void {
  console.log(`${CHILD_RESULT} ${JSON.stringify(payload)}`);
}

export function readChildResult<T>(run: ChildRun): T {
  const line = run.stdout.split("\n").find((one) => one.startsWith(CHILD_RESULT));
  if (!line) throw new Error(`the child printed no result.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  return JSON.parse(line.slice(CHILD_RESULT.length).trim()) as T;
}

/** Flags, parsed the small way. No dependency earns its place for this. */
export function flag(name: string, argv: string[] = process.argv.slice(2)): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return argv[index + 1] ?? "";
}

export function hasFlag(name: string, argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes(`--${name}`);
}

export function heading(text: string): void {
  console.log(`\n── ${text} ${"─".repeat(Math.max(0, 74 - text.length))}`);
}

/** A scenario's verdict, printed the same way by all seven. */
export function verdict(name: string, passed: boolean, notes: string[] = []): void {
  console.log(`\n[${passed ? "PASS" : "FAIL"}] ${name}`);
  for (const note of notes) console.log(`  · ${note}`);
  if (!passed) process.exitCode = 1;
}
