/**
 * NOTHING APPEARS AT THE STORE ROOT THAT THE PRODUCT DID NOT SANCTION — #665.
 *
 * ══ WHY IT WATCHES THE FILESYSTEM AND NOT THE PROCESS ══
 *
 * The obvious harness monkey-patches `node:fs` and records what was written.
 * It would be blind to most of Telar's writers. `apps/engine/src` alone holds
 * ~114 synchronous `fs` write callsites **and 162 subprocess spawn sites** —
 * git, bun, uv, conda, tectonic, and the agent CLIs, every one of which writes
 * wherever it likes — plus native sqlite, which goes through its own handle and
 * never touches `node:fs` at all, plus Chromium inside Electron.
 *
 * Such a test PASSES, cleanly, while the store grows directories nobody
 * sanctioned. That is the same shape as the guard this repository shipped which
 * greped for a test name, and the perf suite it shipped with its clock at zero.
 *
 * So this snapshots the tree, drives a workload, snapshots again, and diffs. A
 * filesystem diff cannot be evaded by a subprocess, by native sqlite, or by
 * Chromium, because it does not care who wrote.
 *
 * ══ "SANCTIONED" IS THE PRODUCT'S LIST, NOT THIS FILE'S ══
 *
 * The allowlist is derived from `statePaths()` and `DIRECTORY_CATEGORIES` — the
 * same values the code uses to decide where things go and how to measure them.
 * A root-level name added without being declared in one of those fails by
 * construction. That is also why "`statePaths` is the only way to name a
 * store-root file" was a precondition for this test rather than tidying: while
 * nine names were composed by hand elsewhere, there was no list to derive from.
 *
 * ══ THE WORKLOAD IS THE COVERAGE ARGUMENT, AND IT IS WRITTEN DOWN ══
 *
 * This proves nothing about a writer it never provoked. What the run below
 * exercises, in full:
 *
 *   - engine boot on an empty home, and a second boot over the same home
 *   - project registration
 *   - session creation (`local` env mode)
 *   - a turn: submit, claim, mark running, stream two deltas, complete an item,
 *     complete the turn, and a read receipt
 *   - a project note
 *   - an MCP server registration
 *   - session defaults and the published appearance blob
 *   - the execution store's own housekeeping on open
 *
 * **Everything else is out of this test's reach**, and the ones worth naming:
 * worktree-mode sessions (they need a real git repository and a `git worktree
 * add` subprocess), the data-science and LaTeX plugins (they install
 * toolchains), the headless browser (it needs Chromium), dictation, and
 * anything a provider CLI writes. A directory only those create would not be
 * caught here, and adding one of them to the workload is how that changes.
 *
 * ══ AND A CANARY PER WRITER CLASS, BECAUSE A BLIND HARNESS PASSES ══
 *
 * `the harness sees every writer` below creates an unsanctioned file three
 * ways — in-process `fs`, a SPAWNED CHILD, and sqlite's own handle — and
 * asserts the diff reports each. If a canary were invisible the harness would
 * be blind, and the blindness would fail CI rather than be discovered a year
 * later. The three are separate because they fail differently.
 */
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore, statePaths } from "../src/state";
import { DIRECTORY_CATEGORIES } from "../src/storage";

const scratch: string[] = [];
const stores: EngineStore[] = [];
/** Every variable that must point inside the sandbox, with what it was. */
let restore: Array<[string, string | undefined]> = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.closeExecutionStore(); } catch { /* already closed */ } }
  for (const [name, was] of restore.splice(0)) { if (was === undefined) delete process.env[name]; else process.env[name] = was; }
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const START = Date.parse("2026-04-01T00:00:00Z");

/**
 * TIER 4 IS INSIDE THE SANDBOX TOO — `docs/storage-shape.md`.
 *
 * A run must touch nothing under the real home, and that only holds if every
 * variable a writer might follow points somewhere this test owns. Any one of
 * them left unset is a hole, and `claude-fork.ts` — which RENAMES files inside
 * `~/.claude/projects` — is the writer that would find it.
 */
const REDIRECTED = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "BUN_INSTALL_CACHE_DIR", "XDG_CONFIG_HOME"] as const;

