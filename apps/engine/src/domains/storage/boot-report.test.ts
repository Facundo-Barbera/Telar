import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";
import { until } from "../../../test/wait";
import { worktreeReady } from "../../../test/worktree-ready";
import { sweepCheckoutsAfterBoot } from "./boot-report";

const roots: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function storeWithCheckouts(ids: string[]) {
  const root = tmp("telar-boot-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "-c", "user.email=t@telar.local", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "initial");
  const home = tmp("telar-boot-home-");
  fs.writeFileSync(path.join(home, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  const store = new EngineStore(home, () => Date.now());
  store.projectRegistry.register({ id: "project_one", name: "One", root });
  const checkouts: Record<string, string> = {};
  for (const id of ids) {
    const session = store.lifecycle.createSession({ id, projectId: "project_one", envMode: "worktree" });
    await worktreeReady(store, id);
    if (session.workspace.mode !== "worktree") throw new Error("expected a worktree");
    checkouts[id] = session.workspace.path;
    git(root, "worktree", "unlock", session.workspace.path);
  }
  const locked = (id: string) => git(root, "worktree", "list", "--porcelain").split("\n\n").some((block) => block.startsWith(`worktree ${checkouts[id]}\n`) && /\nlocked/.test(block));
  return { store, checkouts, locked };
}

test("the boot passes lock a live checkout without one synchronous fs call on any checkout", async () => {
  const { store, checkouts, locked } = await storeWithCheckouts(["session_live", "session_settled"]);
  store.lifecycle.updateSession("session_settled", { settledOverride: "settled" });
  const touched: string[] = [];
  let syncCalls = 0;
  const syncFs = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const spies = Object.keys(fs)
    .filter((name) => name.endsWith("Sync") && typeof syncFs[name] === "function")
    .map((name) => {
      const original = syncFs[name]!;
      return spyOn(syncFs, name).mockImplementation((...args: unknown[]) => {
        const target = args[0];
        syncCalls += 1;
        if (typeof target === "string" && Object.values(checkouts).some((checkout) => target === checkout || target.startsWith(`${checkout}/`))) touched.push(`${name} ${target}`);
        return original(...args);
      });
    });
  try {
    await sweepCheckoutsAfterBoot(store, () => {});
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect(syncCalls).toBeGreaterThan(0);
  expect(touched).toEqual([]);
  expect(locked("session_live")).toBe(true);
  expect(locked("session_settled")).toBe(false);
});

test("a settled checkout the boot passes skipped is locked when a message reopens it", async () => {
  const { store, locked } = await storeWithCheckouts(["session_settled"]);
  store.lifecycle.updateSession("session_settled", { settledOverride: "settled" });
  await sweepCheckoutsAfterBoot(store, () => {});
  expect(locked("session_settled")).toBe(false);
  store.intake.submitTurn("session_settled", { runId: "run_back", input: "picking this up again" });
  await until("the reopened checkout is locked", () => locked("session_settled"));
});
