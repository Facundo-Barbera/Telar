/**
 * A SESSION WITH NO PROJECT AND NO WORKING DIRECTORY (#526).
 *
 * ON `codex` SINCE #531. These were written against the `telar` driver because
 * that was the one project-less thing in the engine; it is gone, and the
 * property under test never had anything to do with it — a session with no
 * project is a shape any driver can be given. Codex rather than Claude for the
 * reason the ordinary-session case below already gives: a Claude claim waits on
 * the model catalogue.
 *
 * WHAT IS BEING PINNED, and why each one is worth a test rather than a comment:
 *
 *   - that a project-less create produces `workspace.mode === "none"` and NO
 *     path — the field's absence is the statement, and a reader that found an
 *     empty string there would happily `path.resolve` against the process cwd;
 *   - that a WORKTREE cannot be asked for without a project, and is refused
 *     rather than downgraded: silently handing back a `local` session is how a
 *     caller ends up with a conversation working somewhere it did not choose;
 *   - that the CLAIM omits `projectRoot` entirely, because the worker's folder
 *     check keys on its absence;
 *   - that the worker's folder check is skipped for exactly that claim and
 *     still fires for a checkout that has gone missing;
 *   - that a driver which SPAWNS refuses such a turn by name, so a routing
 *     mistake reads as one rather than as a broken CLI;
 *   - that the store refuses file and diff reads on such a session instead of
 *     answering about some other directory.
 *
 * NO DAEMON AND NO CLI: every one of these is a store call, a claim, or a
 * driver's own early refusal.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore, EngineStateError } from "../src/state";
import { assertProjectRoot } from "../src/worker";
import { createClaudeDriver } from "../src/driver";
import { createCodexDriver } from "../src/codex-driver";
import type { DriverRun } from "../src/provider-contract";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "projectless-"));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const store = (): EngineStore => new EngineStore(path.join(root(), "state"), () => 100);

test("a session created with no project has no project, no path and no branch", () => {
  const engine = store();
  const session = engine.createSession({ id: "session_main", title: "Main", driver: "codex" });

  expect(session.projectId).toBeUndefined();
  expect(session.workspace).toEqual({ mode: "none" });
  // Not merely "no path on a local workspace": the variant itself carries no
  // `path` key, so nothing downstream can read one off it.
  expect("path" in session.workspace).toBe(false);
  expect(session.driver).toBe("codex");
  // `EnvMode` has no third answer, and `none` is what the workspace says. The
  // one value that claims nothing extra is `local`.
  expect(session.envMode).toBe("local");
  // Re-read from disk, because the interesting failure is a variant that
  // round-trips through the schema as something else.
  expect(engine.getSession("session_main").workspace).toEqual({ mode: "none" });
});

test("a worktree cannot be asked for without a project — refused, never downgraded", () => {
  const engine = store();
  expect(() => engine.createSession({ id: "session_nope", envMode: "worktree", driver: "codex" })).toThrow(
    /worktree is cut from a project/,
  );
  // And nothing was written for the id that was refused.
  expect(() => engine.getSession("session_nope")).toThrow(EngineStateError);
});

test("the claim for such a session carries no projectRoot at all", () => {
  const engine = store();
  engine.createSession({ id: "session_main", title: "Main", driver: "codex" });
  engine.submitTurn("session_main", { runId: "run_one", input: "hello" });

  const claim = engine.claimNextTurn("worker_one");
  expect(claim?.sessionId).toBe("session_main");
  expect(claim?.projectRoot).toBeUndefined();
  expect(claim?.projectId).toBeUndefined();
  expect(claim?.driver).toBe("codex");
});

test("an ordinary session still claims with its project root", () => {
  const engine = store();
  const project = root();
  engine.registerProject({ id: "project_one", name: "One", root: project });
  // Codex rather than Claude: a Claude claim waits on the model catalogue, and
  // what this test is about is the path, not the model.
  engine.createSession({ id: "session_one", projectId: "project_one", driver: "codex" });
  engine.submitTurn("session_one", { runId: "run_one", input: "hello" });

  const claim = engine.claimNextTurn("worker_one");
  expect(claim?.projectRoot).toBe(fs.realpathSync.native(project));
});

test("the worker's folder check is about a folder, and still fires for one that is gone", () => {
  // The skip in `execute` is `cwd !== undefined`, so what this pins is the
  // other half: the check itself has lost nothing.
  const missing = path.join(root(), "moved-away");
  expect(() => assertProjectRoot(missing)).toThrow(/does not exist/);
  const present = root();
  expect(() => assertProjectRoot(present)).not.toThrow();
});

test("a driver that spawns a CLI refuses a turn with no directory, by name", async () => {
  const run = (over: Partial<DriverRun> = {}): DriverRun =>
    ({
      sessionId: "session_main",
      runId: "run_one",
      prompt: "hello",
      signal: new AbortController().signal,
      onObservations: async () => {},
      ...over,
    }) as DriverRun;

  // No `cwd` at all — the shape a project-less claim produces.
  await expect(createClaudeDriver().run(run())).rejects.toThrow(/working directory, and this session has none/);
  await expect(createCodexDriver().run(run())).rejects.toThrow(/working directory, and this session has none/);
});

test("the store refuses a files or diff read on a session that has no directory", () => {
  const engine = store();
  engine.createSession({ id: "session_main", driver: "codex" });

  // Synchronously, even on the async readers: the refusal happens before the
  // first await, which is where a caller wants it.
  expect(() => engine.sessionFilesAsync("session_main")).toThrow(/no working directory/);
  expect(() => engine.sessionDiffAsync("session_main")).toThrow(/no working directory/);
});
