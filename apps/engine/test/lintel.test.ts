import { expect, test } from "bun:test";
import type { Session, SessionActivity } from "@telar/engine-client";
import { lintelPlan, readLintelToken } from "../src/lintel";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function session(id: string, activity: SessionActivity, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: 1,
    updatedAt: 1,
    driver: "claude",
    state: "active",
    detached: false,
    workspace: { mode: "local", path: "/tmp/x" },
    activity,
    ...overrides,
  } as Session;
}

const NAMES = new Map([["project_1", "Telar"]]);

test("live sessions become chips, blocked wears red and banners once", () => {
  const sessions = [
    session("s_work", "working", { projectId: "project_1" }),
    session("s_block", "blocked"),
    session("s_watch", "monitoring"),
    session("s_idle", "idle"),
  ];
  const { plan, next } = lintelPlan(sessions, NAMES, new Map());
  expect(plan.agents.map((agent) => `${agent.id}:${agent.status}`)).toEqual([
    "s_work:running",
    "s_block:error",
    "s_watch:running",
  ]);
  expect(plan.agents[0]!.detail).toBe("Working · Telar");
  expect(plan.banners).toHaveLength(1);
  expect(plan.banners[0]!.title).toBe("Waiting on you");

  // The next pass RE-POSTS every live chip (Lintel's 120s TTL is the whole
  // anti-ghost design) but does not re-fire the blocked banner.
  const again = lintelPlan(sessions, NAMES, next);
  expect(again.plan.agents).toHaveLength(3);
  expect(again.plan.banners).toHaveLength(0);
});

test("a session that ends posts one terminal chip, honest about failure", () => {
  const before = new Map<string, SessionActivity>([
    ["s_done", "working"],
    ["s_fail", "working"],
  ]);
  const { plan, next } = lintelPlan(
    [session("s_done", "idle"), session("s_fail", "idle", { lastTurnFailed: true })],
    NAMES,
    before,
  );
  expect(plan.agents.map((agent) => `${agent.id}:${agent.status}`)).toEqual(["s_done:done", "s_fail:error"]);
  // Terminal chips are one-shot: the following pass says nothing.
  expect(lintelPlan([session("s_done", "idle")], NAMES, next).plan.agents).toHaveLength(0);
});

test("a session deleted mid-flight is removed, not left to the TTL", () => {
  const before = new Map<string, SessionActivity>([["s_gone", "working"]]);
  const { plan } = lintelPlan([], NAMES, before);
  expect(plan.removals).toEqual(["s_gone"]);
});

test("the token file is the opt-in, and absence is silence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lintel-"));
  const tokenPath = path.join(dir, "api-token");
  expect(readLintelToken(tokenPath)).toBeUndefined();
  fs.writeFileSync(tokenPath, "  abc123\n");
  expect(readLintelToken(tokenPath)).toBe("abc123");
  fs.rmSync(dir, { recursive: true, force: true });
});
