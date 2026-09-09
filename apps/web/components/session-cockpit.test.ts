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

describe("a wake is a wake wherever it lands — never the person's bubble (#194)", () => {
  test("both surfaces name a wake with ONE vocabulary", async () => {
    // The label moved into ./transcript precisely so the mid-turn row and the
    // idle turn header cannot drift into two spellings of the same happening.
    const { sessionWakeLabel } = await import("./transcript");
    expect(sessionWakeLabel({ kind: "turn_completed", sessionId: "s" }).verb).toBe("Session finished a turn");
    expect(sessionWakeLabel({ kind: "turn_failed", sessionId: "s" }).verb).toBe("Session failed a turn");
    expect(sessionWakeLabel({ kind: "turn_stopped", sessionId: "s" }).verb).toBe("Session was stopped");
    expect(sessionWakeLabel({ kind: "request_opened", sessionId: "s" }).verb).toBe("Session asked a question");
  });

  test("the mid-turn row branches on the STRUCTURED stamp, not on the words", () => {
    /**
     * ASSERTED AS SOURCE TEXT for the reason the draft tests above are: there
     * is no DOM harness here, and the claim is about WHICH FIELD decides. A
     * renderer that classified on the `[wake: …]` prefix would pass a render
     * test and still draw a person's own "[wake: …]" as a wake row — and would
     * silently regress the moment the wake wording changed.
     */
    const source = fs.readFileSync(fileURLToPath(new URL("./transcript.tsx", import.meta.url)), "utf8");
    const row = source.slice(source.indexOf("function SteeredMessageRow("), source.indexOf("function PlotRow("));
    // The wake branch is taken from the stamp, and taken FIRST — before the
    // sender branch and before the person's bubble.
    const wake = row.indexOf("if (wakeReason) return <SteeredWakeRow");
    expect(wake).toBeGreaterThan(-1);
    expect(wake).toBeLessThan(row.indexOf("if (sender) return <AgentMessageBubble"));
    // And the person's own words fall through to the SAME component the
    // cockpit draws an ordinary message with — no bespoke bubble here.
    expect(row).toContain("return <ConversationMessage");
    // And nothing in the row reads the wake's own text to decide anything.
    // Comments stripped first: the prose here NAMES `[wake: …]` precisely to
    // say it is not what the branch reads, and matching that would assert the
    // opposite of the rule.
    const code = row.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("[wake");
  });

  test("the journal keeps a steered wake's stamp on the row the transcript reads", async () => {
    const { projectJournal } = await import("@/lib/engine/journal");
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
  /**
   * THE TWO REPORTS THIS PINS, which were the same defect seen from different
   * angles: "each sent message should feel like a turn, not be absorbed inside
   * the previous message's work", and a screenshot of a reply drawn ON TOP OF
   * an earlier message.
   *
   * A LIVE turn already cut its timeline at `user_message` (`segmentActivity`
   * seams on it), but a SETTLED one folded every item into one ActivityGroup —
   * so the message vanished into "N steps" the instant the turn ended, and the
   * fold lives inside the assistant's lane, so even opened it nested the
   * person's words inside the assistant's bubble. Live and reload therefore
   * disagreed about whether a message was there at all.
   */
  const item = (id: string, type: string) => ({ id, detail: { type } }) as never;

  test("splits a turn into responses at each message, work grouped after the message that caused it", async () => {
    const { splitAtMessageBoundaries } = await import("./transcript");
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
    const { splitAtMessageBoundaries } = await import("./transcript");
    const responses = splitAtMessageBoundaries([item("w1", "command_execution"), item("a1", "assistant_message")]);
    expect(responses).toHaveLength(1);
    expect(responses[0]!.boundary).toBeUndefined();
  });

  test("a turn whose FIRST item is the message has no empty opening response", async () => {
    // A steer that lands before the provider has emitted anything would
    // otherwise draw an empty assistant bubble above the message.
    const { splitAtMessageBoundaries } = await import("./transcript");
    const responses = splitAtMessageBoundaries([item("m1", "user_message"), item("w1", "command_execution")]);
    expect(responses.map((r) => r.boundary?.id)).toEqual(["m1"]);
    expect(responses[0]!.items.map((i) => i.id)).toEqual(["w1"]);
  });

  test("TWO STEERS, EACH INTRODUCING ITS OWN WORK — the message comes before what it caused", async () => {
    /**
     * THE BUG REVIEW CAUGHT, and the reason this asserts the emitted ORDER and
     * not the splitter's grouping: the split was right while the renderer drew
     * each response's work before its own boundary, so `prompt → A → steer1 →
     * B → steer2 → C` came out as A, B, steer1, steer2, C — work above the
     * message that caused it, for every steer but the last.
     */
    const { turnRenderOrder } = await import("./transcript");
    const order = turnRenderOrder([
      item("A", "command_execution"),
      item("s1", "user_message"),
      item("B", "command_execution"),
      item("s2", "user_message"),
      item("C", "command_execution"),
    ]);
    expect(order.map((entry) => (entry.kind === "boundary" ? entry.item.id : entry.items.map((i) => i.id).join("")))).toEqual([
      "A", "s1", "B", "s2", "C",
    ]);
    // Said as the invariant rather than the example: no work is ever emitted
    // before the boundary that introduced it.
    for (const [index, entry] of order.entries()) {
      if (entry.kind !== "work") continue;
      const previous = order[index - 1];
      if (index > 0 && previous) expect(previous.kind === "boundary" || index === 0).toBe(true);
    }
  });

  test("CONSECUTIVE STEERS with no work between them each keep their own place", async () => {
    // Two messages in a row produce an empty response between them. It must
    // collapse to nothing rather than to a stray empty assistant bubble, and
    // must not reorder the pair.
    const { turnRenderOrder } = await import("./transcript");
    const order = turnRenderOrder([
      item("s1", "user_message"),
      item("s2", "user_message"),
      item("A", "command_execution"),
    ]);
    expect(order.map((entry) => (entry.kind === "boundary" ? entry.item.id : entry.items.map((i) => i.id).join("")))).toEqual(["s1", "s2", "A"]);
    expect(order.filter((entry) => entry.kind === "work" && entry.items.length === 0)).toEqual([]);
  });

  test("a trailing steer with no work after it is still emitted", async () => {
    // The person got the last word and the turn ended. The message must not
    // vanish for want of anything to introduce.
    const { turnRenderOrder } = await import("./transcript");
    const order = turnRenderOrder([item("A", "command_execution"), item("s1", "user_message")]);
    expect(order.map((entry) => (entry.kind === "boundary" ? entry.item.id : entry.items.map((i) => i.id).join("")))).toEqual(["A", "s1"]);
  });

  test("and the RENDERER emits them in that order — boundary before its work", () => {
    /**
     * `turnRenderOrder` describes the sequence; this pins that the JSX actually
     * follows it. Without this the helper and the component could drift, which
     * is the exact failure mode here — the split was correct while the render
     * put each response's work first.
     */
    const source = fs.readFileSync(fileURLToPath(new URL("./session-cockpit.tsx", import.meta.url)), "utf8");
    const map = source.slice(source.indexOf("{earlier.map((response) => ("), source.indexOf("{answering.boundary &&"));
    const boundary = map.indexOf("response.boundary && (");
    const work = map.indexOf("response.items.length > 0 && (");
    expect(boundary).toBeGreaterThan(-1);
    expect(work).toBeGreaterThan(-1);
    expect(boundary).toBeLessThan(work);
    // And the answering response's own boundary is drawn before the assistant
    // lane that holds its work — the NEXT such lane, not the one inside the
    // map above, which is why this searches from the boundary rather than
    // from the top of the file.
    const answering = source.indexOf("{answering.boundary &&");
    expect(answering).toBeGreaterThan(-1);
    expect(source.indexOf('<Message from="assistant">', answering)).toBeGreaterThan(answering);
  });

  test("LIVE AND SETTLED CUT IN THE SAME PLACE — a reload cannot move a message", async () => {
    /**
     * The ordering guarantee, stated as the one thing that must be true: the
     * sequence of boundaries and the work under each is a pure function of the
     * item list, so it cannot depend on whether the turn is still running. The
     * live path renders `answering.items` and the settled path renders the same
     * split, which is what makes the two agree.
     */
    const { splitAtMessageBoundaries, segmentActivity } = await import("./transcript");
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
    const { splitAtMessageBoundaries } = await import("./transcript");
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
