import fs from "node:fs";
import path from "node:path";
import { SCRATCH_ROOT } from "./paths";

export type RunState = {
  runId: string;
  createdAt: number;
  runDir: string;
  projectRoot: string;
  telarHome: string;
  projectName: string;        // === runId; the registry key
  webServerPort: number;      // the harness-owned Telar web (apps/web) port
  webServerPid: number | null;// detached process-group leader pid
  webServerLog: string;
  loomId: string | null;      // set by run()
  keep: boolean;
};

export function writeRunState(s: RunState): void {
  fs.mkdirSync(path.dirname(s.runDir === SCRATCH_ROOT ? s.runDir : path.join(s.runDir, ".")), { recursive: true });
  fs.mkdirSync(s.runDir, { recursive: true });
  fs.writeFileSync(path.join(s.runDir, "run-state.json"), JSON.stringify(s, null, 2));
}

export function readRunState(runDir: string): RunState {
  return JSON.parse(fs.readFileSync(path.join(runDir, "run-state.json"), "utf8"));
}

// Standalone-teardown convenience: newest run dir under SCRATCH_ROOT.
export function findLatestRunDir(): string | null {
  let entries: string[];
  try { entries = fs.readdirSync(SCRATCH_ROOT); } catch { return null; }
  const dirs = entries
    .map((n) => path.join(SCRATCH_ROOT, n))
    .filter((p) => { try { return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "run-state.json")); } catch { return false; } })
    .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return dirs.length ? dirs[0].p : null;
}
