/**
 * WHERE THE REPOSITORY STOOD WHEN A TURN RAN — issue #741.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A FILE OF ITS OWN, for `diff-base.test.ts`'s reason: this cuts a real
 * worktree and makes real commits, which is the most expensive thing a test in
 * this suite can do, and the pool tests elsewhere own budgets measured in tens
 * of milliseconds.
 *
 * WHAT IS ACTUALLY BEING PROVEN. The turn scope renders the agent's own
 * reported patch, and that witness cannot see a write that did not come from a
 * file tool, cannot see a later overwrite, and is absent entirely on Codex and
 * OpenCode. An anchor is a pair of shas the ENGINE observed — not authored by
 * the thing being reviewed — so "what did this turn do" becomes a question git
 * can answer.
 *
 * THE PROBE IS OFF THE LOCK, so every assertion here waits for it rather than
 * reading straight after the transition. That wait is the test acknowledging
 * the design: a turn is never held waiting for git.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import type { Turn } from "@telar/engine-client";
import { worktreeReady } from "./worktree-ready";
import { until } from "./wait";

const roots: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

const engineHome = (prefix: string): string => {
  const directory = tmp(prefix);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A throwaway repository. `seeded: false` leaves it with NO COMMITS, which is
 *  its own anchor case rather than a broken fixture. */
function repo(seeded = true): { root: string; git: (...args: string[]) => string } {
  const root = tmp("telar-741-repo-");
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  if (seeded) {
    fs.writeFileSync(path.join(root, "README.md"), "hello\n");
    git("add", "-A");
    git("commit", "-qm", "initial");
  }
  return { root, git };
}

/**
 * Wait for the anchor the transition DISPATCHED to land.
 *
 * THE SHARED BUDGET, NOT A PRIVATE ONE — #760, and this file paid for that
 * lesson after shipping. It first carried its own two-second loop on the
 * reasoning that a `rev-parse` slower than that meant a wedged pool. That is
 * true on an idle machine and false in the suite: run under the full engine
 * shard the same probe took longer, and the guard failed in COMPOSITION while
 * passing alone — the exact shape `wait.ts`'s header describes and the exact
 * shape `diff-base.test.ts` was split out to avoid.
 *
 * `until` also says what never happened when it times out, which a bare
 * deadline loop returning a half-built turn could not.
 */
async function anchored(store: EngineStore, sessionId: string, runId: string, side: "before" | "after"): Promise<Turn> {
  const read = (): Turn | undefined => store.turns(sessionId).find((candidate) => candidate.runId === runId);
  await until(`the turn's \`${side}\` anchor to be stamped`, () => {
    const turn = read();
    return turn?.anchor?.[side] !== undefined || turn?.anchor?.read !== undefined;
  });
  return read()!;
}

/** Drive one turn to `running`, hand back its claim token. */
function startTurn(store: EngineStore, sessionId: string, runId: string): string {
  store.submitTurn(sessionId, { runId, input: "go" });
  const token = store.claimTurn(sessionId, "worker_one")!.claim!.token;
  store.markRunning(sessionId, runId, token);
  return token;
}

