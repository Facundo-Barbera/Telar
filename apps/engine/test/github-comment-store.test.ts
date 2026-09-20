/**
 * WHO A COMMENT IS ATTRIBUTED TO, AND WHO DECIDES — issue #791.
 *
 * This is the load-bearing half of the feature and the only place it can be
 * tested: the marker's format is `github-attribution.test.ts`, the stamping is
 * `github.test.ts`, and the question of WHOSE id gets stamped is answered here,
 * by the store, from a claim token.
 *
 * What must not drift:
 *
 *   - the id in the comment body is the one the STORE found on the claim, never
 *     the one the caller named — a model cannot attribute its words to another
 *     session, and the test proves it by NAMING ANOTHER SESSION and watching
 *     the other session's id fail to appear;
 *   - a claim that is not live buys nothing, so a stale or forged token cannot
 *     post at all;
 *   - the built-in Agent is refused, because `agent` is not a session and the
 *     link would be permanently dead;
 *   - a posted comment drops the detail cache, so the thread the panel shows is
 *     not thirty seconds behind the comment it just wrote.
 */
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import type { GhResult } from "../src/github";

const homes: string[] = [];
const stores: EngineStore[] = [];
afterAll(() => {
  for (const store of stores) store.close?.();
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

const POSTED: GhResult = { status: 0, stdout: "https://example.invalid/issues/791#issuecomment-1\n", stderr: "" };

/**
 * Two sessions, a LIVE claim on one of them, and a `gh` that records the argv
 * it was handed. The second session exists so the impersonation test has a real
 * id to aim at rather than an invented one.
 */
function setup(reply: GhResult = POSTED) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-ghcomment-"));
  homes.push(home);
  const calls: string[][] = [];
  const store = new EngineStore(home, Date.now, {
    executionStorage: "sqlite",
    gh: async (_cwd, args) => {
      calls.push(args);
      return reply;
    },
  });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  for (const id of ["session_writer", "session_other"]) store.createSession({ id, projectId: "project_one" });
  store.submitTurn("session_writer", { runId: "run_live", input: "work" });
  const claimToken = store.claimTurn("session_writer", "worker_one")!.claim!.token;
  store.markRunning("session_writer", "run_live", claimToken);
  return { store, calls, proof: { sessionId: "session_writer", runId: "run_live", claimToken } };
}

/** The body the store handed `gh`. */
function bodyFrom(calls: string[][]): string {
  const call = calls.find((args) => args[1] === "comment");
  if (!call) throw new Error("no comment was posted");
  return call[call.indexOf("--body") + 1] ?? "";
}

test("the comment is stamped with the session the claim proves, and gh is told", async () => {
  const { store, calls, proof } = setup();
  const result = await store.projectGitHubComment("project_one", { kind: "issue", number: 791, body: "The finding." }, proof);

  expect(result).toEqual({
    posted: true,
    url: "https://example.invalid/issues/791#issuecomment-1",
    attribution: { sessionId: "session_writer" },
  });
  expect(bodyFrom(calls)).toBe("The finding.\n\n<!-- telar-session: session_writer -->");
});

/**
 * THE TEST THE WHOLE DESIGN EXISTS FOR.
 *
 * `session_other` is a real session on this store with a LIVE claim of its own,
 * so both halves of an impersonation are available and neither is invented.
 *
 * Three assertions, and it takes all three to mean anything:
 *
 *   1. each session's own proof stamps its own id — a store that stamped a
 *      constant, or the first session it found, fails here;
 *   2. presenting one session's claim while NAMING the other is refused, and
 *      the refusal is asserted rather than swallowed by a `.catch` — the
 *      vacuous version of this test passed with no assertions at all;
 *   3. nothing reached GitHub on the refused path.
 */
test("a comment is stamped with the session that proved itself, and nobody else", async () => {
  const { store, calls, proof } = setup();
  // `session_other` gets a live claim too, so it is a real alternative rather
  // than a name the store was always going to reject.
  store.submitTurn("session_other", { runId: "run_other", input: "work" });
  const otherToken = store.claimTurn("session_other", "worker_two")!.claim!.token;
  store.markRunning("session_other", "run_other", otherToken);
  const otherProof = { sessionId: "session_other", runId: "run_other", claimToken: otherToken };

  // 1. Each proof stamps its own session.
  const mine = await store.projectGitHubComment("project_one", { kind: "issue", number: 791, body: "mine" }, proof);
  expect(mine).toMatchObject({ posted: true, attribution: { sessionId: "session_writer" } });
  const theirs = await store.projectGitHubComment("project_one", { kind: "issue", number: 791, body: "theirs" }, otherProof);
  expect(theirs).toMatchObject({ posted: true, attribution: { sessionId: "session_other" } });

  const before = calls.length;

  // 2. `session_writer`'s claim, presented under `session_other`'s name. The
  //    store looks the claim up under the name it was GIVEN and finds nothing
  //    live there, so there is no id for it to stamp.
  await expect(
    store.projectGitHubComment("project_one", { kind: "issue", number: 791, body: "not mine to sign" }, { ...proof, sessionId: "session_other" }),
  ).rejects.toThrow();

  // 3. And it refused before `gh`, so there is no comment to unpost.
  expect(calls.length).toBe(before);
  for (const call of calls) expect(call.join(" ")).not.toContain("not mine to sign");
});

test("a claim that is not live posts nothing at all", async () => {
  const { store, calls, proof } = setup();
  await expect(
    store.projectGitHubComment("project_one", { kind: "issue", number: 1, body: "x" }, { ...proof, claimToken: `${proof.claimToken}-forged` }),
  ).rejects.toThrow();
  await expect(
    store.projectGitHubComment("project_one", { kind: "issue", number: 1, body: "x" }, { ...proof, runId: "run_never" }),
  ).rejects.toThrow();
  // Nothing reached GitHub on either path — a refusal that posted first would
  // be a comment nobody can unpost.
  expect(calls).toEqual([]);
});

test("the built-in Agent is refused, because `agent` is not a session to link to", async () => {
  const { store, calls, proof } = setup();
  await expect(
    store.projectGitHubComment("project_one", { kind: "issue", number: 1, body: "x" }, { ...proof, sessionId: "agent" }),
  ).rejects.toThrow(/no session a comment could link to/);
  expect(calls).toEqual([]);
});

test("a posted comment drops the thread's cache so the panel is not thirty seconds behind", async () => {
  const thread = (body: string): GhResult => ({
    status: 0,
    stdout: JSON.stringify({
      number: 791,
      title: "t",
      state: "OPEN",
      author: { login: "Facundo-Barbera" },
      body: "b",
      labels: [],
      assignees: [],
      comments: [{ author: { login: "Facundo-Barbera" }, body, createdAt: "2026-09-20T10:00:00Z", isMinimized: false, url: "https://example.invalid/c" }],
      createdAt: "2026-09-20T09:00:00Z",
      updatedAt: "2026-09-20T10:00:00Z",
      url: "https://example.invalid/issues/791",
    }),
    stderr: "",
  });

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-ghcache-"));
  homes.push(home);
  let body = "before";
  const store = new EngineStore(home, Date.now, {
    executionStorage: "sqlite",
    gh: async (_cwd, args) => (args[1] === "comment" ? POSTED : args[1] === "view" ? thread(body) : { status: 1, stdout: "", stderr: "no" }),
  });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  store.createSession({ id: "session_writer", projectId: "project_one" });
  store.submitTurn("session_writer", { runId: "run_live", input: "work" });
  const claimToken = store.claimTurn("session_writer", "worker_one")!.claim!.token;
  store.markRunning("session_writer", "run_live", claimToken);

  const first = await store.projectIssue("project_one", 791);
  expect("issue" in first && first.issue.comments[0]!.body).toBe("before");

  body = "after";
  // Without the cache drop this read is served the thirty-second-old copy and
  // still says "before" — which is the assertion that fails if the drop goes.
  await store.projectGitHubComment("project_one", { kind: "issue", number: 791, body: "posted" }, {
    sessionId: "session_writer",
    runId: "run_live",
    claimToken,
  });
  const second = await store.projectIssue("project_one", 791);
  expect("issue" in second && second.issue.comments[0]!.body).toBe("after");
});