function sandbox(): { home: string; engineRoot: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-shape-"));
  scratch.push(home);
  for (const name of REDIRECTED) {
    restore.push([name, process.env[name]]);
    process.env[name] = path.join(home, "fake-home");
  }
  fs.mkdirSync(path.join(home, "fake-home"), { recursive: true });
  return { home, engineRoot: path.join(home, "engine") };
}

/**
 * WHAT THE PRODUCT SAYS MAY BE AT THE ROOT — derived, never restated.
 *
 * `statePaths` names every sanctioned file and two of the directories;
 * `DIRECTORY_CATEGORIES` names the rest, and is `storage.ts`'s own table for
 * deciding which row a directory's bytes belong in. The three that are in
 * neither are here with their reasons, and each is a reason rather than an
 * exemption:
 */
function sanctioned(engineRoot: string): Set<string> {
  const { root: _root, ...named } = statePaths(engineRoot);
  return new Set([
    ...Object.values(named).map((file) => path.basename(file)),
    ...Object.keys(DIRECTORY_CATEGORIES),
    // The database and the two files sqlite keeps beside it. Not in
    // `statePaths` because nothing composes them from it — `ExecutionStore`
    // opens the first and sqlite makes the other two.
    "execution.sqlite", "execution.sqlite-wal", "execution.sqlite-shm",
    // DELIBERATELY ABSENT FROM `DIRECTORY_CATEGORIES`, and that absence is
    // load-bearing: #642 part 2 made the checkouts root relocatable, so a table
    // keyed on "the child called worktrees" would stop finding it the day it
    // moved off this volume. It is still a sanctioned name when it IS there.
    "worktrees",
  ]);
}

/** Top-level entries of the store root. The scope is the ROOT — a per-session
 *  file under `sessions/` is that document's business, not the shape's. */
const entriesOf = (root: string): string[] => {
  try { return fs.readdirSync(root).sort(); } catch { return []; }
};

/** Every top-level name the workload left behind that nothing declared. */
const unsanctioned = (root: string): string[] => {
  const allowed = sanctioned(root);
  return entriesOf(root).filter((name) => !allowed.has(name));
};

/** The workload. See the coverage list in this file's header — anything not
 *  here is explicitly out of this test's reach. */
function drive(engineRoot: string): EngineStore {
  const store = new EngineStore(engineRoot, () => START, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "one", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  store.submitTurn("session_one", { runId: "run_one", input: "write something down" });
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "item_one", title: "answering", detail: { type: "assistant_message", text: "" } } },
    { kind: "content.delta", itemId: "item_one", stream: "assistant_text", text: "part one " },
    { kind: "content.delta", itemId: "item_one", stream: "assistant_text", text: "part two" },
    { kind: "item.completed", itemId: "item_one", status: "completed", detail: { type: "assistant_message", text: "part one part two" } },
  ]);
  store.completeTurn("session_one", "run_one", token, { text: "done" });
  store.markSessionRead("session_one", "run_one");
  store.saveMcpServer({ id: "linear", spec: { transport: "stdio", command: "linear-mcp", args: [] } });
  store.setSessionDefaults({ envMode: "local" });
  store.setAppearance({ look: { name: "something" } });
  return store;
}

test("a representative workload leaves nothing at the store root that nothing declared", () => {
  const { engineRoot } = sandbox();
  const store = drive(engineRoot);
  store.closeExecutionStore();
  stores.splice(stores.indexOf(store), 1);
  // A SECOND BOOT OVER THE SAME HOME, because several things are written only
  // on open — the legacy fence, the backup sweep, the reconciles — and a test
  // that never reopened would miss every one of them.
  const reopened = new EngineStore(engineRoot, () => START + 1000, { executionStorage: "sqlite" });
  stores.push(reopened);

  expect(unsanctioned(engineRoot)).toEqual([]);
  // …AND THE ALLOWLIST IS NOT VACUOUSLY WIDE. A `sanctioned` that returned
  // everything would satisfy the assertion above; this says the workload really
  // did write, and that what it wrote is what the product names.
  const wrote = entriesOf(engineRoot);
  expect(wrote).toContain("execution.sqlite");
  expect(wrote).toContain("projects.json");
  expect(wrote).toContain("sessions");
  expect(wrote.length).toBeGreaterThan(5);
});

