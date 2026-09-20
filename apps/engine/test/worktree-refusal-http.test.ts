/**
 * WHEN A WORKTREE CANNOT BE CUT, THE CALLER IS TOLD WHY — issue #695.
 *
 * `prepareSessionWorktree` writes its refusals as sentences for a person: the
 * drive that is not connected, the folder that is gone, the directory that is not
 * a repository, the branch name the engine will not create, the base ref that
 * does not resolve. Every one of them is raised ON THE REQUEST rather than left
 * for the row, on the stated grounds that the caller is still there to be told
 * (see worktree.ts's header on the #496 seam).
 *
 * AND THEN THE HTTP BOUNDARY THREW THEM AWAY. `WorktreeError` is neither an
 * `EngineStateError` nor a `ProjectNotesError`, so `errorFor` fell through to
 * `500 internal_error, "engine encountered an internal error"` — five careful
 * sentences replaced by one that says nothing, in front of the one gesture whose
 * whole promise is that it refuses with the reason (#695's row action). This file
 * pins the crossing, not the wording: each arm asserts the code a client can
 * branch on and the phrase the engine chose, so a reworded refusal stays a
 * refusal and a re-classified one fails here.
 *
 * THE UNMOUNTED ARM IS NOT HERE. It never reached `WorktreeError` over HTTP —
 * `assertProjectAvailable` refuses first with `conflict` — and
 * `projects-availability-http.test.ts` already pins that sentence. Asserting it
 * again here would pin the same behaviour to the wrong cause.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

/** A Claude default this temp home already knows, as every other suite's does. */
const home = (): string => {
  const directory = tmp("telar-wt-refusal-home-");
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

/** A throwaway repository with one commit, so `HEAD` resolves. */
const repo = (): string => {
  const root = tmp("telar-wt-refusal-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function engine(): Promise<EngineClient> {
  const daemon = await startEngine({ models: stubModels, engineRoot: home() });
  daemons.push(daemon);
  return new EngineClient(daemon.discovery);
}

test("a worktree asked for on a directory that is not a repository is refused with the engine's own sentence", async () => {
  const client = await engine();
  const checkout = tmp("telar-wt-refusal-plain-");
  await client.registerProject({ id: "project_one", name: "Unversioned", root: checkout });

  await expect(client.createSession({ id: "session_tree", projectId: "project_one", envMode: "worktree" })).rejects.toMatchObject({
    code: "invalid_request",
    // The path is in the sentence because "not one" without it is an assertion
    // about nothing a reader can go and look at. RESOLVED, because registration
    // stores the real path and macOS puts every temp directory behind the
    // `/var` → `/private/var` symlink — so the sentence names `/private/var/…`
    // and an unresolved expectation here would fail for the platform's reason
    // rather than for the engine's.
    message: `worktree sessions need a git repository; ${fs.realpathSync(checkout)} is not one. Use envMode "local" for an unversioned project.`,
  });
});

test("a branch name inside the engine's own namespace is refused by name", async () => {
  const client = await engine();
  await client.registerProject({ id: "project_one", name: "Versioned", root: repo() });

  await expect(
    client.createSession({ id: "session_named", projectId: "project_one", envMode: "worktree", branchName: "telar/mine" }),
  ).rejects.toMatchObject({
    code: "invalid_request",
    message: 'branch name "telar/mine" is inside an engine-owned namespace; pick a name outside loom/ and telar/',
  });
});

test("a base ref that does not resolve is refused with the ref it could not resolve", async () => {
  const client = await engine();
  await client.registerProject({ id: "project_one", name: "Versioned", root: repo() });

  const refused = client.createSession({
    id: "session_base",
    projectId: "project_one",
    envMode: "worktree",
    baseRef: "origin/nonexistent",
  });
  await expect(refused).rejects.toMatchObject({ code: "invalid_request" });
  // git's own words follow the colon; the name the caller asked for is ours, and
  // it is the half that tells them what to type next.
  await expect(refused).rejects.toThrow(/cannot resolve base ref "origin\/nonexistent"/);
});
