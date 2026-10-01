import { afterAll, afterEach, expect, mock, test } from "bun:test";
import realChildProcess from "node:child_process";
import realFs from "node:fs";
import path from "node:path";
import { engineHome, removeTmp, repo, tmp } from "../test/worktree-fixtures";
import { sessionMetadataFile, storedSession } from "./domains/sessions";
import { EngineStore } from "./state";

const SESSIONS = 5_000;
const SLOW_MS = 20;
const STALLED_CALLS = 100;
const BOOT_BUDGET_MS = 8_000;

const fsCalls: string[] = [];
const gitSpawns: string[] = [];
let slowRoot: string | undefined;

const underSlowRoot = (value: unknown): boolean =>
  slowRoot !== undefined && (typeof value === "string" || value instanceof URL || Buffer.isBuffer(value)) && String(value instanceof URL ? value.pathname : value).startsWith(slowRoot);

function stall(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until);
}

const originalFs = { ...realFs };
const slowFs: Record<string, unknown> = { ...originalFs };
for (const [name, value] of Object.entries(originalFs)) {
  if (!name.endsWith("Sync") || typeof value !== "function") continue;
  const fn = value as (...args: unknown[]) => unknown;
  slowFs[name] = Object.assign((...args: unknown[]) => {
    if (args.slice(0, 2).some(underSlowRoot)) {
      fsCalls.push(`${name} ${String(args[0])}`);
      if (fsCalls.length <= STALLED_CALLS) stall(SLOW_MS);
    }
    return fn(...args);
  }, fn);
}
mock.module("node:fs", () => ({ ...slowFs, default: slowFs }));

const originalChildProcess = { ...realChildProcess };
const watchedChildProcess: Record<string, unknown> = { ...originalChildProcess };
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"] as const) {
  const fn = originalChildProcess[name] as (...args: unknown[]) => unknown;
  watchedChildProcess[name] = Object.assign((...args: unknown[]) => {
    const [command, argv, options] = args as [string, unknown, { cwd?: unknown } | undefined];
    const cwd = (Array.isArray(argv) ? options : (argv as { cwd?: unknown } | undefined))?.cwd;
    const words = Array.isArray(argv) ? argv : [];
    if (/(^|\/)git$/.test(command) && [cwd, ...words].some(underSlowRoot)) gitSpawns.push([command, ...words].join(" "));
    return fn(...args);
  }, fn);
}
mock.module("node:child_process", () => ({ ...watchedChildProcess, default: watchedChildProcess }));

afterEach(removeTmp);
afterAll(() => {
  slowRoot = undefined;
});

function seedHistory(engineRoot: string, projectRoot: string, worktrees: string): void {
  const store = new EngineStore(engineRoot, () => 1_000, { git: () => ({ status: 128, stdout: "", stderr: "" }) });
  store.projectRegistry.register({ id: "project_one", name: "One", root: projectRoot });
  store.kernel.command("seed history", () => {
    for (let index = 0; index < SESSIONS; index += 1) {
      const id = `session_${index}`;
      const session = store.lifecycle.createSession({ id, projectId: "project_one" });
      const workspace = { mode: "worktree" as const, path: path.join(worktrees, id), branch: `telar/${id}`, baseRef: "main" };
      const shelved = index % 2 === 0 ? { state: "archived" as const } : { settledOverride: "settled" as const, settledAt: 1_000 };
      store.kernel.writeDocument(sessionMetadataFile(store.kernel.paths, id), storedSession({ ...session, workspace, ...shelved }));
    }
  });
  store.kernel.executionStore.close();
}

test(
  "an engine with 5,000 settled and archived worktree sessions on a slow volume boots without touching it",
  async () => {
    const engineRoot = engineHome("telar-scale-");
    const worktrees = tmp("telar-slow-volume-");
    seedHistory(engineRoot, repo(), worktrees);
    for (let index = 0; index < 50; index += 1) realFs.mkdirSync(path.join(worktrees, `session_${index}`, "node_modules"), { recursive: true });

    const { startEngine } = await import("./daemon");
    slowRoot = worktrees;
    const startedAt = performance.now();
    const daemon = await startEngine({ engineRoot, cleanupFirstDelayMs: 60 * 60_000, modelPrefetchDelayMs: null });
    try {
      const health = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/health`, { headers: { authorization: `Bearer ${daemon.discovery.token}` } });
      const servingMs = performance.now() - startedAt;
      await new Promise((resolve) => setImmediate(resolve));
      slowRoot = undefined;

      expect(health.status).toBe(200);
      expect({ syncFsCalls: fsCalls.length, examples: fsCalls.slice(0, 5) }).toEqual({ syncFsCalls: 0, examples: [] });
      expect({ gitSpawns: gitSpawns.length, examples: gitSpawns.slice(0, 5) }).toEqual({ gitSpawns: 0, examples: [] });
      expect(servingMs).toBeLessThan(BOOT_BUDGET_MS);
    } finally {
      slowRoot = undefined;
      await daemon.close();
    }
  },
  120_000,
);
