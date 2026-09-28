import { afterEach, describe, expect, test } from "bun:test";
import { pageEvents, sessionsTools, TELAR_SKILL } from "..";
import { toolInputSchema } from "../../agent-tools";
import { cleanUp, capabilityOver, wall, engine, call, type Registered } from "./test-helpers";

afterEach(cleanUp);

// Mirrors the wall's `MAX_RESULT_CHARS`: a slice budget, not a limit on what is retrievable.
const MAX_RESULT_CHARS_EXPECTED = 8_000;

describe("sessions_read is bounded", () => {
  test("a long journal comes back as a page that SAYS it is one, with a cursor that skips nothing", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    for (let lap = 0; lap < 40; lap++) {
      await call(tools, "sessions_send", { intent: "task", sessionId: id, input: `message ${lap}` });
      store.stopTurn(id);
    }
    const whole = store.readEvents(id, 0);
    expect(whole.length).toBeGreaterThan(50);

    const first = await call(tools, "sessions_read", { sessionId: id, mode: "events", from: "start" });
    const page = first.json!.events as Array<{ id: number }>;
    expect(first.json!.more).toBe(true);
    expect(page.length).toBeLessThanOrEqual(50);
    expect(first.json!.cursor).toBe(page.at(-1)!.id);
    expect(String(first.json!.note)).toContain("A PAGE, not the whole journal");
    expect(String(first.json!.note)).toContain(`after: ${first.json!.cursor}`);

    const seen: number[] = (
      (await call(tools, "sessions_read", { sessionId: id, mode: "events", from: "start", verbose: true })).json!.events as Array<{ id: number }>
    ).map((event) => event.id);
    let cursor = seen.at(-1)!;
    let more = true;
    for (let guard = 0; more && guard < 20; guard++) {
      const next = await call(tools, "sessions_read", { sessionId: id, mode: "events", after: cursor, verbose: true });
      for (const event of next.json!.events as Array<{ id: number }>) seen.push(event.id);
      cursor = next.json!.cursor as number;
      more = next.json!.more === true;
    }
    expect(more).toBe(false);
    expect(seen).toEqual(whole.map((event) => event.id));
  });

  test("an events read with no cursor reads the LATEST page, and says what is behind it", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    for (let lap = 0; lap < 40; lap++) {
      await call(tools, "sessions_send", { intent: "task", sessionId: id, input: `message ${lap}` });
      store.stopTurn(id);
    }
    const whole = store.readEvents(id, 0);
    const latest = await call(tools, "sessions_read", { sessionId: id, mode: "events" });
    const page = latest.json!.events as Array<{ id: number }>;
    expect(page.length).toBeGreaterThan(0);
    expect(page.at(-1)!.id).toBe(whole.at(-1)!.id);
    expect(latest.json!.cursor).toBe(whole.at(-1)!.id);
    expect(latest.json!.more).toBe(false);
    expect(latest.json!.earlier).toBe(true);
    expect(String(latest.json!.note)).toContain("LATEST");
    expect(String(latest.json!.note)).toContain('from: "start"');
    expect(page[0]!.id).toBeGreaterThan(whole[0]!.id);
  });

  test("a short journal comes back whole from the tail, with nothing behind it", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "one" });
    const read = await call(tools, "sessions_read", { sessionId: id, mode: "events", verbose: true });
    expect(read.json!.earlier).toBe(false);
    expect((read.json!.events as Array<{ id: number }>).map((event) => event.id)).toEqual(store.readEvents(id, 0).map((event) => event.id));
  });

  test("meter rows and auto-approved requests are dropped, counted, and restored by verbose", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "work" });
    const run = store.turns(id).at(-1)!.runId;
    const token = store.claimTurn(id, "worker_budget")!.claim!.token;
    store.markRunning(id, run, token);
    store.ingestObservations(id, run, token, [
      { kind: "usage", usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 }, contextUsed: 2, contextMax: 10 } },
    ]);

    const quiet = await call(tools, "sessions_read", { sessionId: id, mode: "events" });
    const types = (quiet.json!.events as Array<{ type: string }>).map((event) => event.type);
    expect(types).not.toContain("usage.updated");
    expect(quiet.json!.quietEvents).toBeGreaterThan(0);

    const loud = await call(tools, "sessions_read", { sessionId: id, mode: "events", verbose: true });
    expect((loud.json!.events as Array<{ type: string }>).map((event) => event.type)).toContain("usage.updated");
    expect(loud.json!.quietEvents).toBeUndefined();
  });

  test("mode: summary folds turns instead of listing events", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    for (let lap = 0; lap < 8; lap++) {
      await call(tools, "sessions_send", { intent: "task", sessionId: id, input: `line ${lap}\nand a second line nobody needs` });
      store.stopTurn(id);
    }
    const summary = await call(tools, "sessions_read", { sessionId: id, mode: "summary" });
    const turns = summary.json!.turns as Array<{ runId: string; asked: string }>;
    expect(summary.json!.mode).toBe("summary");
    expect(summary.json!.turnCount).toBe(8);
    expect(turns).toHaveLength(5);
    expect(turns.at(-1)!.asked).toBe("line 7");
    expect(summary.json!.events).toBeUndefined();
    expect(summary.text.length).toBeLessThan((await call(tools, "sessions_read", { sessionId: id, mode: "events" })).text.length);
  });

  test("status, summary and a run read answer identically from a window as from the whole history", async () => {
    const { store, projectId } = engine();
    const whole = wall(store);
    const asked: Array<number | undefined> = [];
    const windowed = new Map<string, Registered>();
    sessionsTools(
      (name, description, shape, run) => {
        windowed.set(name, { name, description, shape, run });
        return { name };
      },
      {
        ...capabilityOver(store),
        status: async (sessionId, options) => {
          asked.push(options?.recent);
          if (options?.recent === undefined) return { session: store.getSession(sessionId), turns: store.turns(sessionId) };
          const window = store.snapshotWindow(sessionId, { limit: options.recent });
          return { session: store.getSession(sessionId), turns: window.turns, turnCount: window.page.total, pendingNotifications: store.pendingNotifications(sessionId) };
        },
        turn: async (sessionId, runId) => store.snapshotWindow(sessionId, { limit: 2 }).turns.find((turn) => turn.runId === runId),
      },
    );
    const id = (await call(whole, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    for (let lap = 0; lap < 9; lap++) {
      await call(whole, "sessions_send", { intent: "task", sessionId: id, input: `lap ${lap}` });
      store.stopTurn(id);
    }
    await call(whole, "sessions_send", { intent: "task", sessionId: id, input: "still queued" });
    const live = store.turns(id).at(-1)!.runId;

    for (const [name, args] of [
      ["sessions_status", { sessionId: id, turns: 3 }],
      ["sessions_status", { sessionId: id }],
      ["sessions_read", { sessionId: id, mode: "summary", turns: 4 }],
      ["sessions_read", { sessionId: id, runId: live }],
    ] as const) {
      expect((await call(windowed, name, args)).json).toEqual((await call(whole, name, args)).json!);
    }
    expect(asked).toEqual([3, 5, 4]);
    const status = (await call(windowed, "sessions_status", { sessionId: id, turns: 3 })).json!;
    expect(status.turnCount).toBe(10);
    expect(status.turnsNotShown).toBe(7);
  });

  test("the bare call is the summary, and the raw journal has to be asked for", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    for (let lap = 0; lap < 8; lap++) {
      await call(tools, "sessions_send", { intent: "task", sessionId: id, input: `line ${lap}` });
      store.stopTurn(id);
    }
    const bare = await call(tools, "sessions_read", { sessionId: id });
    expect(bare.json!.mode).toBe("summary");
    expect(bare.json!.events).toBeUndefined();
    expect(tools.get("sessions_read")!.description).toContain("by default a turn-by-turn summary");
    expect(tools.get("sessions_read")!.description).toContain('mode: events');

    const withCursor = await call(tools, "sessions_read", { sessionId: id, after: 0 });
    expect(withCursor.json!.mode).toBe("summary");

    const raw = await call(tools, "sessions_read", { sessionId: id, mode: "events" });
    expect(raw.json!.mode).toBeUndefined();
    expect((raw.json!.events as unknown[]).length).toBeGreaterThan(0);
    expect(bare.text.length).toBeLessThan(raw.text.length);

    const runId = store.turns(id).at(-1)!.runId;
    const scoped = await call(tools, "sessions_read", { sessionId: id, runId });
    expect(scoped.json!.mode).toBeUndefined();
    expect(scoped.json!.runId).toBe(runId);
  });

  test("a run-scoped read answers with THAT turn's events and its final text, without paging", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    for (const [runId, answer] of [["run_first", "the first answer"], ["run_wanted", `the answer worth reading: ${"y".repeat(3_000)}`]] as const) {
      store.submitTurn(id, { runId, input: `work ${runId}` });
      const token = store.claimTurn(id, "worker_read")!.claim!.token;
      store.markRunning(id, runId, token);
      store.completeTurn(id, runId, token, { text: answer });
    }

    const read = await call(tools, "sessions_read", { sessionId: id, runId: "run_wanted" });
    expect(read.json!.runId).toBe("run_wanted");
    expect(read.json!.state).toBe("completed");
    expect(String(read.json!.result)).toContain("the answer worth reading");
    expect(read.json!.resultChars).toBe(`the answer worth reading: ${"y".repeat(3_000)}`.length);
    expect(read.json!.resultFrom).toBe(0);
    expect(read.json!.resultMore).toBe(false);
    const events = read.json!.events as Array<{ runId?: string }>;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.runId === "run_wanted")).toBe(true);
    expect(String(read.json!.note)).toContain("Nothing else was needed");
  });

  test("a run-scoped read of an unknown run says so rather than pretending", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    const read = await call(tools, "sessions_read", { sessionId: id, runId: "run_never" });
    expect(read.json!.runId).toBe("run_never");
    expect(read.json!.result).toBeUndefined();
    expect(String(read.json!.note)).toContain("No turn run_never on this session");
  });

  test("a long answer is read whole in verbatim slices, and never trimmed", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    const answer = `\n\n   ${Array.from({ length: 1_000 }, (_, index) => `line ${String(index).padStart(4, "0")} ${"·".repeat(8)}`).join("\n")}   \n\n`;
    expect(answer.length).toBeGreaterThan(MAX_RESULT_CHARS_EXPECTED * 2);
    store.submitTurn(id, { runId: "run_long", input: "work" });
    const token = store.claimTurn(id, "worker_read")!.claim!.token;
    store.markRunning(id, "run_long", token);
    store.completeTurn(id, "run_long", token, { text: answer });

    let cursor = 0;
    let assembled = "";
    let more = true;
    for (let guard = 0; more && guard < 20; guard += 1) {
      const read = await call(tools, "sessions_read", { sessionId: id, runId: "run_long", resultAfter: cursor });
      expect(read.json!.resultChars).toBe(answer.length);
      expect(read.json!.resultFrom).toBe(cursor);
      const slice = String(read.json!.result);
      expect(slice).not.toContain("not shown");
      expect(slice).not.toContain("…");
      assembled += slice;
      more = read.json!.resultMore === true;
      cursor = assembled.length;
      if (more) expect(String(read.json!.note)).toContain(`resultAfter: ${cursor}`);
    }
    expect(more).toBe(false);
    expect(assembled.length).toBe(answer.length);
    expect(assembled).toBe(answer);
    expect(assembled.startsWith("\n\n   ")).toBe(true);
    expect(assembled.endsWith("   \n\n")).toBe(true);
  });

  test("a result-only continuation carries the event cursor, so events are not replayed", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    const answer = "w".repeat(20_000);
    store.submitTurn(id, { runId: "run_tail", input: "work" });
    const token = store.claimTurn(id, "worker_read")!.claim!.token;
    store.markRunning(id, "run_tail", token);
    store.completeTurn(id, "run_tail", token, { text: answer });

    const first = await call(tools, "sessions_read", { sessionId: id, runId: "run_tail" });
    expect(first.json!.more).toBe(false);
    expect(first.json!.resultMore).toBe(true);
    const cursor = first.json!.cursor as number;
    expect(cursor).toBeGreaterThan(0);
    const note = String(first.json!.note);
    expect(note).toContain(`after: ${cursor}`);
    expect(note).toContain("resultAfter: 8000");

    const second = await call(tools, "sessions_read", { sessionId: id, runId: "run_tail", after: cursor, resultAfter: 8_000 });
    expect(second.json!.events).toEqual([]);
    expect(second.json!.resultFrom).toBe(8_000);
    expect(String(second.json!.result).length).toBe(8_000);
    expect(second.json!.resultMore).toBe(true);

    const third = await call(tools, "sessions_read", { sessionId: id, runId: "run_tail", after: second.json!.cursor as number, resultAfter: 16_000 });
    expect(third.json!.resultMore).toBe(false);
    expect(`${first.json!.result}${second.json!.result}${third.json!.result}`).toBe(answer);
  });

  test("paging a run's events does not repeat its answer, and skips the other runs' events", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    const busy = "run_busy";
    store.submitTurn(id, { runId: busy, input: "work" });
    const token = store.claimTurn(id, "worker_read")!.claim!.token;
    store.markRunning(id, busy, token);
    for (let index = 0; index < 60; index += 1) {
      store.ingestObservations(id, busy, token, [
        { kind: "item.started", item: { id: `item_${index}`, detail: { type: "assistant_message", text: `step ${index}` } } },
        { kind: "item.completed", itemId: `item_${index}`, status: "completed" },
      ]);
      if (index % 20 === 0) {
        const other = `run_other_${index}`;
        store.submitTurn(id, { runId: other, input: "someone else" });
        store.stopTurn(id, other);
      }
    }
    store.completeTurn(id, busy, token, { text: "the busy answer" });

    let cursor = 0;
    let pages = 0;
    let events = 0;
    let more = true;
    for (let guard = 0; more && guard < 20; guard += 1) {
      const read = await call(tools, "sessions_read", { sessionId: id, runId: busy, ...(cursor > 0 ? { after: cursor } : {}) });
      const page = read.json!.events as Array<{ id: number; runId?: string }>;
      expect(page.every((event) => event.runId === busy)).toBe(true);
      if (pages === 0) expect(read.json!.result).toBe("the busy answer");
      else expect(read.json!.result).toBeUndefined();
      expect(read.json!.resultChars).toBe("the busy answer".length);
      events += page.length;
      pages += 1;
      more = read.json!.more === true;
      if (more) {
        expect(read.json!.cursor).toBe(page.at(-1)!.id);
        expect(String(read.json!.note)).toContain(`after: ${read.json!.cursor}`);
        cursor = read.json!.cursor as number;
      }
    }
    expect(pages).toBeGreaterThan(1);
    expect(more).toBe(false);
    const all = store.readEvents(id, 0).filter((event) => event.runId === busy);
    expect(events).toBe(all.length);
  });

  test("a run with no answer text says that", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    store.submitTurn(id, { runId: "run_quiet", input: "work" });
    const quiet = store.claimTurn(id, "worker_read")!.claim!.token;
    store.markRunning(id, "run_quiet", quiet);
    store.completeTurn(id, "run_quiet", quiet, { text: "" });
    const silent = await call(tools, "sessions_read", { sessionId: id, runId: "run_quiet" });
    expect(silent.json!.result).toBeUndefined();
    expect(silent.json!.resultChars).toBeUndefined();
    expect(String(silent.json!.note)).toContain("no answer text");
  });

  test("without a runId there is no run scoping: no runId, no answer, just events", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "one" });
    const read = await call(tools, "sessions_read", { sessionId: id, mode: "events" });
    expect(read.json!.runId).toBeUndefined();
    expect(read.json!.result).toBeUndefined();
    expect((read.json!.events as unknown[]).length).toBeGreaterThan(0);
    const forward = await call(tools, "sessions_read", { sessionId: id, mode: "events", after: 0 });
    expect(forward.json!.from).toBe(0);
  });

  test("one enormous event is clamped and MARKED, and never squeezes the page to nothing", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "x".repeat(60_000) });

    const read = await call(tools, "sessions_read", { sessionId: id, mode: "events" });
    const text = read.text;
    expect(text).toContain("more characters, not shown");
    expect(text.length).toBeLessThan(40_000);
    expect((read.json!.events as unknown[]).length).toBeGreaterThan(1);
  });

  test("the pager never returns an empty page while claiming there is more", () => {
    const bulky = {
      id: 1,
      sessionId: "s",
      at: 0,
      type: "turn.accepted",
      lines: Array.from({ length: 40 }, () => "y".repeat(1_500)),
    } as never;
    expect(JSON.stringify(bulky).length).toBeGreaterThan(24_000);
    const first = pageEvents([bulky]);
    expect(first.page.length).toBe(1);
    expect(first.cursor).toBe(1);
    expect(first.more).toBe(false);

    const next = { id: 2, sessionId: "s", at: 0, type: "turn.stopped" } as never;
    const paged = pageEvents([bulky, next]);
    expect(paged.page.length).toBe(1);
    expect(paged.cursor).toBe(1);
    expect(paged.more).toBe(true);
  });
});

