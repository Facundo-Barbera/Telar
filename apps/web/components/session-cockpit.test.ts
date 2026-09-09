// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { cutAroundLiveAgents, segmentActivity, transcriptTasks, turnActivity } from "./transcript";
import { describeTurnState, retryInputForJournalTurn } from "./session-cockpit";

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

  test("retries the durable prompt, never streamed agent output", () => {
    expect(retryInputForJournalTurn({
      runId: "uncertain_run",
      state: "ambiguous",
      prompt: "Review this implementation",
    })).toEqual({ runId: "uncertain_run", state: "ambiguous", input: "Review this implementation" });
  });
});

describe("an unsent draft belongs to the composer it was typed in", () => {
  /**
   * ASSERTED AS SOURCE TEXT because the claim is about ORDERING, and there is no
   * DOM harness in this app to observe it. The bug this pins was never visible
   * in a rendered frame: the canvas draft key was removed by a 400ms debounce
   * that the new session's id CANCELLED on its way in, so the message you sent
   * stayed in storage and was restored into the next conversation you started.
   * A render test sees an empty box in both the broken and the fixed build.
   *
   * Same reasoning as `spool/idiom.test.ts` — a rule a future edit could break
   * silently is worth reading off the file.
   */
  const source = fs.readFileSync(fileURLToPath(new URL("./session-cockpit.tsx", import.meta.url)), "utf8");
  const submit = source.slice(source.indexOf("const submit = async ()"), source.indexOf("const rename = async ("));
  const clear = submit.indexOf('writeDraft(sessionId ?? browserTarget, projectId, "")');

  test("sending clears the stored draft under the id it was typed under", () => {
    expect(submit).toContain('setDraft("")');
    expect(clear).toBeGreaterThan(-1);
  });

  test("and clears it BEFORE the session it is creating gets an id", () => {
    // The whole bug is in this gap. Once `setCreatedSessionId` runs, the save
    // effect is keyed on a different session and the pending clear is torn
    // down unflushed — leaving `telar:draft:new:<project>` holding a sent
    // message, which is the one slot every new conversation reads on open.
    expect(clear).toBeLessThan(submit.indexOf("setCreatedSessionId("));
  });

  test("a session being born is a handover, not a change of composer", () => {
    // The restore effect empties the box whenever the composer changes hands,
    // which is how clicking a draft row loads that draft over whatever was on
    // screen. Creating a session changes the id WITHOUT changing the box, so
    // ownership is handed over explicitly first — otherwise a follow-up typed
    // during the create round trip is wiped the moment the id lands.
    const handover = submit.indexOf("owner.current = { sessionId: target, projectId }");
    expect(handover).toBeGreaterThan(-1);
    expect(handover).toBeLessThan(submit.indexOf("setCreatedSessionId("));
  });
});

describe("a draft belongs to one composer and does not follow you out of it", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./session-cockpit.tsx", import.meta.url)), "utf8");

  test("switching conversations saves the outgoing text before loading the incoming", () => {
    // Both halves were missing, and each was its own lost paragraph: the
    // debounced save is CANCELLED rather than flushed when the id changes, and
    // the restore could only fill an empty box — so a half-written message
    // stayed on screen in the next conversation while its own slot went stale.
    const restore = source.slice(source.indexOf("const owner = useRef<"), source.indexOf("// The session record carries"));
    const save = restore.indexOf("writeDraft(leaving.sessionId, leaving.projectId, draftText.current)");
    const load = restore.indexOf("setDraft(readDraft(sessionId, projectId))");
    expect(save).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(save);
  });
});

describe("a live turn folds as it works", () => {
  const item = (id: string, type: string) => ({ id, detail: { type } }) as never;

  test("runs of work are cut at prose, steers, plans and compactions", () => {
    /**
     * THE BUG THIS PINS: a live turn had one window over everything before its
     * last narration and dumped every tool call after it flat, so "one sentence,
     * then twenty commands" stacked twenty rows until the turn ended. Each run
     * is now its own group; only the last one is the live window.
     */
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
  /**
   * THE BUG THIS PINS: agents were CHIPS appended to the tail of the current
   * fold — at the bottom while the turn worked, at the top of the tally once
   * it settled — floating away from the moment the agent was reached for.
   * They are rows in the run now, at the spawn item's own position; and a
   * settled run is cut around any spawn whose agent is still live, so the
   * fleet stays visible instead of vanishing behind "12 steps".
   */
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
    /**
     * THE BUG THIS PINS: `bun run verify` backgrounded came back in the chat as
     * a bot-icon row titled with the command and "0 steps" — a delegate that
     * appeared never to report. It reports fine; a background shell has no
     * journal items, and the tool call that started it is already a row in this
     * same turn. Its live process belongs on the Processes tab.
     */
    const shell = task({ id: "verify", kind: "background", title: "Run full verify" });
    expect(transcriptTasks([shell, task({ id: "agent" })]).map((t) => t.id)).toEqual(["agent"]);
    expect(transcriptTasks([shell])).toEqual([]);
  });

  test("a warp run survives the filter that drops its background siblings", () => {
    /**
     * A run's own row is `background` because it outlives its turn, but it is
     * the row that says a fan-out happened at all — dropping it would leave its
     * agents as loose chips under no heading. Same rule as `splitRoster`: the
     * kind split happens AFTER the warp fold, never before.
     */
    const run = task({ id: "run", kind: "background", title: "find-flaky-tests", warp: { warpRunId: "run", warpName: "find-flaky-tests" } });
    const child = task({ id: "child", warp: { warpRunId: "run", warpName: "find-flaky-tests" } });
    const shell = task({ id: "tail", kind: "background", title: "tail -f dev.log" });
    expect(transcriptTasks([run, child, shell]).map((t) => t.id)).toEqual(["run", "child"]);
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
    const { agentSenderLabel } = await import("./session-cockpit");
    expect(agentSenderLabel({ sessionId: "session_abcdef123456" })).toBe("agent · session …123456");
    expect(agentSenderLabel({})).toBe("agent · outside any session");
  });
  test("the journal keeps the sender so the transcript can draw it", async () => {
    const { projectJournal } = await import("@/lib/engine/journal");
    const [turn] = projectJournal(
      [{ runId: "run_a", sessionId: "s1", sequence: 1, input: "do it", state: "queued", origin: "session", sender: { sessionId: "session_boss" }, acceptedAt: 1, updatedAt: 1 }],
      [],
      [],
    );
    expect(turn).toMatchObject({ origin: "session", sender: { sessionId: "session_boss" }, prompt: "do it" });
  });
});

describe("a held message is not a running one", () => {
  test("the journal carries why a turn is held, and a paused hold is told apart from a restart's", async () => {
    const { projectJournal } = await import("@/lib/engine/journal");
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
