/**
 * PUBLISHING, THROUGH THE STORE — issue #670.
 *
 * `git-push.test.ts` proves the git sequence and every refusal against a spy
 * runner. This is the half only the store can answer, and it is the half that
 * makes the feature safe rather than merely working: **the branch, the checkout
 * and the remote are the store's to know.** A request body that could name a
 * branch could ask this engine to push any ref in any repository on the machine.
 *
 * NO TEST IN THIS FILE RUNS `git push`. Every repository here is a real one in a
 * temp directory with no remote host anywhere; the two cases that need
 * `origin/<branch>` to exist create the remote-tracking ref with `update-ref`,
 * which is a local ref write and not a push. The `gh` runner is a spy that
 * records and answers, and the load-bearing assertion for a refusal decided
 * from data is that its call list is EMPTY.
 *
 * THROUGH `EngineStore` RATHER THAN THE DAEMON, the way every other
 * worktree-session test here works: the cut happens in the store, and the HTTP
 * layer above is a route that calls the method and serialises the answer.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import type { GhResult } from "../src/github";

const made: string[] = [];
const stores: EngineStore[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(directory);
  return directory;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close?.();
  for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repo(): string {
  const root = tmp("telar-pushstore-repo-");
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "test@telar.local");
  run(root, "config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  run(root, "add", "-A");
  run(root, "commit", "-qm", "initial");
  return root;
}

async function until(predicate: () => boolean, budgetMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

const CREATED: GhResult = { status: 0, stdout: "https://example.invalid/owner/repo/pull/812\n", stderr: "" };

/** A store with one project and, by default, one worktree session whose checkout
 *  has landed. The `gh` runner records every argv it is handed. */
async function withSession(options: { envMode?: "local" | "worktree"; gh?: GhResult } = {}) {
  const engineRoot = tmp("telar-pushstore-home-");
  const projectRoot = repo();
  const calls: string[][] = [];
  const store = new EngineStore(engineRoot, () => Date.now(), {
    gh: async (_cwd, args) => {
      calls.push(args);
      return options.gh ?? CREATED;
    },
  });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  const envMode = options.envMode ?? "worktree";
  store.createSession({ id: "session_one", projectId: "project_one", envMode });
  const workspace = () => store.getSession("session_one").workspace;
  if (envMode === "worktree") {
    expect(await until(() => workspace().mode === "worktree" && fs.existsSync((workspace() as { path: string }).path))).toBe(true);
  }
  const live = workspace();
  return {
    store,
    calls,
    projectRoot,
    cwd: live.mode === "none" ? "" : live.path,
    branch: live.mode === "worktree" ? live.branch : "",
  };
}

/** Point the project at a bare repository that is never contacted, so `origin`
 *  exists as configuration without anything to push to. */
function addOrigin(projectRoot: string): string {
  const remote = path.join(tmp("telar-pushstore-remote-"), "remote.git");
  run(path.dirname(remote), "init", "-q", "--bare", "-b", "main", "remote.git");
  run(projectRoot, "remote", "add", "origin", remote);
  return remote;
}

/**
 * `refs/remotes/origin/<name>` WITHOUT A PUSH. This is what a checkout believes
 * about the remote, and believing it is all the engine's data-decided refusals
 * read — so a local ref write is a complete and honest fixture for "this branch
 * has been published", and it keeps this file's promise not to push.
 */
const believePushed = (cwd: string, name: string, at = "HEAD") => run(cwd, "update-ref", `refs/remotes/origin/${name}`, at);

test("a local session is refused without git being asked, and without gh being asked", async () => {
  const { store, calls } = await withSession({ envMode: "local" });

  const pushed = await store.pushSessionBranch("session_one");
  expect(pushed).toMatchObject({ pushed: false, refusal: "local_checkout" });

  const opened = await store.openSessionPullRequest("session_one", { title: "Anything" });
  expect(opened).toMatchObject({ opened: false, refusal: "not_pushed" });
  // A `local` session shares the PROJECT's checkout with the user's editor.
  // There is no session branch to publish, and nothing to look at to find that
  // out — so GitHub is not asked at all.
  expect(calls).toEqual([]);
});

