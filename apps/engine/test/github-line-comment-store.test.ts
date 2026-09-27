/**
 * A NEW REVIEW THREAD, THROUGH THE STORE — #1014.
 *
 * The half only the store can answer: the pull request is the session branch's,
 * looked up again from the record, and the commit the surface anchored to must
 * still be the checkout's HEAD and the pull request's head. Real repositories in
 * temp directories; `gh` is a spy that answers from fixtures and never reaches
 * GitHub. Harness as `git-push-store.test.ts`.
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
  const root = tmp("telar-linecomment-repo-");
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "test@telar.local");
  run(root, "config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "a.ts"), "one\n");
  run(root, "add", "-A");
  run(root, "commit", "-qm", "initial");
  return root;
}

/** Polls a real `git worktree add` the store runs in the background, as the push
 *  store test does — there is no fake clock that could stand in for it. */
async function until(predicate: () => boolean, budgetMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

const ok = (stdout: string): GhResult => ({ status: 0, stdout, stderr: "" });

async function withSession(pullHead: (cwd: string) => string) {
  const engineRoot = tmp("telar-linecomment-home-");
  const calls: string[][] = [];
  let cwd = "";
  const store = new EngineStore(engineRoot, () => Date.now(), {
    gh: async (_cwd, args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list") {
        return ok(JSON.stringify([{ number: 7, url: "https://github.com/o/r/pull/7", headRefOid: pullHead(cwd), baseRefName: "main" }]));
      }
      if (args[0] === "api" && args[1] === "--paginate") return ok(`${JSON.stringify(["a.ts", "@@ -1 +1,2 @@\n one\n+two"])}\n`);
      if (args[0] === "api" && args[1] === "-X") return ok(JSON.stringify({ html_url: "https://github.com/o/r/pull/7#discussion_r1" }));
      return { status: 1, stdout: "", stderr: "unexpected call" };
    },
  });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "One", root: repo() });
  store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });
  const workspace = () => store.getSession("session_one").workspace;
  expect(await until(() => workspace().mode === "worktree" && fs.existsSync((workspace() as { path: string }).path))).toBe(true);
  cwd = (workspace() as { path: string }).path;
  fs.appendFileSync(path.join(cwd, "a.ts"), "two\n");
  run(cwd, "commit", "-qam", "two");
  return { store, calls, cwd, head: run(cwd, "rev-parse", "HEAD").trim() };
}

const headOf = (cwd: string) => run(cwd, "rev-parse", "HEAD").trim();

test("the anchor carries the branch's pull request, the checkout's HEAD and GitHub's hunks", async () => {
  const { store, head } = await withSession(headOf);
  const anchor = await store.sessionPullAnchor("session_one");
  expect(anchor).toEqual({
    pull: { number: 7, url: "https://github.com/o/r/pull/7", headRefOid: head, baseRefName: "main" },
    head,
    dirty: [],
    files: [{ path: "a.ts", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }] }],
  });
});

test("a comment goes to the branch's own pull request, pinned to the head", async () => {
  const { store, calls, head } = await withSession(headOf);
  const result = await store.sessionPullLineComment("session_one", { commitId: head, path: "a.ts", line: 2, side: "RIGHT", body: "Why?" });
  expect(result).toEqual({ commented: true, url: "https://github.com/o/r/pull/7#discussion_r1" });
  const post = calls.find((args) => args[1] === "-X")!;
  expect(post).toContain("repos/{owner}/{repo}/pulls/7/comments");
  expect(post).toContain(`commit_id=${head}`);
});

test("a pull request whose head is not the checkout's is `stale`, and nothing is posted", async () => {
  const { store, calls, head } = await withSession(() => "b".repeat(40));
  const result = await store.sessionPullLineComment("session_one", { commitId: head, path: "a.ts", line: 2, side: "RIGHT", body: "Why?" });
  expect(result).toMatchObject({ commented: false, refusal: "stale" });
  expect(calls.some((args) => args[1] === "-X")).toBe(false);
});

test("a file with uncommitted changes is `stale`, and nothing is posted", async () => {
  const { store, calls, cwd, head } = await withSession(headOf);
  fs.appendFileSync(path.join(cwd, "a.ts"), "three\n");
  expect((await store.sessionPullAnchor("session_one")).dirty).toEqual(["a.ts"]);
  const result = await store.sessionPullLineComment("session_one", { commitId: head, path: "a.ts", line: 2, side: "RIGHT", body: "Why?" });
  expect(result).toMatchObject({ commented: false, refusal: "stale" });
  expect(calls.some((args) => args[1] === "-X")).toBe(false);
});
