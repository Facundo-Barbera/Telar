// Provider-neutral subagent lifecycle mapping for the Codex app-server wire.
// This is kept as a pure adapter test: no subprocess, network, or real agent.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  normalizeCodexAutoCompact,
  normalizeCodexSubagentActivity,
  normalizeCodexSubagentLifecycle,
  normalizeCodexObservedChild,
  normalizeCodexSubagentThreadStarted,
} from "./codex-app-server";

const spawn = (over: Record<string, unknown> = {}) => ({
  type: "collabAgentToolCall",
  tool: "spawnAgent",
  senderThreadId: "root",
  receiverThreadIds: ["child-1"],
  prompt: "inspect the queue",
  model: "gpt-5",
  agentsStates: { "child-1": { status: "running", message: null } },
  ...over,
});

describe("Codex subagent lifecycle", () => {
  test("emits a child from thread/started even when no collab tool item exists", () => {
    const started = new Set<string>();
    expect(normalizeCodexSubagentThreadStarted({
      id: "child-live",
      parentThreadId: "root",
      preview: "inspect package.json",
      agentNickname: "Goodall",
    }, "root", started)).toEqual([{
      type: "spawn",
      parentThreadId: "root",
      childThreadId: "child-live",
      prompt: "inspect package.json",
      model: null,
    }]);
    expect(normalizeCodexSubagentThreadStarted({
      id: "child-live",
      parentThreadId: "root",
    }, "root", started)).toEqual([]);
  });

  test("ignores the root thread/started duplicate", () => {
    expect(normalizeCodexSubagentThreadStarted({
      id: "root",
      parentThreadId: null,
    }, "root", new Set())).toEqual([]);
  });

  test("uses subAgentActivity started as a root-child fallback", () => {
    expect(normalizeCodexSubagentActivity({
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "child-live",
      agentPath: "/root/package_name",
    }, "root", new Set())).toEqual([{
      type: "spawn",
      parentThreadId: "root",
      childThreadId: "child-live",
      prompt: "/root/package_name",
      model: null,
    }]);
  });

  test("creates the bucket before the first observed child-thread item", () => {
    const started = new Set<string>();
    expect(normalizeCodexObservedChild("child-live", "root", started)).toEqual([{
      type: "spawn",
      parentThreadId: "root",
      childThreadId: "child-live",
      prompt: "",
      model: null,
    }]);
    expect(normalizeCodexObservedChild("child-live", "root", started)).toEqual([]);
    expect(normalizeCodexObservedChild("root", "root", started)).toEqual([]);
  });

  test("emits spawn from the first item/started shape, before any terminal state", () => {
    const events = normalizeCodexSubagentLifecycle(spawn(), new Set(), new Set());
    expect(events).toEqual([
      {
        type: "spawn",
        parentThreadId: "root",
        childThreadId: "child-1",
        prompt: "inspect the queue",
        model: "gpt-5",
      },
    ]);
  });

  test("falls back to a later snapshot when item/started did not identify the child", () => {
    const started = new Set<string>();
    const settled = new Set<string>();
    expect(normalizeCodexSubagentLifecycle(
      spawn({ receiverThreadIds: [], agentsStates: {} }),
      started,
      settled,
    )).toEqual([]);
    expect(normalizeCodexSubagentLifecycle(spawn(), started, settled)).toEqual([
      expect.objectContaining({ type: "spawn", childThreadId: "child-1" }),
    ]);
  });

  test("deduplicates repeated start snapshots", () => {
    const started = new Set<string>();
    const settled = new Set<string>();
    expect(normalizeCodexSubagentLifecycle(spawn(), started, settled)).toHaveLength(1);
    expect(normalizeCodexSubagentLifecycle(spawn(), started, settled)).toEqual([]);
  });

  test.each([
    ["completed", "completed", false],
    ["errored", "failed", true],
    ["notFound", "failed", true],
    ["interrupted", "stopped", true],
    ["shutdown", "stopped", true],
  ] as const)(
    "maps terminal wire state %s to %s",
    (
      wire: "completed" | "errored" | "notFound" | "interrupted" | "shutdown",
      status: "completed" | "failed" | "stopped",
      isError: boolean,
    ) => {
      const started = new Set(["child-1"]);
      const settled = new Set<string>();
      const events = normalizeCodexSubagentLifecycle(
        spawn({ agentsStates: { "child-1": { status: wire, message: wire } } }),
        started,
        settled,
      );
      expect(events).toEqual([
        {
          type: "spawn_result",
          childThreadId: "child-1",
          output: wire,
          isError,
          status,
        },
      ]);
      expect(normalizeCodexSubagentLifecycle(
        spawn({ agentsStates: { "child-1": { status: wire, message: wire } } }),
        started,
        settled,
      )).toEqual([]);
    },
  );

  test("emits start before terminal when both first appear in one snapshot", () => {
    const events = normalizeCodexSubagentLifecycle(
      spawn({ agentsStates: { "child-1": { status: "completed", message: "done" } } }),
      new Set(),
      new Set(),
    );
    expect(events.map((event) => event.type)).toEqual(["spawn", "spawn_result"]);
  });

  test("does not mistake wait/send/close collab calls for new spawns", () => {
    const events = normalizeCodexSubagentLifecycle(
      spawn({ tool: "wait", receiverThreadIds: ["child-2"] }),
      new Set(),
      new Set(),
    );
    expect(events).toEqual([]);
  });

  // Keyed on a completed "contextCompaction" ITEM, not the `thread/compacted`
  // notification method — live-traced against a real `codex app-server`
  // 0.145.0 process (see codex-app-server.ts's comment on this function):
  // thread/compact/start never actually produced a `thread/compacted`
  // notification, success or failure. The (deprecated)
  // ContextCompactedNotification type is why the earlier version of this
  // test — and the code it exercised — was wrong in a way `tsc` and a mocked
  // unit test both happily missed.
  test("normalizes a root-thread contextCompaction item into an auto compact_end", () => {
    expect(normalizeCodexAutoCompact("contextCompaction", "root", "root")).toEqual([
      { type: "compact_end", trigger: "auto", summary: null },
    ]);
  });

  test("ignores a subagent thread's own compaction — no bucket to attribute it to yet", () => {
    expect(normalizeCodexAutoCompact("contextCompaction", "child-1", "root")).toEqual([]);
  });

  test("ignores every other item type", () => {
    expect(normalizeCodexAutoCompact("agentMessage", "root", "root")).toEqual([]);
  });

  test("a later wait snapshot can settle a child that was already started", () => {
    const events = normalizeCodexSubagentLifecycle(
      spawn({
        tool: "wait",
        agentsStates: { "child-1": { status: "completed", message: "finished later" } },
      }),
      new Set(["child-1"]),
      new Set(),
    );
    expect(events).toEqual([
      {
        type: "spawn_result",
        childThreadId: "child-1",
        output: "finished later",
        isError: false,
        status: "completed",
      },
    ]);
  });
});