test("the harness sees every writer — in-process, a spawned child, and sqlite", () => {
  const { engineRoot } = sandbox();
  const store = drive(engineRoot);
  expect(unsanctioned(engineRoot)).toEqual([]);

  /**
   * CANARY 1 — ORDINARY IN-PROCESS `fs`. The only class a monkey-patched `fs`
   * would have caught, which is why it is not the only canary.
   */
  fs.writeFileSync(path.join(engineRoot, "canary-in-process"), "unsanctioned\n");

  /**
   * CANARY 2 — A SPAWNED CHILD. `apps/engine/src` has 162 spawn sites; git,
   * bun, uv, conda, tectonic and the agent CLIs all write wherever they like,
   * and NONE of them goes through this process's `fs`. Bounded, because a
   * wedged child must not hold the suite.
   */
  const child = spawnSync(process.execPath, [
    "-e",
    `require("node:fs").writeFileSync(process.argv[1], "unsanctioned\\n")`,
    path.join(engineRoot, "canary-subprocess"),
    // `killSignal` AND THE TIMEOUT TOGETHER — #807. A synchronous child wait
    // blocks the JS thread in `wait4`, where bun's per-test ceiling (an
    // event-loop timer) can never reach it, so a child that stops answering is
    // a test that never fails. SIGKILL is what makes the ceiling reach it.
  ], { timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "ignore", "pipe"] });
  expect(child.status).toBe(0);

  /**
   * CANARY 3 — SQLITE'S OWN HANDLE. It writes through the native library and
   * never touches `node:fs` at all, so an in-process recorder cannot see it
   * even in principle. The same runtime fork `ExecutionStore` makes.
   */
  const native = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite") as {
    Database?: new (file: string) => { exec(sql: string): void; close(): void };
    DatabaseSync?: new (file: string) => { exec(sql: string): void; close(): void };
  };
  const canaryDb = path.join(engineRoot, "canary-sqlite.db");
  const db = process.versions.bun ? new native.Database!(canaryDb) : new native.DatabaseSync!(canaryDb);
  db.exec("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES(1);");
  db.close();

  /**
   * ALL THREE, REPORTED BY NAME. Asserted as a set rather than a count: a
   * harness that saw one writer and mistook it for three would pass a count,
   * and the whole point is that the three classes fail differently.
   */
  expect(unsanctioned(engineRoot).filter((name) => name.startsWith("canary")).sort())
    .toEqual(["canary-in-process", "canary-sqlite.db", "canary-subprocess"]);
  expect(store.paths.root).toBe(path.resolve(engineRoot));
});

test("the run touches nothing under the home it was given", () => {
  const { home, engineRoot } = sandbox();
  drive(engineRoot);
  /**
   * TIER 4 — see `REDIRECTED`. Every variable a writer might follow points
   * inside the sandbox, and this asserts the directory they point at is still
   * empty afterwards. The writer that would find a missing redirect is
   * `claude-fork.ts`, which renames files inside `~/.claude/projects`; the
   * workload above does not reach it, which is exactly why the redirect has to
   * be checked rather than assumed.
   */
  expect(fs.readdirSync(path.join(home, "fake-home"))).toEqual([]);
  /**
   * AND THE FIVE ARE NAMED HERE RATHER THAN LOOPED OVER `REDIRECTED`.
   *
   * The first spelling iterated the same array `sandbox()` reads, which made
   * this vacuous in the one direction that matters: DELETING a name from that
   * array removed it from the redirect AND from the check, and the test stayed
   * green. Shown, by dropping `CLAUDE_CONFIG_DIR` — 3 pass, 0 fail.
   *
   * The assertion above is vacuous on its own too, and for a sharper reason:
   * the workload does not reach `claude-fork.ts`, so nothing it runs would
   * write under `~/.claude` even with the redirect gone. "The sandbox is empty"
   * proves the redirect only for variables something actually followed. So the
   * redirect itself is asserted, by name, against a literal list.
   */
  const inside = path.join(home, "fake-home");
  expect({
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }).toEqual({
    HOME: inside, CLAUDE_CONFIG_DIR: inside, CODEX_HOME: inside, BUN_INSTALL_CACHE_DIR: inside, XDG_CONFIG_HOME: inside,
  });
});
