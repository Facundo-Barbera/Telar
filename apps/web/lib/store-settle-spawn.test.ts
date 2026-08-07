// A DEAD WINDOW CLAIMS NO RUNNING AGENTS (#28 turn-as-event). Pins
// settleSpawnStatuses' two modes: targeted ids (the route's settle path,
// repairing copies appendTurn persisted before the window outlived the turn)
// and the sweep (the repair path for sessions written before the settle
// linger existed — their tabs shimmered "running" forever after a reload).

// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it.
// @ts-expect-error no @types/bun in this workspace
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "telar-settle-"));
process.env.TELAR_HOME = TMP;
beforeEach(() => {
  process.env.TELAR_HOME = TMP;
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const store = await import("./store");

const ACK =
  "Async agent launched successfully. (This tool result is internal metadata — agentId: abc)";

let n = 0;
function seedChatWithSpawns(): string {
  const id = `settle-${++n}`;
  store.upsertChatStub({ id, model: "sonnet", account: "personal", userText: "spawn" });
  store.appendTurn({
    id,
    model: "sonnet",
    account: "personal",
    userMessage: { role: "user", parts: [{ type: "text", text: "spawn" }] },
    assistantMessage: {
      role: "assistant",
      parts: [
        { type: "tool", name: "Agent", id: "sp-acked", output: ACK, agent: { type: "claude", description: "a" } },
        { type: "tool", name: "Agent", id: "sp-done", output: ACK, taskStatus: "completed", agent: { type: "claude", description: "b" } },
        { type: "tool", name: "Agent", id: "sp-sync", output: "a real synchronous result", agent: { type: "claude", description: "c" } },
        { type: "tool", name: "Read", id: "t-plain", output: "file contents" },
      ],
    },
    costUsd: 0,
  });
  return id;
}

function statusesOf(id: string): Record<string, string | undefined> {
  const chat = store.getChat(id)!;
  const out: Record<string, string | undefined> = {};
  for (const m of chat.messages) {
    for (const p of m.parts) {
      if (p.type === "tool" && p.id) out[p.id] = p.taskStatus;
    }
  }
  return out;
}

describe("settleSpawnStatuses", () => {
  test("targeted ids mark exactly those spawns stopped", () => {
    const id = seedChatWithSpawns();
    expect(store.settleSpawnStatuses(id, ["sp-acked"])).toBe(true);
    const statuses = statusesOf(id);
    expect(statuses["sp-acked"]).toBe("stopped");
    expect(statuses["sp-done"]).toBe("completed");
    expect(statuses["sp-sync"]).toBeUndefined();
  });

  test("the sweep settles ack-only spawns, never completed or synchronous ones", () => {
    const id = seedChatWithSpawns();
    expect(store.settleSpawnStatuses(id)).toBe(true);
    const statuses = statusesOf(id);
    expect(statuses["sp-acked"]).toBe("stopped");
    // A recorded completion is authoritative — never overwritten.
    expect(statuses["sp-done"]).toBe("completed");
    // A synchronous spawn's output IS its result — it finished, not stopped.
    expect(statuses["sp-sync"]).toBeUndefined();
    // Plain tools have no agent and are never touched.
    expect(statuses["t-plain"]).toBeUndefined();
    // Nothing left to change → false, no write.
    expect(store.settleSpawnStatuses(id)).toBe(false);
  });

  test("an unknown chat changes nothing", () => {
    expect(store.settleSpawnStatuses("no-such-chat")).toBe(false);
  });
});

describe("recordTaskStatuses", () => {
  test("writes post-turn completions through to persisted spawn parts", () => {
    const id = seedChatWithSpawns();
    expect(
      store.recordTaskStatuses(id, [
        { toolUseId: "sp-acked", status: "completed" },
        { toolUseId: "no-such-part", status: "failed" },
      ]),
    ).toBe(true);
    expect(statusesOf(id)["sp-acked"]).toBe("completed");
    // Idempotent: same statuses again → nothing changes, no write.
    expect(store.recordTaskStatuses(id, [{ toolUseId: "sp-acked", status: "completed" }])).toBe(
      false,
    );
    // A recorded completion keeps the sweep off it forever after.
    store.settleSpawnStatuses(id);
    expect(statusesOf(id)["sp-acked"]).toBe("completed");
  });

  test("an empty update list or unknown chat changes nothing", () => {
    expect(store.recordTaskStatuses("no-such-chat", [{ toolUseId: "x", status: "stopped" }])).toBe(
      false,
    );
    const id = seedChatWithSpawns();
    expect(store.recordTaskStatuses(id, [])).toBe(false);
  });
});
