import fs from "node:fs";
import child_process from "node:child_process";
import { type RunState, readRunState, findLatestRunDir } from "./lib/runState";
import { assertScopedRunDir } from "./lib/paths";

// Surgical, scoped cleanup driven ENTIRELY off run-state. Touches only this
// run's own loom/project/registry/dir/server/port — never a shared tree.
export async function teardown(state: RunState): Promise<void> {
  // 1. best-effort stop the loom (meaningful only in the orchestrator's own
  //    process, which holds the in-memory AbortController). Standalone => no-op.
  process.env.TELAR_HOME = state.telarHome;
  if (state.loomId) {
    try {
      const { cancelLoom } = await import("@telar/core");
      cancelLoom(state.loomId);
    } catch {
      // no in-memory controller in a standalone process — harmless.
    }
    // let in-flight executors/panels run their finally { server.stop() } and
    // tear down any ephemeral under-test dev server.
    await sleep(3000);
  }

  // 2. kill the harness-owned Telar web server — the port it owns, as a group.
  if (state.webServerPid) {
    try { process.kill(-state.webServerPid, "SIGTERM"); } catch {}
    await sleep(2000);
    try { process.kill(-state.webServerPid, "SIGKILL"); } catch {} // ESRCH if already gone
  }
  // Port-scoped fallback: only this run's OWN port (never 3131).
  killByOwnedPort(state.webServerPort);

  // 3. the single scoped fs.rm — deletes project, telar.yaml, .telar-home
  //    (registry + all loom dirs incl. weave children + accounts.json),
  //    run-state.json, web-server.log. Guarded so it can only ever remove a
  //    wt_* run dir under SCRATCH_ROOT.
  assertScopedRunDir(state.runDir);
  fs.rmSync(state.runDir, { recursive: true, force: true });
}

// Kill only pids LISTENing on this run's unique port. Uses kill, not rm.
function killByOwnedPort(port: number): void {
  if (!port) return;
  let out: string;
  try {
    out = child_process
      .execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .trim();
  } catch {
    return; // lsof missing or nothing bound
  }
  if (!out) return;
  for (const tok of out.split(/\s+/)) {
    const pid = Number(tok);
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Standalone: resolve target run dir from --run / TELAR_E2E_RUN_DIR / newest.
if (import.meta.main) {
  (async () => {
    const i = process.argv.indexOf("--run");
    const runDir = i !== -1 ? process.argv[i + 1] : (process.env.TELAR_E2E_RUN_DIR ?? findLatestRunDir());
    if (!runDir) {
      console.log("no run dir found — nothing to tear down");
      process.exit(0);
    }
    const state = readRunState(runDir);
    await teardown(state);
    console.log("removed:      " + state.runDir);
    console.log("killed server: pid=" + state.webServerPid + " port=" + state.webServerPort);
    process.exit(0);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
