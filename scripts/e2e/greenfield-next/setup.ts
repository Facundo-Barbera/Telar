import fs from "node:fs";
import child_process from "node:child_process";
import { WEB_DIR, newRunId, runPaths, findFreePort } from "./lib/paths";
import { type RunState, writeRunState } from "./lib/runState";
import { buildManifest } from "./spec";

// Creates a fully isolated tmp project + registry (its own TELAR_HOME), starts
// a harness-owned Telar web server on a unique port, and persists run-state.
export async function setup(opts: { keep: boolean; ui: boolean }): Promise<RunState> {
  // 1. unique identity — the four axes that make runs never collide.
  const runId = newRunId();
  const p = runPaths(runId);
  const projectName = runId;
  const webServerPort = opts.ui ? await findFreePort() : 0;

  // 2. isolation env FIRST — every @telar/core call below evaluates telarDir()
  //    against this per-run root. Core is dynamically imported after this line.
  process.env.TELAR_HOME = p.telarHome;

  // 3. dirs
  fs.mkdirSync(p.projectRoot, { recursive: true });
  fs.mkdirSync(p.telarHome, { recursive: true });

  // 4. register the project in-process (also scaffolds telar.yaml). Fresh unique
  //    dir => createProject's "refuse if telar.yaml exists" can never trip.
  const { createProject } = await import("@telar/core");
  createProject(p.projectRoot, buildManifest(projectName, p.projectRoot));

  // 5. git init + baseline commit, SCOPED to the tmp project only (cwd is the
  //    isolated project root; `add -A` is safe here). Failure is non-fatal.
  try {
    const git = (args: string[]) =>
      child_process.execFileSync("git", args, { cwd: p.projectRoot, stdio: "ignore" });
    git(["init", "-q"]);
    git(["-c", "user.name=telar-e2e", "-c", "user.email=telar-e2e@local", "add", "-A"]);
    git(["-c", "user.name=telar-e2e", "-c", "user.email=telar-e2e@local", "commit", "-q", "-m", "chore: telar e2e baseline"]);
  } catch {
    // empty non-git root is a valid project root — carry on.
  }

  // 6. optionally start the harness-owned Telar web UI server. HEADLESS by
  //    default: Next 16 refuses a 2nd `next dev` for apps/web while another is
  //    already running (e.g. your cockpit on :3131), so the browser UI is
  //    opt-in (--ui). The loom runs + is monitored in-process either way
  //    (watch.ts polls getLoom directly). Detached => own process group =>
  //    killable as -pid at teardown.
  let webServerPid: number | null = null;
  if (opts.ui) {
    const out = fs.openSync(p.webServerLog, "a");
    const child = child_process.spawn(
      "bun",
      ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(webServerPort)],
      {
        cwd: WEB_DIR,
        env: { ...process.env, TELAR_HOME: p.telarHome, PORT: String(webServerPort) },
        detached: true,
        stdio: ["ignore", out, out],
      },
    );
    child.unref();
    webServerPid = child.pid ?? null;
  }

  // 7. assemble + persist RunState BEFORE any readiness wait, so a --ui server
  //    that fails to bind is still recoverable via `teardown.ts --run <dir>`.
  const state: RunState = {
    runId,
    createdAt: Date.now(),
    runDir: p.runDir,
    projectRoot: p.projectRoot,
    telarHome: p.telarHome,
    projectName,
    webServerPort,
    webServerPid,
    webServerLog: p.webServerLog,
    loomId: null,
    keep: opts.keep,
  };
  writeRunState(state);

  // 8. wait for the UI server to answer only when one was started (max ~120s).
  if (opts.ui) await waitForServer(webServerPort, 120_000);

  // 9. return
  return state;
}

async function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/projects`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // server not up yet
    }
    await sleep(1000);
  }
  throw new Error(`web server did not become ready on port ${port} within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Standalone: create the isolated project + server, print coordinates, exit.
// The detached+unref'd server keeps running after this process exits.
if (import.meta.main) {
  setup({ keep: true })
    .then((s) => {
      console.log("runDir:      " + s.runDir);
      console.log("projectName: " + s.projectName);
      console.log("webPort:     " + s.webServerPort);
      console.log("watch base:  http://127.0.0.1:" + s.webServerPort);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
