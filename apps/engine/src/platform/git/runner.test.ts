import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createAsyncGitRunner, defaultAsyncGitRunner, createGitRunner, DEFAULT_GIT_TIMEOUT_MS, defaultGitRunner, GIT_TIMEOUT_STATUS } from "./runner";
import { tmp, removeTmp, until, repo } from "../../../test/worktree-fixtures";

afterEach(removeTmp);

function stalledGit(): { bin: string } {
  const dir = tmp("telar-stalled-git-");
  const bin = path.join(dir, "git");
  fs.writeFileSync(bin, "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 });
  return { bin };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a git child that stalls is reported as timed out at its bound, not waited on forever", () => {
  const { bin } = stalledGit();
  // 250 ms, where it used to be 1,500: nothing in this test depends on the child
  // having reached its first line, because the bound is on the PARENT's wait.
  const git = createGitRunner({ gitBin: bin, defaultTimeoutMs: 250 });
  const started = Date.now();
  const result = git("/tmp", ["rev-parse", "--abbrev-ref", "HEAD"]);
  expect(result.timedOut).toBe(true);
  expect(result.status).toBe(GIT_TIMEOUT_STATUS);
  expect(result.stderr).toContain("did not finish within 250ms");
  // The fake sleeps for ten minutes, so this bounds a hang rather than measuring
  // the bound: twenty times the budget, compared against nothing (#706).
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("and the child itself is killed, not left behind once the runner has given up", () => {
  const { bin } = stalledGit();
  const git = createGitRunner({ gitBin: bin, defaultTimeoutMs: 2_000 });
  const result = git("/tmp", ["rev-parse", "--abbrev-ref", "HEAD"]);
  expect(result.timedOut).toBe(true);
  // Reported by the runner, which spawned it — not written by the child, which
  // may never have run a line. `spawnSync` reaps what it kills before returning,
  // so by here the process is either gone or was never anything to begin with.
  const killed = result.killedPid;
  expect(killed).toBeGreaterThan(0);
  expect(alive(killed as number)).toBe(false);
  // And the pid is in the message, where a log that says which process it killed
  // is worth more than one that says it killed something.
  expect(result.stderr).toContain(`(pid ${killed})`);
});

test("a per-call bound wins over the runner's default", () => {
  const { bin } = stalledGit();
  const git = createGitRunner({ gitBin: bin, defaultTimeoutMs: 60_000 });
  const started = Date.now();
  expect(git("/tmp", ["status"], { timeoutMs: 200 }).timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("an ordinary failure is still an ordinary failure, and the default runner is bounded", () => {
  const unversioned = tmp("telar-not-a-repo-");
  const result = defaultGitRunner(unversioned, ["rev-parse", "--abbrev-ref", "HEAD"]);
  expect(result.status).not.toBe(0);
  expect(result.timedOut).toBeUndefined();
  expect(result.stderr).toContain("not a git repository");
  expect(DEFAULT_GIT_TIMEOUT_MS).toBeGreaterThan(0);
});

test("async git deadlines do not block timers and missing binaries return failures", async () => {
  const run = createAsyncGitRunner({ gitBin: process.execPath, defaultTimeoutMs: 150 });
  let heartbeat = false;
  const tick = setTimeout(() => { heartbeat = true; }, 10);
  const result = await run(process.cwd(), ["-e", "setTimeout(() => {}, 60000)"]);
  clearTimeout(tick);
  expect(heartbeat).toBe(true);
  expect(result.status).toBe(GIT_TIMEOUT_STATUS);
  expect(result.timedOut).toBe(true);
  const missing = await createAsyncGitRunner({ gitBin: "/nonexistent/telar-git" })(process.cwd(), []);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).not.toBe("");
});

test("async git pool expires queued reads without spawning them and recovers capacity", async () => {
  const root = tmp("telar-git-pool-");
  const marker = path.join(root, "should-not-run");
  const run = createAsyncGitRunner({ gitBin: process.execPath, concurrency: 1 });
  const stalled = run(root, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 250 });
  const queued = run(
    root,
    ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    { timeoutMs: 30_000, admissionMs: 50 },
  );
  expect((await queued).timedOut).toBe(true);
  expect((await queued).killedPid).toBeUndefined();
  expect(fs.existsSync(marker)).toBe(false);
  expect((await stalled).timedOut).toBe(true);
  const recovered = await run(root, ["-e", "process.stdout.write('ready')"], { timeoutMs: 10_000 });
  expect(recovered).toEqual({ status: 0, stdout: "ready", stderr: "" });
  expect(fs.existsSync(marker)).toBe(false);
});

test("a timed-out read frees its slot while its child's helper still holds the pipe", async () => {
  const root = tmp("telar-git-release-");
  const pidFile = path.join(root, "helper.pid");
  const script = `
    const { spawn } = require("node:child_process");
    const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit", detached: true });
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
    setTimeout(() => {}, 30000);
  `;
  const run = createAsyncGitRunner({ gitBin: process.execPath, concurrency: 1 });
  const stalled = run(root, ["-e", script], { timeoutMs: 2_000 });
  // The helper has to be up BEFORE the deadline is allowed to mean anything —
  // see `until`. Its own bound, and a loud failure rather than an `ENOENT`.
  expect(await until(() => fs.existsSync(pidFile), 1_500)).toBe(true);
  expect((await stalled).timedOut).toBe(true);

  const helper = Number(fs.readFileSync(pidFile, "utf8"));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    // The premise: the pipe is still held, so the pre-#743 release has not run.
    expect(alive(helper)).toBe(true);
    const recovered = await run(root, ["-e", "process.stdout.write('ready')"], { timeoutMs: 10_000 });
    expect(recovered).toEqual({ status: 0, stdout: "ready", stderr: "" });
    expect(alive(helper)).toBe(true);
  } finally {
    // Reap what this test spawned; nothing of it outlives the test.
    try { process.kill(helper, "SIGKILL"); } catch { /* already gone */ }
  }
}, 20_000);

test("a timed-out read reaps the helper git spawned, not only git", async () => {
  const root = tmp("telar-git-group-");
  const pidFile = path.join(root, "helpers.pid");
  const filterPidFile = path.join(root, "filters.pid");
  const filter = path.join(root, "slow-clean.sh");
  fs.writeFileSync(filter, `#!/bin/sh
sleep 30 </dev/null >/dev/null &
echo $! >> ${JSON.stringify(pidFile)}
echo $$ >> ${JSON.stringify(filterPidFile)}
wait
`);
  fs.chmodSync(filter, 0o755);

  const projectRoot = repo();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // Local `false` beats whatever the machine running this has globally: an
  // fsmonitor daemon is a long-running process and this test starts none.
  git("config", "core.fsmonitor", "false");
  git("config", "filter.slow.clean", filter);
  fs.writeFileSync(path.join(projectRoot, ".gitattributes"), "README.md filter=slow\n");
  fs.writeFileSync(path.join(projectRoot, "README.md"), "hello\nchanged\n");

  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const readPids = (file: string) =>
    (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);

  const run = createAsyncGitRunner({ concurrency: 1 });
  const timedOut = run(projectRoot, ["diff", "-z", "--numstat"], { timeoutMs: 5_000 });
  try {
    // Non-vacuity: a count the "the deadline beat the filter" state cannot
    // produce. The helper's own bound, never the read's — see `until`.
    expect(await until(() => readPids(pidFile).length > 0, 4_500)).toBe(true);

    const result = await timedOut;
    expect(result.timedOut).toBe(true);
    expect(result.killedPid).toBeGreaterThan(0);

    // A SIGKILLed process answers `kill(pid, 0)` until init reaps the zombie, so
    // this is a bound rather than an instant.
    const helpers = readPids(pidFile);
    await until(() => helpers.every(pid => !alive(pid)), 5_000);
    expect(helpers.filter(alive)).toEqual([]);
  } finally {
    await timedOut;
    // Both files, so a run where nothing was reaped still leaves nothing behind.
    for (const pid of [...readPids(pidFile), ...readPids(filterPidFile)]) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
}, 30_000);

test("the shared async runner is a bounded runner like any other", async () => {
  const unversioned = tmp("telar-shared-async-");
  const result = await defaultAsyncGitRunner(unversioned, ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 10_000 });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("not a git repository");
  expect(result.timedOut).toBeUndefined();
});

test("a starved call fails on its admission bound without ever spawning", async () => {
  const root = tmp("telar-git-admission-");
  const marker = path.join(root, "second-ran");
  const run = createAsyncGitRunner({ gitBin: process.execPath, concurrency: 1 });
  const holder = run(root, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 1_500 });
  const queued = await run(
    root,
    ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    // A run budget far LARGER than the admission bound, so a pass cannot come
    // from the old behaviour: under the pre-#813 runner this call would have
    // sat in the queue for its full 30 s and this test would time out.
    { timeoutMs: 30_000, admissionMs: 100 },
  );
  expect(queued.timedOut).toBe(true);
  // The wait is named, and the kill is not — there was no child to kill, and
  // saying "was killed" about one is what made #813's two failure modes
  // indistinguishable in `preparation.error`.
  expect(queued.stderr).toContain("waited 100ms for a slot and never started");
  expect(queued.stderr).not.toContain("was killed");
  expect(queued.killedPid).toBeUndefined();
  expect(fs.existsSync(marker)).toBe(false);
  expect((await holder).timedOut).toBe(true);
}, 10_000);

test("a call held behind two occupied slots still gets its whole run budget", async () => {
  const root = tmp("telar-git-spawn-deadline-");
  const marker = path.join(root, "third-ran");
  const run = createAsyncGitRunner({ gitBin: process.execPath, concurrency: 1 });
  const first = run(root, ["-e", "setTimeout(() => {}, 1500)"], { timeoutMs: 20_000 });
  const second = run(root, ["-e", "setTimeout(() => {}, 1500)"], { timeoutMs: 20_000 });
  const third = run(
    root,
    ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('ready')`],
    { timeoutMs: 1_200, admissionMs: 10_000 },
  );

  const [a, b, c] = await Promise.all([first, second, third]);
  // Non-vacuity: the two ahead of it must have RUN, not expired — otherwise
  // the third was never queued and the test proves nothing.
  expect(a.status).toBe(0);
  expect(b.status).toBe(0);
  expect(c.timedOut).toBeUndefined();
  expect(c.status).toBe(0);
  expect(c.stdout).toBe("ready");
  expect(fs.existsSync(marker)).toBe(true);
}, 15_000);

test("a call that spawns and then hangs is killed at its run deadline and reports the pid", async () => {
  const root = tmp("telar-git-spawn-kill-");
  const run = createAsyncGitRunner({ gitBin: process.execPath, concurrency: 1 });
  const hung = await run(root, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 400, admissionMs: 10_000 });
  expect(hung.timedOut).toBe(true);
  expect(hung.status).toBe(GIT_TIMEOUT_STATUS);
  expect(hung.killedPid).toBeGreaterThan(0);
  expect(hung.stderr).toContain(`(pid ${hung.killedPid})`);
  expect(hung.stderr).toContain("did not finish within 400ms");
  // The group is gone, not merely abandoned. A SIGKILLed process answers
  // `kill(pid, 0)` until it is reaped, so this is a bound rather than an instant.
  await until(() => !alive(hung.killedPid as number), 5_000);
  expect(alive(hung.killedPid as number)).toBe(false);
}, 15_000);
