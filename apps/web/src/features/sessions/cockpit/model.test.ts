// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JournalItem } from "@/platform/engine";
import { cutAroundLiveAgents, segmentActivity, transcriptTasks, turnActivity } from "@/features/transcript";
import { cockpitPlugins, describeTurnState, pinToggleOverride, transcriptRows } from "./model";
import { SessionTurn } from "./components/session-turn";

const rendered = { runId: "run_1", sessionId: "session_1", status: "completed", startedAt: 1, completedAt: 2, streamedText: "", openedBy: 0 } as const;
const prose = (id: string, text: string): JournalItem => ({ ...rendered, id, detail: { type: "assistant_message", text } });
const steer = (id: string, detail: Record<string, unknown>): JournalItem => ({ ...rendered, id, detail: { type: "user_message", ...detail } }) as JournalItem;
const renderTurn = (items: JournalItem[], live = true) =>
  renderToStaticMarkup(
    createElement(SessionTurn, {
      turn: { runId: "run_1", origin: "user", prompt: "Start", state: live ? "running" : "completed", resultText: "", items, tasks: [] },
      requests: [],
      sending: false,
      live,
      onDecide: () => {},
      onRetry: () => {},
    }),
  );

describe("session workspace presentation", () => {
  test("names every durable turn state without relying on colour", () => {
    expect(describeTurnState("queued")).toEqual({ label: "Queued", tone: "active" });
    expect(describeTurnState("claimed")).toEqual({ label: "Claimed", tone: "active" });
    expect(describeTurnState("running")).toEqual({ label: "Streaming", tone: "active" });
    expect(describeTurnState("completed")).toEqual({ label: "Completed", tone: "done" });
    expect(describeTurnState("failed")).toEqual({ label: "Failed", tone: "danger" });
    expect(describeTurnState("stopped")).toEqual({ label: "Stopped", tone: "muted" });
  });

  test("keeps recovery state explicit rather than implying a replay", () => {
    expect(describeTurnState("ambiguous")).toEqual({ label: "Needs recovery decision", tone: "attention" });
    expect(describeTurnState("discarded")).toEqual({ label: "Discarded after recovery decision", tone: "muted" });
  });
});

describe("a live turn folds as it works", () => {
  const item = (id: string, type: string) => ({ id, detail: { type } }) as never;

  test("runs of work are cut at prose, steers, plans and compactions", () => {
    const segments = segmentActivity([
      item("a", "command_execution"),
      item("b", "file_read"),
      item("c", "assistant_message"),
      item("d", "command_execution"),
      item("e", "user_message"),
      item("f", "plan"),
      item("g", "context_compaction"),
      item("h", "file_change"),
    ]);
    expect(segments.map((s) => (s.kind === "row" ? s.item.id : s.items.map((i) => i.id).join("")))).toEqual([
      "ab", "c", "d", "e", "f", "g", "h",
    ]);
  });

  test("reasoning and spawns stay inside the run they happened in", () => {
    // Thinking is work, not a seam; a `task` item is the spawn itself and
    // ActivityGroup already knows not to count it.
    const segments = segmentActivity([item("a", "reasoning"), item("b", "task"), item("c", "command_execution")]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("run");
  });

  test("an empty timeline has no segments", () => {
    expect(segmentActivity([])).toEqual([]);
  });
});

describe("a sub-agent is a row where it was spawned, and never folds while it is out", () => {
  const item = (id: string, type: string, taskId?: string) => ({ id, detail: taskId ? { type, taskId } : { type } }) as never;
  const task = (id: string, state = "running") => ({ id, kind: "agent", state, items: [] }) as never;

  test("a settled run is cut around a spawn whose agent is still running", () => {
    const cuts = cutAroundLiveAgents(
      [item("a", "command_execution"), item("b", "task", "t1"), item("c", "file_read"), item("d", "task", "t2"), item("e", "command_execution")],
      [task("t1", "running"), task("t2", "completed")],
    );
    expect(cuts.map((cut) => (cut.kind === "agent" ? `agent:${cut.item.id}` : cut.items.map((i) => i.id).join("")))).toEqual(["a", "agent:b", "cde"]);
  });

  test("a spawn whose agent has settled folds with the rest of the run", () => {
    const cuts = cutAroundLiveAgents([item("a", "command_execution"), item("b", "task", "t1")], [task("t1", "completed")]);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.kind).toBe("run");
  });

  test("a spawn whose task has not reported yet folds — nothing live to protect", () => {
    const cuts = cutAroundLiveAgents([item("b", "task", "t9")], []);
    expect(cuts.map((cut) => cut.kind)).toEqual(["run"]);
  });
});

