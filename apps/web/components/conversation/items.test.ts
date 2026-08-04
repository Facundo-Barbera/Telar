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
  showsLiveStatus,
  thinkingSuppressed,
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
    // …and the index is the PART's position, not the ITEM's. The fixture makes
    // the two disagree on purpose: two coalescing tool calls collapse to one
    // item, so the id-less Read below sits at part index 3 and item index 2.
    // (With a fixture where the two coincide, this assertion cannot fail for
    // the reason its title claims — which is what it used to be.)
    const later = groupParts("m7", [tool("A", "t1"), tool("B", "t2"), text("hi"), tool("Read")]);
    expect(later.map((i) => i.kind)).toEqual(["tools", "text", "tools"]);
    expect(later[2].key).toBe("m7:3");
    expect(later[2].key).not.toBe("m7:2");
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

describe("groupParts — a TEXTLESS thinking block is not a boundary", () => {
  // The regression these exist for: the client opens a thinking part on the
  // block-START event, before any delta. Interleaved extended thinking opens one
  // per tool call, so the run was severed between every pair — and because
  // `thinkingSuppressed` draws nothing, the user saw N identical "1 step" rows
  // with no visible reason for the split.
  test("an empty thinking block between two tool calls keeps them in ONE group", () => {
    const items = groupParts("m1", [tool("Read", "t1"), thinking("", false), tool("Bash", "t2")]);
    expect(items.map((i) => i.kind)).toEqual(["tools"]);
    expect(items[0].kind === "tools" && items[0].parts.map((p) => p.name)).toEqual(["Read", "Bash"]);
  });

  test("the interleaved-thinking shape collapses to one group, not eight", () => {
    const parts: Part[] = [];
    for (let i = 0; i < 8; i += 1) {
      parts.push(thinking("", false), tool("Bash", `t${i}`));
    }
    const items = groupParts("m1", parts);
    expect(items.map((i) => i.kind)).toEqual(["tools"]);
    expect(items[0].kind === "tools" && items[0].parts.length).toBe(8);
  });

  test("whitespace-only counts as empty — same rule the renderer applies", () => {
    const items = groupParts("m1", [tool("Read", "t1"), thinking("  \n "), tool("Bash", "t2")]);
    expect(items.map((i) => i.kind)).toEqual(["tools"]);
  });

  test("a thinking block WITH text is still a real boundary", () => {
    // The skip must not widen into "thinking never splits": once a block has
    // narration it is content, and content separates two runs of work.
    const items = groupParts("m1", [tool("Read", "t1"), thinking("hmm", false), tool("Bash", "t2")]);
    expect(items.map((i) => i.kind)).toEqual(["tools", "thinking", "tools"]);
  });

  test("a skipped block consumes no key, and the parts after it keep their own index", () => {
    // Keys are part-indexed, so skipping must not renumber anything downstream.
    const items = groupParts("mK", [thinking(""), text("hi"), thinking(""), text("bye")]);
    expect(items.map((i) => i.key)).toEqual(["mK:1", "mK:3"]);
  });
});