describe("sessions_read returns the message a notice stands in for", () => {
  test("one call, and the body comes back exactly as sent", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    const body = `Findings\n\n${"The parser drops the column on recovery. ".repeat(60)}`;
    const sent = await call(tools, "sessions_send", { sessionId: id, input: body });
    const runId = sent.json!.runId as string;
    expect(String(sent.json!.recipientSees)).toContain(`sessions_read(sessionId: "${id}", runId: "${runId}")`);

    const read = await call(tools, "sessions_read", { sessionId: id, runId });
    expect(read.json!.message).toBe(body);
    expect(read.json!.messageChars).toBe(body.length);
    expect(read.json!.messageMore).toBe(false);
    expect(read.json!.messageIntent).toBe("report");
    const accepted = (read.json!.events as Array<{ type: string; turn?: { input: string; agentNotice?: string } }>).find(
      (event) => event.type === "turn.accepted",
    );
    expect(accepted!.turn!.input).toContain("the `message` field");
    expect(accepted!.turn!.input).not.toContain("The parser drops the column");
    expect(accepted!.turn!.agentNotice).not.toContain("The parser drops the column");
    expect(String(read.json!.message)).not.toContain("more characters, not shown");
    store.submitTurn(id, { runId: "run_person", input: "the editor eats my cursor" });
    const typed = await call(tools, "sessions_read", { sessionId: id, runId: "run_person" });
    const theirs = (typed.json!.events as Array<{ type: string; turn?: { input: string } }>).find((event) => event.type === "turn.accepted");
    expect(theirs!.turn!.input).toBe("the editor eats my cursor");
  });

  test("a body past the budget is read whole in verbatim slices", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    const body = "z".repeat(20_000);
    const runId = (await call(tools, "sessions_send", { sessionId: id, input: body })).json!.runId as string;

    let assembled = "";
    let cursor: number | undefined = 0;
    for (let lap = 0; lap < 5 && cursor !== undefined; lap += 1) {
      const page = await call(tools, "sessions_read", { sessionId: id, runId, messageAfter: cursor });
      assembled += page.json!.message as string;
      cursor = page.json!.messageMore === true ? (page.json!.messageFrom as number) + (page.json!.message as string).length : undefined;
    }
    expect(assembled).toBe(body);
  });

  test("a human's turn has no message to fetch — it was never replaced by a notice", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    store.submitTurn(id, { runId: "run_typed", input: "please fix the editor" });
    const read = await call(tools, "sessions_read", { sessionId: id, runId: "run_typed" });
    expect(read.json!.message).toBeUndefined();
    expect(read.json!.messageChars).toBeUndefined();
  });

  test("the wall tells senders and recipients what actually travels", () => {
    const { store } = engine();
    const tools = wall(store);
    expect(tools.get("sessions_send")!.description).toContain("handed a NOTICE naming sessions_read, not your text");
    expect(JSON.stringify(toolInputSchema(tools.get("sessions_read")!.shape))).toContain("a peer message in full");
    expect(TELAR_SKILL).toContain("A wake or a peer's message names a session and a run");
    expect(TELAR_SKILL).toContain("sessions_read(sessionId, runId)");
    expect(tools.get("sessions_subscribe")!.description).toContain("Be woken ONCE");
  });

  test("the descriptions say: never poll, and a tasked worker ends with one result", () => {
    const { store } = engine();
    const tools = wall(store);
    expect(tools.get("sessions_status")!.description).toContain("Never poll it to wait");
    expect(tools.get("sessions_send")!.description).toContain("End with ONE result");
    expect(tools.get("sessions_send")!.description).toContain("no progress reports");
  });
});