describe("what a live turn says it is doing", () => {
  const turn = (over: Partial<{ items: unknown[]; tasks: unknown[] }> = {}) =>
    ({ items: [], tasks: [], ...over }) as Parameters<typeof turnActivity>[0];
  const task = (over: Record<string, unknown> = {}) =>
    ({ id: "t", sessionId: "s", runId: "r", kind: "agent", state: "running", startedAt: 1, updatedAt: 1, items: [], ...over }) as never;

  test("a fan-out says how many agents are out, not that the main loop is thinking", () => {
    // "Thinking 43s" beside four sub-agent chips describes the machinery rather
    // than the work: the main loop IS idle, and saying so is the least useful
    // true thing available.
    expect(turnActivity(turn({ tasks: [task(), task({ id: "t2" })] }))).toEqual({
      label: "2 sub-agents working",
      delegated: true,
    });
    expect(turnActivity(turn({ tasks: [task()] })).label).toBe("1 sub-agent working");
  });

  test("a finished sub-agent stops speaking for the turn", () => {
    expect(turnActivity(turn({ tasks: [task({ state: "completed" })] })).label).toBe("Thinking");
  });

  test("background work does not claim the main loop is busy", () => {
    // A watch loop running says nothing about what the agent is doing, and it
    // outlives the turn anyway.
    expect(turnActivity(turn({ tasks: [task({ kind: "background" })] })).label).toBe("Thinking");
  });

  test("a running tool is Working; nothing running is Thinking", () => {
    expect(turnActivity(turn({ items: [{ status: "inProgress" }] })).label).toBe("Working");
    expect(turnActivity(turn({ items: [{ status: "completed" }] })).label).toBe("Thinking");
  });

  test("a backgrounded shell is not a chip in the conversation", () => {
    const shell = task({ id: "verify", kind: "background", title: "Run full verify" });
    expect(transcriptTasks([shell, task({ id: "agent" })]).map((t) => t.id)).toEqual(["agent"]);
    expect(transcriptTasks([shell])).toEqual([]);
  });

  test("`kind` is the whole filter — no background row survives it", () => {
    const run = task({ id: "run", kind: "background", title: "find-flaky-tests" });
    const child = task({ id: "child" });
    const shell = task({ id: "tail", kind: "background", title: "tail -f dev.log" });
    expect(transcriptTasks([run, child, shell]).map((t) => t.id)).toEqual(["child"]);
  });

  test("an unrecognised kind stays a chip, matching the contract's denylist", () => {
    // The contract is denylist-shaped on purpose: a provider that renames its
    // agent-flavoured task types must produce an unstyled chip, never an
    // invisible one. Only `background` is filtered.
    expect(transcriptTasks([task({ id: "novel", kind: "local_workflow" })]).map((t) => t.id)).toEqual(["novel"]);
  });

  test("a compaction outranks everything the line could say", () => {
    // While the provider squeezes its memory it is not working on the task,
    // and "Thinking" over that long silence is the read this line prevents.
    expect(
      turnActivity(
        turn({
          items: [{ status: "inProgress", detail: { type: "context_compaction" } }],
          tasks: [task()],
        }),
      ).label,
    ).toBe("Compacting context");
  });
});

describe("a message another agent sent is labelled as an agent's, never the person's", () => {
  test("the label names the sending session, or says the sender was outside any session", async () => {
    const { agentSenderLabel } = await import("@/features/transcript/components/conversation-message");
    expect(agentSenderLabel({ sessionId: "session_abcdef123456" })).toBe("agent · session …123456");
    expect(agentSenderLabel({})).toBe("agent · outside any session");
  });
  test("the journal keeps the sender so the transcript can draw it", async () => {
    const { projectJournal } = await import("@/platform/engine");
    const [turn] = projectJournal(
      [{ runId: "run_a", sessionId: "s1", sequence: 1, input: "do it", state: "queued", origin: "session", sender: { sessionId: "session_boss" }, acceptedAt: 1, updatedAt: 1 }],
      [],
      [],
    );
    expect(turn).toMatchObject({ origin: "session", sender: { sessionId: "session_boss" }, prompt: "do it" });
  });
});

