/**
 * RELEASED WORKTREES — the checkout goes, the branch and the conversation
 * stay, and the next message brings the checkout back (`worktree-release.ts`).
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { checkoutsWithProcesses } from "../src/worktree-release";
import { until } from "./wait";
import { worktreeReady } from "./worktree-ready";

const roots: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(directory);
  return directory;
};
const children: { kill: () => void }[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A project with an `origin`, so "unpushed" has something to be measured against. */
function project(): string {
  const origin = tmp("telar-release-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  const root = tmp("telar-release-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@telar.local");
  git(root, "config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main");
  return root;
}

async function worktreeSession() {
  const root = project();
  const home = tmp("telar-release-home-");
  fs.writeFileSync(path.join(home, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  const store = new EngineStore(home, () => Date.now());
  store.registerProject({ id: "project_one", name: "One", root });
  const session = store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });
  await worktreeReady(store, "session_one");
  if (session.workspace.mode !== "worktree") throw new Error("expected a worktree");
  const checkout = session.workspace.path;
  git(checkout, "config", "user.email", "test@telar.local");
  git(checkout, "config", "user.name", "Telar Test");
  return { store, root, checkout, branch: session.workspace.branch };
}

test("release deletes the checkout and keeps the branch; the next message brings it back at the same path", async () => {
  const { store, root, checkout, branch } = await worktreeSession();
  fs.writeFileSync(path.join(checkout, "work.txt"), "done\n");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-qm", "work");
  git(checkout, "push", "-q", "origin", branch);

  expect(await store.releaseSessionWorktree("session_one", "manual")).toEqual({ ok: true });
  expect(fs.existsSync(checkout)).toBe(false);
  const released = store.getSession("session_one");
  expect(released.workspace.mode === "worktree" && released.workspace.released?.reason).toBe("manual");
  expect(git(root, "branch", "--list", branch)).toContain(branch);

  store.submitTurn("session_one", { runId: "run_back", input: "carry on" });
  // Waiting on the checkout, never on a missing directory.
  expect(store.getSession("session_one").preparation?.state).toBe("preparing");
  await worktreeReady(store, "session_one");

  const back = store.getSession("session_one");
  expect(back.preparation).toBeUndefined();
  expect(back.workspace.mode === "worktree" && back.workspace.released).toBeUndefined();
  expect(fs.readFileSync(path.join(checkout, "work.txt"), "utf8")).toBe("done\n");
  expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(branch);
});

test("uncommitted changes refuse the release and nothing is touched", async () => {
  const { store, checkout } = await worktreeSession();
  fs.writeFileSync(path.join(checkout, "README.md"), "edited\n");
  expect(await store.releaseSessionWorktree("session_one", "manual")).toMatchObject({ ok: false, refusal: "dirty" });
  expect(fs.readFileSync(path.join(checkout, "README.md"), "utf8")).toBe("edited\n");
});

test("commits on no remote refuse the release", async () => {
  const { store, checkout } = await worktreeSession();
  fs.writeFileSync(path.join(checkout, "local.txt"), "only here\n");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-qm", "local only");
  expect(await store.releaseSessionWorktree("session_one", "manual")).toMatchObject({ ok: false, refusal: "unpushed" });
  expect(fs.existsSync(checkout)).toBe(true);
});

test("a turn in flight refuses the release", async () => {
  const { store, checkout } = await worktreeSession();
  store.submitTurn("session_one", { runId: "run_busy", input: "working" });
  expect(await store.releaseSessionWorktree("session_one", "manual")).toMatchObject({ ok: false, refusal: "in-use" });
  expect(fs.existsSync(checkout)).toBe(true);
});

test.if(process.platform !== "win32")("a live process in the checkout refuses the release", async () => {
  const { store, checkout } = await worktreeSession();
  const child = spawn("/bin/sh", ["-c", "read line"], { cwd: checkout, stdio: ["pipe", "ignore", "ignore"] });
  children.push({ kill: () => child.kill("SIGKILL") });
  const listed = await checkoutsWithProcesses([checkout]);
  // No lsof on this machine: the manual press cannot see it, and says nothing.
  if (listed === undefined) return;
  await until("the process is visible", async () => (await checkoutsWithProcesses([checkout]))?.has(checkout) === true);
  expect(await store.releaseSessionWorktree("session_one", "manual")).toMatchObject({ ok: false, refusal: "process" });
  expect(fs.existsSync(checkout)).toBe(true);
});

test("the automatic caller stands down when the platform cannot say what runs where", async () => {
  expect(await checkoutsWithProcesses(["/a"], { platform: "win32" })).toBeUndefined();
  expect(await checkoutsWithProcesses(["/a"], { platform: "linux", lsof: async () => undefined })).toBeUndefined();
  expect(await checkoutsWithProcesses(["/a", "/b"], { platform: "darwin", lsof: async () => "p1\nn/a/sub\np2\nn/bb\n" })).toEqual(
    new Set(["/a"]),
  );
});

test("a restored checkout runs the project's setup in the background", async () => {
  const { store, checkout, branch } = await worktreeSession();
  git(checkout, "push", "-q", "origin", branch);
  store.workspace.setOverrides("project_one", { setup: { command: "echo prepared > .setup-marker" } });
  expect(await store.releaseSessionWorktree("session_one", "manual")).toEqual({ ok: true });

  store.restoreSessionWorktree("session_one");
  await worktreeReady(store, "session_one");
  await until("setup ran", async () => store.setups.status("session_one")?.state === "succeeded");
  expect(fs.readFileSync(path.join(checkout, ".setup-marker"), "utf8").trim()).toBe("prepared");
  expect(store.setups.output("session_one").lines.map((line) => line.text)).toContain("$ echo prepared > .setup-marker");
});

test("reclaim releases a settled session's checkout by default and archives only when asked", async () => {
  const { store, checkout, branch } = await worktreeSession();
  git(checkout, "push", "-q", "origin", branch);
  // Settled: pinned onto the shelf.
  store.updateSession("session_one", { settledOverride: "settled" });
  const [released] = await store.reclaimWorktrees([{ path: checkout }]);
  expect(released).toMatchObject({ ok: true, action: "released", sessionId: "session_one" });
  const session = store.getSession("session_one");
  expect(session.state).not.toBe("archived");
  expect(session.workspace.mode === "worktree" && session.workspace.released?.reason).toBe("manual");
});