test("a turn that commits is anchored to a range git can be asked about (#741)", async () => {
  const { root } = repo();
  const store = new EngineStore(engineHome("telar-741-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root });
  store.createSession({ id: "session_cut", projectId: "project_one", envMode: "worktree" });
  await worktreeReady(store, "session_cut");

  const workspace = store.getSession("session_cut").workspace;
  if (workspace.mode !== "worktree") throw new Error("expected a worktree workspace");
  const checkout = workspace.path;

  const token = startTurn(store, "session_cut", "run_1");
  const started = await anchored(store, "session_cut", "run_1", "before");
  const before = started.anchor?.before;
  expect(before, "the turn is anchored where it started").toMatch(/^[0-9a-f]{40}$/);
  expect(started.anchor?.read).toBeUndefined();

  // The turn commits, which is what makes `before..after` a range rather than
  // a pair of equal shas.
  fs.writeFileSync(path.join(checkout, "written.ts"), "export const a = 1;\n");
  await store.commitSessionWork("session_cut", "the turn's own commit");

  store.completeTurn("session_cut", "run_1", token, { text: "done" });
  const ended = await anchored(store, "session_cut", "run_1", "after");
  const after = ended.anchor?.after;
  expect(after, "the turn is anchored where it ended").toMatch(/^[0-9a-f]{40}$/);
  // THE ASSERTION THAT MATTERS: two different observations, which is what a
  // stub returning one read could not produce.
  expect(after).not.toBe(before);

  // ...and the range really does hold the turn's commit, which is the whole
  // claim the anchor makes. Read through the store's own git, in the checkout.
  const listed = execFileSync("git", ["rev-list", "--count", `${before}..${after}`], { cwd: checkout, encoding: "utf8" }).trim();
  expect(listed).toBe("1");
  const named = execFileSync("git", ["diff", "--name-only", before!, after!], { cwd: checkout, encoding: "utf8" });
  expect(named.split("\n").filter(Boolean)).toEqual(["written.ts"]);
});

test("a turn that commits nothing is anchored to the same sha twice, which is not a failure (#741)", async () => {
  /**
   * THE ORDINARY CASE, and the negative direction of the test above: if
   * `before !== after` were always true, the pair would be a clock rather than
   * an observation. A turn that wrote to the working tree and committed
   * nothing has an EQUAL pair — and that equality is itself the useful fact,
   * because it says the disk is where the journal's patch has to be read
   * against.
   */
  const { root } = repo();
  const store = new EngineStore(engineHome("telar-741-engine-flat-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root });
  store.createSession({ id: "session_flat", projectId: "project_one", envMode: "worktree" });
  await worktreeReady(store, "session_flat");

  const workspace = store.getSession("session_flat").workspace;
  if (workspace.mode !== "worktree") throw new Error("expected a worktree workspace");
  fs.writeFileSync(path.join(workspace.path, "dirty.ts"), "export const b = 2;\n");

  const token = startTurn(store, "session_flat", "run_1");
  const before = (await anchored(store, "session_flat", "run_1", "before")).anchor?.before;
  store.completeTurn("session_flat", "run_1", token, { text: "done" });
  const after = (await anchored(store, "session_flat", "run_1", "after")).anchor?.after;

  expect(before).toMatch(/^[0-9a-f]{40}$/);
  expect(after).toBe(before);
});

test("a stopped turn is anchored too, because that is when the question is asked (#741)", async () => {
  // A turn that ended where it stood is the case with the least trustworthy
  // account of itself, so it is the one the anchor is worth most for.
  const { root } = repo();
  const store = new EngineStore(engineHome("telar-741-engine-stop-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root });
  store.createSession({ id: "session_stop", projectId: "project_one", envMode: "worktree" });
  await worktreeReady(store, "session_stop");

  startTurn(store, "session_stop", "run_1");
  await anchored(store, "session_stop", "run_1", "before");
  store.stopTurn("session_stop", "run_1");
  const ended = await anchored(store, "session_stop", "run_1", "after");
  expect(ended.state).toBe("stopped");
  expect(ended.anchor?.after).toMatch(/^[0-9a-f]{40}$/);
});

test("a repository with no commits yet leaves the anchor ABSENT, not failed (#741)", async () => {
  /**
   * `rev-parse --verify --quiet HEAD` exits 1 with nothing to say, and that is
   * an answer rather than a failure: there is no commit to point at. Absent
   * with NO `read` is the honest record — and the empty-tree sha, which does
   * resolve even here, would be a sentinel a reader could also have named
   * deliberately.
   *
   * A `local` session, because a worktree cannot be cut from a repository with
   * no commits to cut from.
   */
  const { root } = repo(false);
  const store = new EngineStore(engineHome("telar-741-engine-empty-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root });
  store.createSession({ id: "session_empty", projectId: "project_one", envMode: "local" });

  const token = startTurn(store, "session_empty", "run_1");
  store.completeTurn("session_empty", "run_1", token, { text: "done" });
  // Nothing to wait for, so wait for the probe to have had its chance and
  // assert the absence rather than racing it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const turn = store.turns("session_empty").find((candidate) => candidate.runId === "run_1")!;
  expect(turn.anchor?.before).toBeUndefined();
  expect(turn.anchor?.after).toBeUndefined();
  // ...and NOT reported as a read that failed, which would send a reader
  // looking for a machine problem that is not there.
  expect(turn.anchor?.read).toBeUndefined();
});

test("a session with no repository at all is not anchored, and does not fail the turn (#741)", async () => {
  // An unversioned directory hosting a `local` session is a supported
  // configuration, not an error — `git.ts`'s header says so. The turn runs and
  // completes; the anchor simply says nothing.
  const plain = tmp("telar-741-plain-");
  const store = new EngineStore(engineHome("telar-741-engine-plain-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: plain });
  store.createSession({ id: "session_plain", projectId: "project_one", envMode: "local" });

  const token = startTurn(store, "session_plain", "run_1");
  const completed = store.completeTurn("session_plain", "run_1", token, { text: "done" });
  expect(completed.state).toBe("completed");
  // WAITED FOR RATHER THAN SLEPT ON: this asserts a `read` that has to ARRIVE,
  // so a fixed sleep that was too short would pass by finding nothing yet —
  // vacuously, and only on a loaded machine.
  const turn = await anchored(store, "session_plain", "run_1", "after");
  expect(turn.anchor?.before).toBeUndefined();
  expect(turn.anchor?.after).toBeUndefined();
  // git answered "not a repository" rather than not answering, so this is a
  // read that FAILED and says so — the distinction #654 exists for.
  expect(turn.anchor?.read).toBe("failed");
});