describe("a wake is a wake wherever it lands — never the person's bubble", () => {
  test("both surfaces name a wake with ONE vocabulary", async () => {
    const { sessionWakeLabel } = await import("@/features/transcript");
    expect(sessionWakeLabel({ kind: "turn_completed", sessionId: "s" }).verb).toBe("Session finished a turn");
    expect(sessionWakeLabel({ kind: "turn_failed", sessionId: "s" }).verb).toBe("Session failed a turn");
    expect(sessionWakeLabel({ kind: "turn_stopped", sessionId: "s" }).verb).toBe("Session was stopped");
    expect(sessionWakeLabel({ kind: "request_opened", sessionId: "s" }).verb).toBe("Session asked a question");
  });

  test("a steered wake is drawn from its stamp, whatever its words or sender say", () => {
    const html = renderTurn([
      prose("a1", "working on it"),
      steer("m1", { text: "[wake: completed] child done", sender: { sessionId: "session_boss" }, wakeReason: { kind: "turn_completed", sessionId: "session_child" } }),
    ]);
    expect(html).toContain('aria-label="Wake from another session"');
    expect(html).toContain("Session finished a turn");
    expect(html).not.toContain("agent · session");
    expect(html).not.toContain("child done");
  });

  test("a person's own words that look like a wake stay the person's message", () => {
    const html = renderTurn([prose("a1", "working on it"), steer("m1", { text: "[wake: completed] typed by hand" })]);
    expect(html).toContain("[wake: completed] typed by hand");
    expect(html).not.toContain("Wake from another session");
  });

  test("an agent's steered words carry the sending session's label", () => {
    const html = renderTurn([prose("a1", "working on it"), steer("m1", { text: "from a peer", sender: { sessionId: "session_abcdef123456" } })]);
    expect(html).toContain("agent · session …123456");
    expect(html).not.toContain("Wake from another session");
  });

  test("the journal keeps a steered wake's stamp on the row the transcript reads", async () => {
    const { projectJournal } = await import("@/platform/engine");
    const wakeReason = { kind: "turn_completed" as const, sessionId: "session_child", runId: "run_child" };
    const [turn] = projectJournal(
      [{ runId: "run_host", sessionId: "s1", sequence: 1, input: "work", state: "running", acceptedAt: 1, updatedAt: 1 }],
      [{ id: "i1", sessionId: "s1", runId: "run_host", status: "completed", detail: { type: "user_message", text: "[wake: completed] …", wakeReason }, startedAt: 2 }],
      [],
    );
    expect(turn!.items[0]).toMatchObject({ detail: { type: "user_message", wakeReason } });
  });
});

