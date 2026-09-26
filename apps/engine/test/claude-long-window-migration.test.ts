/**
 * RECORDS SAVED BEFORE 200k WAS A CHOICE KEEP RUNNING AT 1M — the one-time
 * rewrite in `migrateBareClaudeIds`.
 *
 * Before #986 a bare `opus` ran 1M, because every door rewrote it; from #986 a
 * bare id is a pick of 200k. So a record saved bare before then is rewritten to
 * the `[1m]` id it always ran as, once, and a bare pick made afterwards stays
 * 200k. Every case uses a temp home; nothing reads the real store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { legacyLongSpelling } from "../src/model-manifest";

const roots: string[] = [];
const dir = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const MARKER = "claude-long-window-migration.json";

/** A store as a pre-#986 engine left it: bare ids on disk, and no marker. */
function oldStore(): string {
  const root = dir("telar-long-window-");
  const store = new EngineStore(root, () => 100);
  store.registerProject({ id: "project_one", name: "One", root: dir("telar-long-window-checkout-") });
  store.registerProject({ id: "project_two", name: "Two", root: dir("telar-long-window-checkout-") });
  store.createSession({ id: "session_opus", projectId: "project_one" });
  store.createSession({ id: "session_sonnet", projectId: "project_one" });
  store.createSession({ id: "session_codex", projectId: "project_one", driver: "codex" });
  // What an older engine wrote. Edited on disk, because this build keeps a bare
  // id as the 200k pick it now is.
  const edit = (file: string, change: (value: Record<string, unknown>) => void) => {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    change(value);
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const session = (id: string) => path.join(root, "sessions", id, "session.json");
  edit(session("session_opus"), (value) => void (value.model = { instanceId: "claude", model: "opus", effort: "high" }));
  edit(session("session_sonnet"), (value) => void (value.model = { instanceId: "claude", model: "sonnet" }));
  edit(session("session_codex"), (value) => void (value.model = { instanceId: "codex", model: "gpt-5-codex" }));
  edit(path.join(root, "projects.json"), (value) => {
    const projects = value.projects as Record<string, unknown>[];
    projects[0]!.defaultModel = { instanceId: "claude", model: "claude-opus-5-5", effort: "medium" };
    projects[1]!.defaultModel = { instanceId: "codex", model: "gpt-5-codex" };
  });
  fs.rmSync(path.join(root, MARKER), { force: true });
  return root;
}

describe("the one-time [1m] rewrite", () => {
  test("an old record with bare `opus` is rewritten to `opus[1m]` and runs 1M", () => {
    const root = oldStore();
    const store = new EngineStore(root, () => 200);
    expect(store.claudeLongWindowMigration).toEqual({ sessions: 1, projects: 1 });
    expect(store.getSession("session_opus").model).toEqual({ instanceId: "claude", model: "opus[1m]", effort: "high" });
    store.submitTurn("session_opus", { runId: "run_one", input: "hi" });
    expect(store.claimNextTurn("worker_one")?.model?.model).toBe("opus[1m]");
    // The project default too, so new sessions from it open on 1M.
    expect(store.getProject("project_one").defaultModel).toEqual({ instanceId: "claude", model: "claude-opus-5-5[1m]", effort: "medium" });
  });

  test("only 1M-default Claude ids move: Sonnet's bare id is already its default, and Codex is never touched", () => {
    const store = new EngineStore(oldStore(), () => 200);
    expect(store.getSession("session_sonnet").model?.model).toBe("sonnet");
    expect(store.getSession("session_codex").model?.model).toBe("gpt-5-codex");
    expect(store.getProject("project_two").defaultModel?.model).toBe("gpt-5-codex");
  });

  test("a 200k pick made after the migration stays 200k", () => {
    const root = oldStore();
    const first = new EngineStore(root, () => 200);
    first.updateSession("session_opus", { model: { instanceId: "claude", model: "opus" } });
    first.updateProject("project_one", { defaultModel: { instanceId: "claude", model: "claude-opus-5-5" } });
    // Reopened: the marker is there, so nothing is rewritten.
    const reopened = new EngineStore(root, () => 300);
    expect(reopened.claudeLongWindowMigration).toBeUndefined();
    expect(reopened.getSession("session_opus").model?.model).toBe("opus");
    expect(reopened.getProject("project_one").defaultModel?.model).toBe("claude-opus-5-5");
    reopened.submitTurn("session_opus", { runId: "run_one", input: "hi" });
    expect(reopened.claimNextTurn("worker_one")?.model?.model).toBe("opus");
  });

  test("it runs once: the marker records what it did, and a later open skips it", () => {
    const root = oldStore();
    new EngineStore(root, () => 200);
    expect(JSON.parse(fs.readFileSync(path.join(root, MARKER), "utf8"))).toEqual({ version: 1, at: 200, sessions: 1, projects: 1 });
    const again = new EngineStore(root, () => 300);
    expect(again.claudeLongWindowMigration).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(root, MARKER), "utf8")).at).toBe(200);
  });

  test("idempotent even without the marker: a [1m] id is never rewritten twice", () => {
    const root = oldStore();
    new EngineStore(root, () => 200);
    fs.rmSync(path.join(root, MARKER));
    const rerun = new EngineStore(root, () => 300);
    expect(rerun.claudeLongWindowMigration).toEqual({ sessions: 0, projects: 0 });
    expect(rerun.getSession("session_opus").model?.model).toBe("opus[1m]");
  });

  test("a fresh store writes the marker and nothing else it did not already write", () => {
    const root = dir("telar-long-window-fresh-");
    const store = new EngineStore(root, () => 100);
    expect(store.claudeLongWindowMigration).toEqual({ sessions: 0, projects: 0 });
    expect(fs.existsSync(path.join(root, "provider-instances.json"))).toBe(false);
  });

  test("the SQLite backend is migrated the same way", () => {
    const root = dir("telar-long-window-sqlite-");
    const store = new EngineStore(root, () => 100, { executionStorage: "sqlite" });
    store.registerProject({ id: "project_one", name: "One", root: dir("telar-long-window-checkout-") });
    store.createSession({ id: "session_opus", projectId: "project_one" });
    // A bare id stored the way an older engine left it: a record, with no marker.
    store.updateSession("session_opus", { model: { instanceId: "claude", model: "opus" } });
    fs.rmSync(path.join(root, MARKER));
    const reopened = new EngineStore(root, () => 200, { executionStorage: "sqlite" });
    expect(reopened.claudeLongWindowMigration).toEqual({ sessions: 1, projects: 0 });
    expect(reopened.getSession("session_opus").model?.model).toBe("opus[1m]");
  });
});

test("legacyLongSpelling is the pre-#986 rule, and invents nothing", () => {
  expect(legacyLongSpelling("opus")).toBe("opus[1m]");
  expect(legacyLongSpelling("claude-opus-5-5")).toBe("claude-opus-5-5[1m]");
  expect(legacyLongSpelling("claude-fable-5")).toBe("claude-fable-5[1m]");
  expect(legacyLongSpelling("sonnet")).toBe("sonnet");
  expect(legacyLongSpelling("haiku")).toBe("haiku");
  expect(legacyLongSpelling("claude-opus-4-8")).toBe("claude-opus-4-8");
  expect(legacyLongSpelling("opus[1m]")).toBe("opus[1m]");
  expect(legacyLongSpelling("claude-opus-5-20260101")).toBe("claude-opus-5-20260101");
  expect(legacyLongSpelling("claude-mystery-9")).toBe("claude-mystery-9");
});
