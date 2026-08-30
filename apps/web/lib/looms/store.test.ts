/**
 * The loom model v1's load-bearing facts (docs/loom-model-v1.md): names come
 * from the work, detachment subtracts owned sessions from the ordinary
 * surface, and state is derived from evidence, never stored.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendJournal,
  deleteDraftLoom,
  findLoomBySession,
  getLoom,
  loomOwnedSessionIds,
  loomState,
  newLoom,
  readJournal,
  readSpec,
  slugify,
  uniqueLoomSlug,
  writeSpec,
} from "./store";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-looms-"));
  previousHome = process.env.TELAR_HOME;
  process.env.TELAR_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("slugs come from the work, not the machinery", () => {
  expect(slugify("Hito 1 · Agosto")).toBe("hito-1-agosto");
  expect(slugify("Fix «Presupuestos» login!")).toBe("fix-presupuestos-login");
  expect(slugify("···")).toBe("loom");
});

test("a colliding slug gets a suffix rather than sharing branches", () => {
  const first = newLoom({ title: "Hito 1", objective: "x", projectId: "p", threads: [] });
  expect(first.slug).toBe("hito-1");
  const second = newLoom({ title: "Hito 1", objective: "y", projectId: "p", threads: [] });
  expect(second.slug).toBe("hito-1-2");
  expect(uniqueLoomSlug("hito-1", [first, second])).toBe("hito-1-3");
});

test("detachment: origin AND threads are owned, and the subtraction set says so", () => {
  newLoom({
    title: "Hito 1",
    objective: "x",
    projectId: "p",
    originSessionId: "session_origin",
    threads: [
      { sessionId: "session_a", slug: "a", title: "A", brief: "..." },
      { sessionId: "session_b", slug: "b", title: "B", brief: "..." },
    ],
  });
  const owned = loomOwnedSessionIds();
  expect(owned.has("session_origin")).toBe(true);
  expect(owned.has("session_a")).toBe(true);
  expect(owned.has("session_b")).toBe(true);
  expect(owned.has("session_unrelated")).toBe(false);
  expect(findLoomBySession("session_origin")?.title).toBe("Hito 1");
});

test("a gate parks the loom in waiting, and so does an unspawned plan", () => {
  // The two shapes of "you are what it is waiting for": an explicit human
  // gate on a phase, and threads that are still plans (no sessions).
  const draft = newLoom({
    title: "Draft",
    objective: "x",
    projectId: "p",
    phases: [
      { id: "plan", kind: "plan", gate: "human", status: "done" },
      { id: "execute", kind: "execute", gate: "human", status: "waiting" },
    ],
    threads: [{ slug: "a", title: "A", brief: "..." }],
  });
  expect(loomState(draft)).toBe("waiting");
  // Gate cleared but still unspawned (mid-approve crash): still waiting, never "ready".
  draft.phases![1]!.status = "running";
  expect(loomState(draft)).toBe("waiting");
  // Spawned: the ordinary lifecycle takes over.
  draft.threads[0]!.sessionId = "session_a";
  expect(loomState(draft)).toBe("working");
});

test("only a draft can be discarded, and its document goes with it", () => {
  const draft = newLoom({ title: "D", objective: "x", projectId: "p", threads: [{ slug: "a", title: "A", brief: "..." }] });
  writeSpec(draft.id, "# spec");
  expect(readSpec(draft.id)).toBe("# spec");
  expect(deleteDraftLoom(draft.id)).toBe(true);
  expect(getLoom(draft.id)).toBeUndefined();
  expect(readSpec(draft.id)).toBeNull();

  const live = newLoom({ title: "L", objective: "x", projectId: "p", threads: [{ slug: "a", title: "A", brief: "...", sessionId: "s1" }] });
  expect(deleteDraftLoom(live.id)).toBe(false);
  expect(getLoom(live.id)).toBeDefined();
});

test("the journal is append-only, timestamped, and tail-readable", () => {
  const loom = newLoom({ title: "J", objective: "x", projectId: "p", threads: [] });
  appendJournal(loom.id, "weaver", "proposed 2 threads");
  appendJournal(loom.id, "conductor", "wait: all threads working\nmultiline is flattened");
  const tail = readJournal(loom.id);
  expect(tail).toContain("**weaver**: proposed 2 threads");
  expect(tail).toContain("**conductor**: wait");
  expect(tail).not.toContain("\nmultiline");
  expect(readJournal(loom.id, 1).split("\n")).toHaveLength(1);
});

test("state is what the evidence says: green everywhere is ready, a human stamp is accepted", () => {
  const loom = newLoom({
    title: "L",
    objective: "x",
    projectId: "p",
    threads: [
      { sessionId: "s1", slug: "s1", title: "1", brief: "...", verification: { tier: "unit", ok: true, at: 1 } },
      { sessionId: "s2", slug: "s2", title: "2", brief: "...", verification: { tier: "unit", ok: true, at: 1 } },
    ],
  });
  expect(loomState(loom)).toBe("ready");
  expect(loomState({ ...loom, acceptedAt: 2 })).toBe("accepted");
  loom.threads[1]!.verification = { tier: "unit", ok: false, at: 1 };
  expect(loomState(loom)).toBe("verifying");
  delete loom.threads[0]!.verification;
  delete loom.threads[1]!.verification;
  expect(loomState(loom)).toBe("working");
});