describe("a message sent mid-run is a boundary, not an event inside the work", () => {
  const item = (id: string, type: string) => ({ id, detail: { type } }) as never;

  test("splits a turn into responses at each message, work grouped after the message that caused it", async () => {
    const { splitAtMessageBoundaries } = await import("@/features/transcript");
    const responses = splitAtMessageBoundaries([
      item("w1", "command_execution"),
      item("a1", "assistant_message"),
      item("m1", "user_message"),
      item("w2", "command_execution"),
      item("w3", "file_change"),
      item("m2", "user_message"),
      item("w4", "command_execution"),
    ]);
    expect(responses.map((r) => ({ boundary: r.boundary?.id, items: r.items.map((i) => i.id).join("") }))).toEqual([
      { boundary: undefined, items: "w1a1" },
      { boundary: "m1", items: "w2w3" },
      { boundary: "m2", items: "w4" },
    ]);
  });

  test("a turn nobody steered is ONE response and renders as it always did", async () => {
    const { splitAtMessageBoundaries } = await import("@/features/transcript");
    const responses = splitAtMessageBoundaries([item("w1", "command_execution"), item("a1", "assistant_message")]);
    expect(responses).toHaveLength(1);
    expect(responses[0]!.boundary).toBeUndefined();
  });

  test("a turn whose FIRST item is the message has no empty opening response", async () => {
    // A steer that lands before the provider has emitted anything would
    // otherwise draw an empty assistant bubble above the message.
    const { splitAtMessageBoundaries } = await import("@/features/transcript");
    const responses = splitAtMessageBoundaries([item("m1", "user_message"), item("w1", "command_execution")]);
    expect(responses.map((r) => r.boundary?.id)).toEqual(["m1"]);
    expect(responses[0]!.items.map((i) => i.id)).toEqual(["w1"]);
  });

  test("a settled turn draws each message before the work it caused", () => {
    const html = renderTurn(
      [prose("a1", "First reply"), steer("m1", { text: "one more thing" }), prose("a2", "Second reply"), steer("m2", { text: "and another" }), prose("a3", "Final reply")],
      false,
    );
    const at = (text: string) => html.indexOf(text);
    const order = ["First reply", "one more thing", "Second reply", "and another", "Final reply"].map(at);
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("LIVE AND SETTLED CUT IN THE SAME PLACE — a reload cannot move a message", async () => {
    const { splitAtMessageBoundaries, segmentActivity } = await import("@/features/transcript");
    const items = [item("w1", "command_execution"), item("m1", "user_message"), item("w2", "command_execution"), item("a1", "assistant_message")];
    const responses = splitAtMessageBoundaries(items);
    // Settled: boundaries in order, each with its own work.
    expect(responses.map((r) => r.boundary?.id)).toEqual([undefined, "m1"]);
    // Live: the answering response's items still seam the same way, and carry
    // no message row of their own — the boundary was drawn above them.
    const answering = responses.at(-1)!;
    expect(answering.items.some((i) => i.detail.type === "user_message")).toBe(false);
    expect(segmentActivity(answering.items).map((s) => (s.kind === "row" ? s.item.id : s.items.map((i) => i.id).join("")))).toEqual(["w2", "a1"]);
  });

  test("no message is rendered twice: a boundary is never also in a response's items", async () => {
    const { splitAtMessageBoundaries } = await import("@/features/transcript");
    const items = [item("m1", "user_message"), item("w1", "command_execution"), item("m2", "user_message")];
    const responses = splitAtMessageBoundaries(items);
    const drawnAsItems = responses.flatMap((r) => r.items.map((i) => i.id));
    const drawnAsBoundaries = responses.map((r) => r.boundary?.id).filter(Boolean);
    expect(drawnAsItems.filter((id) => drawnAsBoundaries.includes(id))).toEqual([]);
    expect([...drawnAsBoundaries, ...drawnAsItems].sort()).toEqual(["m1", "m2", "w1"]);
  });
});

describe("a held message is not a running one", () => {
  test("the journal carries why a turn is held, and a paused hold is told apart from a restart's", async () => {
    const { projectJournal } = await import("@/platform/engine");
    const [paused, restart] = projectJournal(
      [
        { runId: "run_p", sessionId: "s1", sequence: 1, input: "later", state: "queued", held: { at: 1, reason: "session_paused" }, acceptedAt: 1, updatedAt: 1 },
        { runId: "run_r", sessionId: "s1", sequence: 2, input: "before the crash", state: "queued", held: { at: 1, reason: "engine_restart" }, acceptedAt: 2, updatedAt: 2 },
      ],
      [],
      [],
    );
    expect(paused).toMatchObject({ held: true, heldReason: "session_paused" });
    expect(restart).toMatchObject({ held: true, heldReason: "engine_restart" });
    // A release clears both the flag and the reason.
    const [released] = projectJournal(
      [{ runId: "run_p", sessionId: "s1", sequence: 1, input: "later", state: "queued", held: { at: 1, reason: "session_paused" }, acceptedAt: 1, updatedAt: 1 }],
      [],
      [{ id: 9, at: 5, sessionId: "s1", runId: "run_p", type: "turn.released" }],
    );
    expect(released!.held).toBe(false);
    expect(released!.heldReason).toBeUndefined();
  });
});

describe("a sub-agent's background claim is not a row in the main chat", () => {
  /** Two person's turns with a claim the engine opened between them, the first
   *  having spawned the agent the claim decides for. */
  const withClaim = async (claim: { taskId?: string }) => {
    const { projectJournal } = await import("@/platform/engine");
    return projectJournal(
      [
        { runId: "run_ask", sessionId: "s1", sequence: 1, input: "research this", state: "completed", acceptedAt: 1, updatedAt: 1 },
        {
          runId: "run_claim",
          sessionId: "s1",
          sequence: 2,
          input: "",
          origin: "provider",
          providerReason: { kind: "background_task", ...claim },
          state: "running",
          acceptedAt: 2,
          updatedAt: 2,
        },
        { runId: "run_next", sessionId: "s1", sequence: 3, input: "how is it going?", state: "completed", acceptedAt: 3, updatedAt: 3 },
      ] as never,
      [],
      [],
      [{ id: "task_toolu_agent", sessionId: "s1", runId: "run_ask", kind: "agent", backgrounded: true, state: "running", title: "research" }] as never,
    );
  };

  test("a claim between two person's turns leaves two rows, not three", async () => {
    const { shown } = transcriptRows(await withClaim({ taskId: "task_toolu_agent" }));
    expect(shown.map((turn) => turn.runId)).toEqual(["run_ask", "run_next"]);
  });

  test("a card parked under the claim renders on the turn that spawned the asking agent", async () => {
    const { hostOf } = transcriptRows(await withClaim({ taskId: "task_toolu_agent" }));
    expect(hostOf.get("run_claim")).toBe("run_ask");
  });

  test("a claim that cannot name one agent hosts its card on the row before it", async () => {
    const { hostOf } = transcriptRows(await withClaim({}));
    expect(hostOf.get("run_claim")).toBe("run_ask");
  });

  test("a claim with no row to host its card stays a row, so the card still has somewhere to render", () => {
    const { shown, hostOf } = transcriptRows([
      { runId: "run_claim", state: "running", decidedForBackgroundWork: true, tasks: [] },
    ]);
    expect(shown.map((turn) => turn.runId)).toEqual(["run_claim"]);
    expect(hostOf.size).toBe(0);
  });
});

describe("which plugin surfaces the cockpit offers", () => {
  test("reads the map", () => {
    expect(
      cockpitPlugins({ plugins: { version: 1, entries: { "data-science": { enabled: true }, latex: { enabled: false } } } }),
    ).toEqual(["data-science"]);
  });

  test("a map that disables Data Science beats stale legacy fields", () => {
    expect(
      cockpitPlugins({
        plugins: { version: 1, entries: { latex: { enabled: true } } },
        dataScience: { enabled: true },
      }),
    ).toEqual(["latex"]);
  });

  test("an entry the map never grew is off, whatever legacy fields say", () => {
    expect(
      cockpitPlugins({ plugins: { version: 1, entries: {} }, dataScience: { enabled: true }, latex: { enabled: true } }),
    ).toEqual([]);
  });

  test("an older engine's record with only legacy blocks is still read", () => {
    // A remote engine from before the map sends these; `readProjectPlugins`
    // folds them, so the switch a person threw there still holds.
    expect(cockpitPlugins({ dataScience: { enabled: true } })).toEqual(["data-science"]);
  });

  test("a project that has not loaded yet offers nothing", () => {
    expect(cockpitPlugins(undefined)).toEqual([]);
  });
});

describe("⌘P pins the conversation you are reading, and unpins it again", () => {
  test("an unpinned session is pinned by writing the override", () => {
    expect(pinToggleOverride(undefined)).toBe("active");
    expect(pinToggleOverride(null)).toBe("active");
  });

  test("a pinned session is unpinned by CLEARING it, not by writing a second state", () => {
    // `null` is the patch that removes the override. Writing "settled" here
    // would shelve the conversation rather than unpin it, which is a different
    // verb with its own row.
    expect(pinToggleOverride("active")).toBeNull();
  });

  test("pressing it over a SETTLED session pins it, rather than treating settled as pinned", () => {
    // Settled is somebody's decision to shelve this; Pin over it means pin.
    expect(pinToggleOverride("settled")).toBe("active");
  });
});
