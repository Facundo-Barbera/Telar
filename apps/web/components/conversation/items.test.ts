// THE PROJECTION'S FIRST TEST. `groupParts` has driven every transcript this
// app has ever rendered and has never had one — it moved out of a 3335-line
// component in story 3.1, and the move is the moment to pin it.
//
// HONEST GAP, stated rather than papered over: there is NO DOM test harness in
// this repository (no *.test.tsx, no testing-library, no happy-dom, no jsdom —
// measured), and story 3.1 forbids introducing one. So nothing here proves that
// the shell RENDERS identically to the donor it was carved from. That claim
// rests on the move being byte-identical and on the dev-server proof, and on
// nothing else. What IS proven here is everything the projection decides BEFORE
// a single element is created: what coalesces, what breaks a group, what a key
// is, and which built-in kind each chunk becomes.

// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_KINDS,
  agentStatus,
  groupParts,
  isTrailingItem,
  parentOf,
  toTranscriptItem,
  toTranscriptItems,
  type Part,
  type PermissionPart,
  type RenderItem,
  type TranscriptItem,
} from "./items";

const tool = (name: string, id?: string, extra: Record<string, unknown> = {}): Part =>
  ({ type: "tool", name, ...(id ? { id } : {}), ...extra }) as Part;
const text = (t: string, parentId?: string): Part => ({
  type: "text",
  text: t,
  done: true,
  ...(parentId ? { parentId } : {}),
});
const thinking = (t: string, done = true): Part => ({ type: "thinking", text: t, done });
const permission = (id: string, status: PermissionPart["status"] = "pending"): Part => ({
  type: "permission",
  id,
  toolName: "Bash",
  input: { command: "rm -rf /" },
  rule: "Bash(rm:*)",
  ruleOptions: [{ rule: "Bash(rm:*)", label: "any rm" }],
  status,
});

describe("groupParts — consecutive tool parts coalesce into one group", () => {
  test("three tool calls in a row are ONE group, in order", () => {
    const items = groupParts("m1", [tool("Read", "t1"), tool("Bash", "t2"), tool("Glob", "t3")]);
    expect(items.length).toBe(1);
    expect(items[0].kind).toBe("tools");
    expect(items[0].kind === "tools" && items[0].parts.map((p) => p.name)).toEqual([
      "Read",
      "Bash",
      "Glob",
    ]);
  });

  test("a group's key is its FIRST tool part's tool_use id", () => {
    const items = groupParts("m1", [tool("Read", "t1"), tool("Bash", "t2")]);
    expect(items[0].key).toBe("t1");
  });

  test("a tool part with no id falls back to `messageId:idx`", () => {
    // Old persisted chats predate the id field. The fallback is stable ONLY
    // because parts are append-only and never reordered — the day that stops
    // being true, this key names the wrong slot.
    const items = groupParts("m7", [tool("Read")]);
    expect(items[0].key).toBe("m7:0");
    // …and the index is the part's position, not the item's.
    const later = groupParts("m7", [text("hi"), tool("Read")]);
    expect(later[1].key).toBe("m7:1");
  });
});

describe("groupParts — what breaks a group", () => {
  const cases: Array<[string, Part, RenderItem["kind"]]> = [
    ["text", text("answer"), "text"],
    ["thinking", thinking("hmm"), "thinking"],
    ["permission", permission("p1"), "permission"],
  ];

  for (const [label, breaker, expectedKind] of cases) {
    test(`a ${label} part between two tool calls splits them into two groups`, () => {
      const items = groupParts("m1", [tool("Read", "t1"), breaker, tool("Bash", "t2")]);
      expect(items.map((i) => i.kind)).toEqual(["tools", expectedKind, "tools"]);
      // …and the two groups are genuinely separate, not one group re-keyed.
      expect(items[0].key).not.toBe(items[2].key);
    });
  }

  test("every non-tool part is message-scoped and keyed by its own index", () => {
    const items = groupParts("mA", [text("one"), thinking("two"), permission("p1")]);
    expect(items.map((i) => i.key)).toEqual(["mA:0", "mA:1", "mA:2"]);
  });

  test("an empty parts list projects to an empty item list", () => {
    expect(groupParts("m1", [])).toEqual([]);
  });
});

describe("parentOf — one definition of 'main thread'", () => {
  test("a permission part is ALWAYS main, even though it has no parentId field", () => {
    // canUseTool gets no parent attribution from the SDK, so a permission card
    // raised by a subagent's tool call still renders on Main. Normalising here
    // is what makes grouping, streaming-merge and bucketing agree.
    expect(parentOf(permission("p1"))).toBeUndefined();
  });

  test("a part with a parentId reports it; one without reports undefined", () => {
    expect(parentOf(text("x", "spawn_1"))).toBe("spawn_1");
    expect(parentOf(text("x"))).toBeUndefined();
    expect(parentOf(tool("Read", "t1", { parentId: "spawn_2" }))).toBe("spawn_2");
  });
});

