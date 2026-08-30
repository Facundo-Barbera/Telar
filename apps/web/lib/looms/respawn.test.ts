/**
 * The recovery point's one law: green-verified threads are NEVER respawned —
 * green means the branch carries accepted-grade evidence, and re-seeding
 * would reset it. Everything else (dead, red, unspawned) is fair game.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineClient } from "@telar/engine-client";
import { getLoom, newLoom, saveLoom } from "./store";
import { respawnLoomThreads } from "./respawn";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-respawn-"));
  previousHome = process.env.TELAR_HOME;
  process.env.TELAR_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function fakeClient(log: { archived: string[]; created: string[] }): EngineClient {
  let n = 0;
  return {
    archiveSession: async (id: string) => {
      log.archived.push(id);
    },
    createSession: async () => {
      const id = `session_fresh_${++n}`;
      log.created.push(id);
      return { session: { id, workspace: { mode: "worktree", branch: `loom/x/${n}` } } };
    },
    submitTurn: async () => ({}),
  } as unknown as EngineClient;
}

test("respawn retires dead sessions, refuses green ones, and re-seeds from the plans", async () => {
  const loom = newLoom({
    title: "Hito X",
    objective: "test",
    projectId: "p",
    threads: [
      { slug: "dead", title: "dead", brief: "b" },
      { slug: "green", title: "green", brief: "b" },
    ],
  });
  loom.threads[0].sessionId = "session_dead";
  loom.threads[1].sessionId = "session_green";
  loom.threads[1].verification = { tier: "smoke", ok: true, at: Date.now() };
  saveLoom(loom);

  const log = { archived: [] as string[], created: [] as string[] };
  const result = await respawnLoomThreads(loom.id, fakeClient(log), { actor: "human" });

  expect(result.respawned).toEqual(["dead"]);
  expect(result.refused).toEqual([]); // green was never targeted: default scope is non-green only
  expect(log.archived).toEqual(["session_dead"]);
  expect(log.created.length).toBe(1);

  const after = getLoom(loom.id)!;
  expect(after.threads.find((t) => t.slug === "green")!.sessionId).toBe("session_green");
  expect(after.threads.find((t) => t.slug === "dead")!.sessionId).toBe("session_fresh_1");
  expect(after.threads.find((t) => t.slug === "dead")!.verification).toBeUndefined();
});

test("an explicit request for a green thread is refused, not obeyed", async () => {
  const loom = newLoom({
    title: "Hito Y",
    objective: "test",
    projectId: "p",
    threads: [{ slug: "green", title: "green", brief: "b" }],
  });
  loom.threads[0].sessionId = "session_green";
  loom.threads[0].verification = { tier: "smoke", ok: true, at: Date.now() };
  saveLoom(loom);

  const log = { archived: [] as string[], created: [] as string[] };
  const result = await respawnLoomThreads(loom.id, fakeClient(log), { threads: ["green", "ghost"], actor: "conductor" });

  expect(result.respawned).toEqual([]);
  expect(result.refused).toEqual(["green (verified green)", "ghost (unknown)"]);
  expect(log.archived).toEqual([]);
  expect(log.created).toEqual([]);
  expect(getLoom(loom.id)!.threads[0].sessionId).toBe("session_green");
});
