/**
 * MOVING CHECKOUTS THROUGH THE STORE — issue #642 part 2.
 *
 * `worktrees-move.test.ts` proves the git sequence against real repositories.
 * This is the half only the store can answer, and it is the half that makes the
 * operation a feature rather than a script: **the session follows its
 * checkout.** A move that relocated the bytes and left every session record
 * naming a path that no longer exists would have broken the app to save disk.
 *
 * THROUGH `EngineStore` RATHER THAN THE DAEMON, the way every other
 * worktree-session test here works (`project-volume.test.ts`): the cut happens
 * in the store, and the HTTP layer above it is a route that calls this method
 * and serialises the answer.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { writeWorktreesRoot } from "../src/worktrees-location";

const made: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function repo(): string {
  const root = tmp("telar-movestore-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
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

/** A store with one project and one worktree session whose checkout has landed. */
async function withCheckout(sessionId = "session_one") {
  const engineRoot = tmp("telar-movestore-home-");
  const projectRoot = repo();
  const store = new EngineStore(engineRoot, () => Date.now());
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  store.createSession({ id: sessionId, projectId: "project_one", envMode: "worktree" });
  const where = () => {
    const workspace = store.getSession(sessionId).workspace;
    return workspace.mode === "worktree" ? workspace.path : undefined;
  };
  expect(await until(() => Boolean(where()) && fs.existsSync(where()!))).toBe(true);
  return { store, engineRoot, projectRoot, sessionId, path: where()! };
}

const pathOf = (store: EngineStore, sessionId: string): string | undefined => {
  const workspace = store.getSession(sessionId).workspace;
  return workspace.mode === "worktree" ? workspace.path : undefined;
};

test("the session follows its checkout — the recorded path is rewritten, not merely the bytes moved", async () => {
  const { store, engineRoot, sessionId, path: before } = await withCheckout();
  const destination = path.join(tmp("telar-movestore-dest-"), "checkouts");
  writeWorktreesRoot(engineRoot, destination);

  const outcome = await store.moveWorktrees(destination);

  expect(outcome.skipped).toEqual([]);
  expect(outcome.moved).toHaveLength(1);
  // THE COMMIT POINT: the record and the disk agree, at the new root.
  expect(pathOf(store, sessionId)).toBe(outcome.moved[0]!.to);
  expect(pathOf(store, sessionId)!.startsWith(path.resolve(destination))).toBe(true);
  expect(fs.existsSync(pathOf(store, sessionId)!)).toBe(true);
  expect(fs.existsSync(before)).toBe(false);
  // A real checkout, not an empty folder: the project's own file is in it.
  expect(fs.existsSync(path.join(pathOf(store, sessionId)!, "README.md"))).toBe(true);
});

test("a checkout with uncommitted work is left where it is, and the session still points at it", async () => {
  const { store, engineRoot, sessionId, path: where } = await withCheckout("session_dirty");
  fs.writeFileSync(path.join(where, "uncommitted.txt"), "work nobody has committed\n");
  const destination = path.join(tmp("telar-movestore-dest-"), "checkouts");
  writeWorktreesRoot(engineRoot, destination);

  const outcome = await store.moveWorktrees(destination);

  expect(outcome.moved).toEqual([]);
  expect(outcome.skipped[0]).toMatchObject({ sessionId, reason: "dirty" });
  /**
   * GIT'S OWN REFUSAL, not a check written here — `worktree remove` fails on
   * modified or untracked files and this never passes `--force`. The work is
   * still there and the session still knows where it is, which is the whole
   * promise.
   */
  expect(fs.readFileSync(path.join(where, "uncommitted.txt"), "utf8")).toBe("work nobody has committed\n");
  expect(pathOf(store, sessionId)).toBe(where);
});

test("a session still working refuses the whole move, before anything is touched", async () => {
  const { store, engineRoot, sessionId, path: where } = await withCheckout("session_busy");
  // A queued turn is enough: the session is no longer idle, which is what
  // "something is happening in that directory" means here.
  store.submitTurn(sessionId, { runId: "run_busy", input: "do the thing", origin: "user" } as never);
  const destination = path.join(tmp("telar-movestore-dest-"), "checkouts");
  writeWorktreesRoot(engineRoot, destination);

  // "A half-migrated worktrees root loses uncommitted work in every open
  // session" — a turn in flight is holding that directory right now.
  await expect(store.moveWorktrees(destination)).rejects.toThrow(/still working/);
  expect(fs.existsSync(where)).toBe(true);
  expect(pathOf(store, sessionId)).toBe(where);
});

test("a session whose checkout is already gone is not reported as a failure", async () => {
  /**
   * An archived session's checkout has been released, so its recorded path
   * names nothing. Asking git to remove it would produce a "failed" row about
   * a checkout nobody has, and a person would go looking for it.
   */
  const { store, engineRoot, sessionId, path: where } = await withCheckout("session_released");
  fs.rmSync(where, { recursive: true, force: true });
  const destination = path.join(tmp("telar-movestore-dest-"), "checkouts");
  writeWorktreesRoot(engineRoot, destination);

  const outcome = await store.moveWorktrees(destination);

  expect(outcome.moved).toEqual([]);
  expect(outcome.skipped).toEqual([]);
  void sessionId;
});

test("moving twice is harmless — the second run has nothing left to do", async () => {
  const { store, engineRoot } = await withCheckout("session_twice");
  const destination = path.join(tmp("telar-movestore-dest-"), "checkouts");
  writeWorktreesRoot(engineRoot, destination);

  expect((await store.moveWorktrees(destination)).moved).toHaveLength(1);
  // Re-runnable by design: somebody who commits their work presses it again,
  // and the ones that already moved must not move a second time.
  const second = await store.moveWorktrees(destination);
  expect(second.moved).toEqual([]);
  expect(second.skipped).toEqual([]);
});
