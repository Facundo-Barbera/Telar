import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

// This file lives at <repo>/scripts/e2e/greenfield-next/lib/paths.ts
export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
export const WEB_DIR = path.join(REPO_ROOT, "apps", "web");

// All harness tmp state lives here and NOWHERE else.
export const SCRATCH_ROOT = path.join(os.tmpdir(), "telar-e2e-greenfield-next");

const RUN_ID_RE = /^wt_[0-9a-z]+_[0-9a-f]{6}$/;

export function newRunId(): string {
  return `wt_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

export function runPaths(runId: string) {
  const runDir = path.join(SCRATCH_ROOT, runId);
  return {
    runDir,
    projectRoot: path.join(runDir, "project"),
    telarHome: path.join(runDir, ".telar-home"),
    runStateFile: path.join(runDir, "run-state.json"),
    webServerLog: path.join(runDir, "web-server.log"),
  };
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

// Hard guard: refuse to remove anything that is not a run dir under SCRATCH_ROOT.
export function assertScopedRunDir(runDir: string): void {
  const rd = path.resolve(runDir);
  const root = path.resolve(SCRATCH_ROOT);
  if (rd === root) throw new Error(`refusing to remove scratch root itself: ${rd}`);
  if (!rd.startsWith(root + path.sep)) throw new Error(`runDir escapes scratch root: ${rd}`);
  if (!RUN_ID_RE.test(path.basename(rd))) throw new Error(`runDir basename is not a run id: ${rd}`);
}