describe("parentOf — one definition of 'main thread'", () => {
  test("a permission part is ALWAYS main — even one that arrives CARRYING a parentId", () => {
    // canUseTool gets no parent attribution from the SDK, so a permission card
    // raised by a subagent's tool call still renders on Main. Normalising here
    // is what makes grouping, streaming-merge and bucketing agree.
    expect(parentOf(permission("p1"))).toBeUndefined();
    // The case that makes this a NORMALISATION rather than a restatement of the
    // type: a permission part with the field set anyway — which the type
    // forbids and a live wire payload does not — still reports main. Without
    // this, `parentOf = (p) => p.parentId` would pass every assertion here,
    // and a permission card would enter a subagent bucket where the donor
    // rendered nothing (Completion Note 10(d)'s deleted dead arm).
    const stray = { ...permission("p2"), parentId: "spawn_9" } as unknown as Part;
    expect(parentOf(stray)).toBeUndefined();
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

  // AC-L3. This function is the ONLY part of that AC a test in this repo can
  // reach: `view.live` arriving at the tools renderer, the auto-expand and the
  // row spinner are all JSX, and there is no DOM harness here (deliberately).
  // What is proven is the decision; the pixels are a dev-server observation.
  const status = (key: string): TranscriptItem => ({
    kind: CONVERSATION_KINDS.status,
    key,
    payload: {},
  });

  test("a trailing status row does NOT demote the tools group ahead of it", () => {
    // The exact production shape: the adapter appends one status item last.
    expect(isTrailingItem([items[0], status("s")], 0)).toBe(true);
  });

  test("the two exemptions COMPOSE — a blocked tool call plus the live row", () => {
    // Neither exemption alone covers this, and it is a shape a real turn hits.
    expect(isTrailingItem([items[0], items[1], status("s")], 0)).toBe(true);
  });

  test("status is a TRAILING-RUN exemption, not 'status is ignorable anywhere'", () => {
    // Without this case the new branch is indistinguishable from a filter that
    // drops status items wherever they sit.
    const withTextAfter: TranscriptItem[] = [
      items[0],
      status("s"),
      { kind: CONVERSATION_KINDS.text, key: "t", payload: {} },
    ];
    expect(isTrailingItem(withTextAfter, 0)).toBe(false);
  });

  test("a lone status item is trailing — it IS the last item in production", () => {
    expect(isTrailingItem([status("s")], 0)).toBe(true);
  });
});

// AC-L4. NOTE ON WHAT A GREEN RESULT HERE MEANS: extended thinking only turns
// on when the SDK is given `effort`, and the composer's default omits it — so on
// a default session no thinking part is ever created and none of this is visible
// to a user. The row AC-L1 appends is the affordance that actually fires there.
// A dev-server observation of AC-L4 must therefore be done with effort
// EXPLICITLY enabled; these four cases prove the rule, not a visible change.
describe("thinkingSuppressed — no text, no box, live or finished", () => {
  test("a FINISHED block with no text renders nothing — the reload case", () => {
    expect(thinkingSuppressed({ text: "", done: true })).toBe(true);
    expect(thinkingSuppressed({ text: "   \n", done: true })).toBe(true);
  });

  test("a LIVE block with no text renders nothing EITHER — the Codex case", () => {
    // This assertion is inverted from what it was, deliberately. The live
    // exemption existed to keep the turn from going mute between "thinking
    // opened" and the first delta; the status row (showsLiveStatus) covers
    // that window now, and it counts DATA parts, so suppressing the render
    // does not suppress the row.
    //
    // What the exemption actually produced: Codex sends the block-start event
    // and no reasoning deltas, so the block never leaves this state and the
    // dashed empty box became permanent — one per start, stacked.
    expect(thinkingSuppressed({ text: "", done: false })).toBe(true);
    expect(thinkingSuppressed({ text: "  ", done: false })).toBe(true);
  });

  test("a block WITH text renders, streaming or finished", () => {
    expect(thinkingSuppressed({ text: "reasoning", done: true })).toBe(false);
    // The live case is the one that matters for Claude, which does stream
    // reasoning text: the box must appear the moment the first delta lands.
    expect(thinkingSuppressed({ text: "rea", done: false })).toBe(false);
  });
});

// AC-L2 — "live-only: never on a finished turn, never on a non-last message,
// never after reload, nothing persisted". The last two are the same clause
// mechanically: a reloaded transcript has no live work, so `hasLiveWork` is
// false and no status item is ever built. Nothing persists because the item is
// minted inside the render projection and never enters the store.
describe("showsLiveStatus — the status row's live-only rule", () => {
  const streaming = { role: "assistant", hasLiveWork: true, partCount: 2, isLast: true };

  test("a streaming LAST assistant turn with real parts gets the row", () => {
    expect(showsLiveStatus(streaming)).toBe(true);
  });

  test("a FINISHED turn does not — and neither does anything after a reload", () => {
    // `hasLiveWork` is the reload case: the store replays parts, the owner has
    // no live work, and no status item exists to be stale.
    expect(showsLiveStatus({ ...streaming, hasLiveWork: false })).toBe(false);
  });

  test("a non-last message does not, even mid-stream", () => {
    expect(showsLiveStatus({ ...streaming, isLast: false })).toBe(false);
  });

  test("an EMPTY turn does not — that window belongs to `pending`'s shimmer", () => {
    // The shell renders items OR pending, never both, so a status item here
    // would silently delete the empty-turn affordance it is meant to extend.
    expect(showsLiveStatus({ ...streaming, partCount: 0 })).toBe(false);
  });

  test("a user turn never does", () => {
    expect(showsLiveStatus({ ...streaming, role: "user" })).toBe(false);
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