describe("the RenderItem → TranscriptItem mapping", () => {
  test("each of the four RenderItem variants maps to its built-in conversation:* kind", () => {
    const rendered = groupParts("m1", [
      text("answer"),
      thinking("hmm"),
      permission("p1"),
      tool("Read", "t1"),
    ]);
    expect(toTranscriptItems(rendered).map((i) => i.kind)).toEqual([
      CONVERSATION_KINDS.text,
      CONVERSATION_KINDS.thinking,
      CONVERSATION_KINDS.permission,
      CONVERSATION_KINDS.tools,
    ]);
  });

  test("keys survive the mapping unchanged — the envelope re-labels, it does not re-key", () => {
    const rendered = groupParts("m3", [text("a"), tool("Read", "t9")]);
    expect(toTranscriptItems(rendered).map((i) => i.key)).toEqual(rendered.map((i) => i.key));
  });

  test("owner behaviour arrives THROUGH THE PAYLOAD, never through context", () => {
    const onRespond = () => {};
    const onSelectAgent = () => {};
    const agentSteps = () => 3;
    const rendered = groupParts("m1", [permission("p1"), tool("Task", "t1")]);
    const [perm, tools] = toTranscriptItems(rendered, { onRespond, onSelectAgent, agentSteps });
    expect((perm.payload as { onRespond?: unknown }).onRespond).toBe(onRespond);
    expect((tools.payload as { onSelectAgent?: unknown }).onSelectAgent).toBe(onSelectAgent);
    expect((tools.payload as { agentSteps?: unknown }).agentSteps).toBe(agentSteps);
  });

  test("a READ-ONLY surface simply omits the callbacks — the payload stays valid", () => {
    // This is the whole mechanism behind "any transcript can render any kind":
    // TranscriptView builds the same payload with onRespond absent and the card
    // degrades to non-interactive. Nothing about the kind changes.
    const [perm] = toTranscriptItems(groupParts("m1", [permission("p1")]));
    expect((perm.payload as { onRespond?: unknown }).onRespond).toBeUndefined();
    expect(perm.kind).toBe(CONVERSATION_KINDS.permission);
  });

  test("the permission payload carries the WHOLE part, not a copy of some of it", () => {
    const part = permission("p1", "denied") as PermissionPart;
    const item = toTranscriptItem({ kind: "permission", key: "k", part });
    expect((item.payload as { part: PermissionPart }).part).toBe(part);
  });

  test("the thinking payload carries text AND done — the two the renderer branches on", () => {
    const item = toTranscriptItem({
      kind: "thinking",
      key: "k",
      part: { type: "thinking", text: "mid-stream", done: false },
    });
    expect(item.payload).toEqual({ text: "mid-stream", done: false });
  });
});

describe("isTrailingItem — the donor's liveness rule, kept in ONE place", () => {
  const items: TranscriptItem[] = [
    { kind: CONVERSATION_KINDS.tools, key: "a", payload: {} },
    { kind: CONVERSATION_KINDS.permission, key: "b", payload: {} },
    { kind: CONVERSATION_KINDS.permission, key: "c", payload: {} },
  ];

  test("a trailing run of permission items does NOT end a group's liveness", () => {
    // A pending/just-resolved permission card is not a new unit of finished
    // work — it is the same blocked tool call still waiting on the user.
    expect(isTrailingItem(items, 0)).toBe(true);
  });

  test("anything else after an item DOES end it", () => {
    const withText: TranscriptItem[] = [
      items[0],
      { kind: CONVERSATION_KINDS.text, key: "t", payload: {} },
    ];
    expect(isTrailingItem(withText, 0)).toBe(false);
  });

  test("the last item is always trailing", () => {
    expect(isTrailingItem(items, items.length - 1)).toBe(true);
    expect(isTrailingItem([], 0)).toBe(true);
  });
});

describe("agentStatus — the bucket status the transcript derives, not stores", () => {
  test("taskStatus is authoritative when present", () => {
    expect(agentStatus({ type: "tool", name: "Task", taskStatus: "completed" })).toBe("done");
    expect(agentStatus({ type: "tool", name: "Task", taskStatus: "failed" })).toBe("error");
    expect(agentStatus({ type: "tool", name: "Task", taskStatus: "stopped" })).toBe("error");
  });

  test("no output yet reads as running — unless the turn was interrupted", () => {
    expect(agentStatus({ type: "tool", name: "Task" })).toBe("running");
    expect(agentStatus({ type: "tool", name: "Task", interrupted: true })).toBe("error");
  });

  test("an async LAUNCH ACK is not a result — the spawn is still running", () => {
    expect(
      agentStatus({ type: "tool", name: "Task", output: "Async agent launched successfully" }),
    ).toBe("running");
    expect(agentStatus({ type: "tool", name: "Task", output: "the real answer" })).toBe("done");
    expect(
      agentStatus({ type: "tool", name: "Task", output: "the real answer", isError: true }),
    ).toBe("error");
  });
});