test("a checkout with no origin is refused from data — nothing is pushed, and gh is not asked", async () => {
  const { store, calls, branch } = await withSession();
  expect(branch).not.toBe("");

  const pushed = await store.pushSessionBranch("session_one");
  expect(pushed).toMatchObject({ pushed: false, refusal: "no_remote" });

  const opened = await store.openSessionPullRequest("session_one", { title: "Anything" });
  expect(opened).toMatchObject({ opened: false, refusal: "failed" });
  expect(opened).toHaveProperty("message", "This checkout has no origin, so there is nowhere to push it.");
  expect(calls).toEqual([]);
});

test("A BRANCH THE REMOTE HAS NEVER SEEN CANNOT HAVE A PULL REQUEST, and GitHub is not asked whether it can", async () => {
  const { store, calls, projectRoot } = await withSession();
  addOrigin(projectRoot);

  const opened = await store.openSessionPullRequest("session_one", { title: "Anything" });
  expect(opened).toMatchObject({ opened: false, refusal: "not_pushed" });
  // The remedy is the OTHER arm, which is three centimetres away on the Diff
  // surface — and finding that out cost no round trip.
  expect(opened).toHaveProperty("message", expect.stringContaining("Push it first"));
  expect(calls).toEqual([]);
});

test("the pull request names the session's OWN branch, read off the record rather than the request", async () => {
  const { store, calls, projectRoot, cwd, branch } = await withSession();
  addOrigin(projectRoot);
  believePushed(cwd, branch);
  believePushed(cwd, "main", "main");

  const opened = await store.openSessionPullRequest("session_one", { title: "Push and PR creation", body: "Why." });
  expect(opened).toMatchObject({ opened: true, url: "https://example.invalid/owner/repo/pull/812", number: 812 });

  expect(calls).toHaveLength(1);
  const argv = calls[0]!;
  expect(argv.slice(0, 6)).toEqual(["pr", "create", "--head", branch, "--base", "main"]);
  // The base was DERIVED from the remote's own default branch, not supplied —
  // and the head is the session's, which no caller named.
  expect(argv[argv.indexOf("--title") + 1]).toBe("Push and PR creation");
  expect(argv[argv.indexOf("--body") + 1]).toContain("<!-- telar-session: session_one -->");
});

test("a base that is not a branch name never reaches an argv", async () => {
  const { store, calls, projectRoot, cwd, branch } = await withSession();
  addOrigin(projectRoot);
  believePushed(cwd, branch);

  // `gh` is spawned without a shell, so this is belt and braces — and the
  // braces are what keep a text field from becoming a command the day somebody
  // adds one.
  for (const base of ["--web", "-f", "main;rm -rf /", "$(whoami)", "../../etc/passwd"]) {
    await expect(store.openSessionPullRequest("session_one", { title: "x", base })).rejects.toThrow();
  }
  expect(calls).toEqual([]);
});

test("a base nobody named and nobody could derive is a refusal, not a guess", async () => {
  // No `origin/main` and no `origin/HEAD`, so there is no default branch to
  // read. Opening against a guess would be this engine choosing where somebody
  // else's work merges.
  const { store, calls, projectRoot, cwd, branch } = await withSession();
  addOrigin(projectRoot);
  believePushed(cwd, branch);

  const opened = await store.openSessionPullRequest("session_one", { title: "x" });
  expect(opened).toMatchObject({ opened: false, refusal: "failed" });
  expect(opened).toHaveProperty("message", expect.stringContaining("could not work out which branch"));
  expect(calls).toEqual([]);
});

test("a caller cannot push or open a pull request for a session that is not theirs to name", async () => {
  const { store } = await withSession();
  await expect(store.pushSessionBranch("session_missing")).rejects.toThrow();
  await expect(store.openSessionPullRequest("session_missing", { title: "x" })).rejects.toThrow();
});
