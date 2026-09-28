import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SteerMailbox } from "../../domains/turns";
import { createClaudeDriver, run } from "../../../test/claude-harness";

test("a steered message is injected MID-TURN, journalled as a user_message row", async () => {
  const heard: unknown[] = [];
  const driver = createClaudeDriver(async () => ({
    async *query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
      for await (const message of prompt) {
        heard.push(message.message.content);
        if (heard.length < 2) continue; // still "working": the steer arrives while no result has been produced
        yield { type: "assistant", message: { content: [{ type: "text", text: "answer " }] } };
        yield { type: "result", subtype: "success" };
        return;
      }
    },
  }) as never);
  const steer = new SteerMailbox();
  steer.push("also do this");
  const { sink, result } = run(driver, { steer });
  const resolved = await result;
  expect(heard).toEqual(["prompt", "also do this"]);
  expect(resolved.text).toBe("answer ");
  // The injected sentence is a transcript row — without it, the agent's
  // change of direction would have no visible cause.
  const userRows = sink.observations.filter(
    (o) => o.kind === "item.started" && o.item.detail.type === "user_message" && o.item.detail.text === "also do this",
  );
  expect(userRows).toHaveLength(1);
});

test("a HUMAN steer interrupts the running generation instead of queueing behind it", async () => {
  const interrupts: number[] = [];
  let startedGenerating: (() => void) | undefined;
  const generating = new Promise<void>((resolve) => {
    startedGenerating = resolve;
  });
  let releaseGeneration: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    releaseGeneration = resolve;
  });
  const heard: unknown[] = [];
  const driver = createClaudeDriver(async () => ({
    // `interrupt` belongs to the QUERY, as in the real SDK — the provider is
    // interrupted, not the module.
    query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
      const iterator = prompt[Symbol.asyncIterator]();
      async function* pump() {
        const first = await iterator.next();
        heard.push(first.value!.message.content);
        startedGenerating!();
        yield { type: "assistant", message: { content: [{ type: "text", text: "long answer" }] } };
        // Generating: no further input is read until interrupted.
        await finished;
        yield { type: "result", subtype: "interrupted" };
        const second = await iterator.next();
        heard.push(second.value!.message.content);
        yield { type: "assistant", message: { content: [{ type: "text", text: "new direction" }] } };
        yield { type: "result", subtype: "success" };
      }
      return Object.assign(pump(), {
        interrupt: async () => {
          interrupts.push(Date.now());
          releaseGeneration!();
        },
      });
    },
  }) as never);
  const steer = new SteerMailbox();
  const { result } = run(driver, { steer });
  await generating;
  // The human types while it streams.
  steer.push("stop, do this instead");
  const resolved = await result;
  expect(interrupts).toHaveLength(1);
  expect(heard).toEqual(["prompt", "stop, do this instead"]);
  // Partial text survives, and the new direction is what the turn answers.
  expect(resolved.text).toContain("new direction");
});

describe("a person's message is stamped as one, and nothing else is", () => {
  test("the turn's own prompt carries origin human only when a person typed it", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) {
        for await (const message of prompt) {
          seen.push(message);
          yield { type: "result", subtype: "success" };
          return;
        }
      },
    }) as never);
    await run(driver, { promptFromHuman: true }).result;
    await run(driver, { promptFromHuman: false }).result;
    // ABSENT IS NOT HUMAN. An older worker, or a test, claims nothing — a wake
    // stamped as a person's decision is the one mistake this seam prevents.
    await run(driver).result;
    expect(seen.map((message) => message.origin)).toEqual([{ kind: "human" }, undefined, undefined]);
  });

  test("a steered batch is stamped when a person is in it, and not when it is only notices", async () => {
    const seenFor = async (queued: Array<Parameters<SteerMailbox["push"]>[0]>) => {
      const seen: Array<Record<string, unknown>> = [];
      const driver = createClaudeDriver(async () => ({
        async *query({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) {
          // Two messages before answering — the turn is still "working" when
          // the steer lands, which is the only way it is delivered mid-turn.
          for await (const message of prompt) {
            seen.push(message);
            if (seen.length < 2) continue;
            yield { type: "result", subtype: "success" };
            return;
          }
        },
      }) as never);
      const steer = new SteerMailbox();
      for (const message of queued) steer.push(message);
      await run(driver, { steer }).result;
      return seen;
    };

    expect((await seenFor(["typed by a person"]))[1]?.origin).toEqual({ kind: "human" });
    expect(
      (await seenFor([
        { text: "a peer reports in", sender: { sessionId: "session_peer" } },
        { text: "a session you follow finished", wakeReason: { kind: "turn_completed", sessionId: "session_followed" } },
      ]))[1]?.origin,
    ).toBeUndefined();
    // A MIXED BATCH IS THE PERSON'S. Someone typed, mid-turn; that is the same
    // reading the interrupt below has always taken of the same batch.
    expect(
      (await seenFor([{ text: "a peer reports in", sender: { sessionId: "session_peer" } }, "and the person weighs in"]))[1]?.origin,
    ).toEqual({ kind: "human" });
  });
});

describe("a notification is delivered as system-authored, stamped with its real provenance", () => {
  const peer = {
    kind: "peer_message" as const,
    sessionId: "session_peer",
    runId: "run_x",
    intent: "report" as const,
    summary: "[agent message · report] from session session_peer",
    fetch: { sessionId: "session_me", runId: "run_x" },
    body: "[agent message · report] from session session_peer (run run_x, 12 chars)",
  };
  const wake = { ...peer, kind: "wake" as const, wakeKind: "turn_completed" as const, body: "[wake: completed] Session session_peer — turn run_x completed." };

  const deliver = async (extra: Record<string, unknown>) => {
    const seen: Array<Record<string, unknown>> = [];
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) {
        for await (const message of prompt) {
          seen.push(message);
          yield { type: "result", subtype: "success" };
          return;
        }
      },
    }) as never);
    await run(driver, extra).result;
    return seen[0]!;
  };

  test("a peer's message is stamped `peer` and wrapped as system-authored", async () => {
    const message = await deliver({ prompt: peer.body, notification: peer });
    expect(message.origin).toEqual({ kind: "peer", from: "session_peer", fromSession: "session_peer" });
    // NOT the person's, even though the wire's role field says "user" — the SDK
    // has no other role, which is exactly why the content half exists.
    expect(message.origin).not.toEqual({ kind: "human" });
    const content = (message.message as { content: string }).content;
    expect(content).toStartWith("<system-reminder>");
    expect(content).toContain(peer.body);
    expect(content).toEndWith("</system-reminder>");
  });

  test("a wake is stamped `task-notification` — the engine reporting, not a peer speaking", async () => {
    const message = await deliver({ prompt: wake.body, notification: wake });
    expect(message.origin).toEqual({ kind: "task-notification" });
    expect((message.message as { content: string }).content).toContain("[wake: completed]");
  });

  test("a send from the outward socket names no session it cannot name", async () => {
    const { sessionId: _omitted, ...anonymous } = peer;
    const message = await deliver({ prompt: peer.body, notification: anonymous });
    // `from` is required by the SDK and `fromSession` is a navigation target; an
    // agent outside any session has no id, so neither is invented.
    expect(message.origin).toEqual({ kind: "peer", from: "sessions-socket" });
  });

  test("a person's prompt is untouched by any of this", async () => {
    const message = await deliver({ prompt: "please fix the editor", promptFromHuman: true });
    expect(message.origin).toEqual({ kind: "human" });
    expect((message.message as { content: string }).content).toBe("please fix the editor");
  });

  test("a steered batch of only notifications goes in system-authored too", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) {
        for await (const message of prompt) {
          seen.push(message);
          if (seen.length < 2) continue;
          yield { type: "result", subtype: "success" };
          return;
        }
      },
    }) as never);
    const steer = new SteerMailbox();
    steer.push({ text: "the body", sender: { sessionId: "session_peer" }, notification: peer });
    await run(driver, { steer }).result;
    expect(seen[1]?.origin).toEqual({ kind: "peer", from: "session_peer", fromSession: "session_peer" });
    expect((seen[1]!.message as { content: string }).content).toStartWith("<system-reminder>");
    // TIMING DOES NOT CHANGE THE ROLE — the same happening arriving on an idle
    // session and on a busy one is delivered the same way.
    expect((seen[1]!.message as { content: string }).content).toContain(peer.body);
  });

  test("a batch mixing a notification with typed words stays the person's", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) {
        for await (const message of prompt) {
          seen.push(message);
          if (seen.length < 2) continue;
          yield { type: "result", subtype: "success" };
          return;
        }
      },
    }) as never);
    const steer = new SteerMailbox();
    steer.push({ text: "the body", sender: { sessionId: "session_peer" }, notification: peer });
    steer.push("and the person weighs in");
    await run(driver, { steer }).result;
    expect(seen[1]?.origin).toEqual({ kind: "human" });
    expect((seen[1]!.message as { content: string }).content).not.toContain("<system-reminder>");
  });
});

test("an AGENT report and an engine WAKE do NOT interrupt — a notice is not a change of direction", async () => {
  const interrupts: string[] = [];
  const driver = createClaudeDriver(async () => ({
    query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
      const iterator = prompt[Symbol.asyncIterator]();
      async function* pump() {
        const first = await iterator.next();
        void first;
        yield { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } };
        yield { type: "result", subtype: "success" };
      }
      return Object.assign(pump(), {
        interrupt: async () => void interrupts.push("interrupted"),
      });
    },
  }) as never);
  const steer = new SteerMailbox();
  steer.push({ text: "a peer reports in", sender: { sessionId: "session_peer" } });
  steer.push({ text: "a session you follow finished", wakeReason: { kind: "turn_completed", sessionId: "session_followed" } });
  const { result } = run(driver, { steer });
  await result;
  expect(interrupts).toEqual([]);
});

test("a provider with no interrupt still fails honestly on the next non-success result", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
      const iterator = prompt[Symbol.asyncIterator]();
      await iterator.next();
      // No `interrupt` on this query at all.
      yield { type: "result", subtype: "error_during_execution" };
    },
  }) as never);
  const steer = new SteerMailbox();
  steer.push("typed by a person");
  const { result } = run(driver, { steer });
  await expect(result).rejects.toThrow(/did not complete successfully/);
});

test("the interrupt's RESULT may arrive before its acknowledgment resolves — still not a failure", async () => {
  const heard: unknown[] = [];
  let interruptCalled: (() => void) | undefined;
  const called = new Promise<void>((resolve) => {
    interruptCalled = resolve;
  });
  let acknowledge: (() => void) | undefined;
  const acknowledged = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let startedGenerating: (() => void) | undefined;
  const generating = new Promise<void>((resolve) => {
    startedGenerating = resolve;
  });
  const driver = createClaudeDriver(async () => ({
    query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
      const iterator = prompt[Symbol.asyncIterator]();
      async function* pump() {
        heard.push((await iterator.next()).value!.message.content);
        startedGenerating!();
        yield { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } };
        // The cut's result lands FIRST; the acknowledgment is still pending.
        await called;
        yield { type: "result", subtype: "interrupted" };
        // Only now does the provider acknowledge the interrupt.
        acknowledge!();
        heard.push((await iterator.next()).value!.message.content);
        yield { type: "assistant", message: { content: [{ type: "text", text: "new direction" }] } };
        yield { type: "result", subtype: "success" };
      }
      return Object.assign(pump(), {
        interrupt: async () => {
          interruptCalled!();
          await acknowledged;
        },
      });
    },
  }) as never);
  const steer = new SteerMailbox();
  const { result } = run(driver, { steer });
  await generating;
  steer.push("change course");
  const resolved = await result;
  expect(heard).toEqual(["prompt", "change course"]);
  expect(resolved.text).toContain("new direction");
});

test("TWO interrupts outstanding AT ONCE are both absorbed — a flag would lose one", async () => {
  const heard: unknown[] = [];
  let interrupts = 0;
  let bothIssued: (() => void) | undefined;
  const issued = new Promise<void>((resolve) => {
    bothIssued = resolve;
  });
  let startedGenerating: (() => void) | undefined;
  const generating = new Promise<void>((resolve) => {
    startedGenerating = resolve;
  });
  const driver = createClaudeDriver(async () => ({
    query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
      const iterator = prompt[Symbol.asyncIterator]();
      async function* pump() {
        heard.push((await iterator.next()).value!.message.content);
        startedGenerating!();
        // Nothing is emitted until BOTH cuts have been issued, so both are
        // outstanding when the results finally arrive.
        await issued;
        yield { type: "result", subtype: "interrupted" };
        heard.push((await iterator.next()).value!.message.content);
        yield { type: "result", subtype: "interrupted" };
        heard.push((await iterator.next()).value!.message.content);
        yield { type: "assistant", message: { content: [{ type: "text", text: "settled" }] } };
        yield { type: "result", subtype: "success" };
      }
      return Object.assign(pump(), {
        interrupt: async () => {
          interrupts += 1;
          if (interrupts === 2) bothIssued!();
        },
      });
    },
  }) as never);
  const steer = new SteerMailbox();
  const { result } = run(driver, { steer });
  await generating;
  steer.push("first correction");
  // Pushed only once the first cut is issued, so it drains separately — but
  // still before any result exists to consume either.
  while (interrupts < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  steer.push("second correction");
  const resolved = await result;
  expect(interrupts).toBe(2);
  expect(heard).toEqual(["prompt", "first correction", "second correction"]);
  expect(resolved.text).toContain("settled");
});

test("a GENUINE failure after an absorbed interrupt still fails the turn", async () => {
  let startedGenerating: (() => void) | undefined;
  const generating = new Promise<void>((resolve) => {
    startedGenerating = resolve;
  });
  let cut: (() => void) | undefined;
  const wasCut = new Promise<void>((resolve) => {
    cut = resolve;
  });
  const driver = createClaudeDriver(async () => ({
    query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
      const iterator = prompt[Symbol.asyncIterator]();
      async function* pump() {
        await iterator.next();
        startedGenerating!();
        await wasCut;
        yield { type: "result", subtype: "interrupted" }; // ours, absorbed
        await iterator.next();
        yield { type: "result", subtype: "error_during_execution" }; // theirs
      }
      return Object.assign(pump(), { interrupt: async () => void cut!() });
    },
  }) as never);
  const steer = new SteerMailbox();
  const { result } = run(driver, { steer });
  await generating;
  steer.push("change course");
  await expect(result).rejects.toThrow(/did not complete successfully/);
});

test("when the answer FINISHES before the cut lands, the person's words are still answered in this turn", async () => {
  const heard: unknown[] = [];
  let startedGenerating: (() => void) | undefined;
  const generating = new Promise<void>((resolve) => {
    startedGenerating = resolve;
  });
  let cutIssued: (() => void) | undefined;
  const cut = new Promise<void>((resolve) => {
    cutIssued = resolve;
  });
  const driver = createClaudeDriver(async () => ({
    query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
      const iterator = prompt[Symbol.asyncIterator]();
      async function* pump() {
        heard.push((await iterator.next()).value!.message.content);
        startedGenerating!();
        await cut;
        yield { type: "assistant", message: { content: [{ type: "text", text: "the old answer" }] } };
        // The answer had already finished: a SUCCESS, with the steered message
        // still queued behind it.
        yield { type: "result", subtype: "success", queued_turn_count: 1 };
        heard.push((await iterator.next()).value!.message.content);
        yield { type: "assistant", message: { content: [{ type: "text", text: "answering the correction" }] } };
        yield { type: "result", subtype: "success", queued_turn_count: 0 };
      }
      return Object.assign(pump(), { interrupt: async () => void cutIssued!() });
    },
  }) as never);
  const steer = new SteerMailbox();
  const { result } = run(driver, { steer });
  await generating;
  steer.push("actually, do this");
  const resolved = await result;
  // The person's words reached the provider AND were answered before the turn
  // ended — not left queued behind a turn the engine had already closed.
  expect(heard).toEqual(["prompt", "actually, do this"]);
  expect(resolved.text).toContain("answering the correction");
});

test("a cut whose acknowledgment REJECTS after its result was consumed cannot corrupt later cuts", async () => {
  const heard: unknown[] = [];
  let rejectFirst: ((error: Error) => void) | undefined;
  let firstResultSeen: (() => void) | undefined;
  const firstResult = new Promise<void>((resolve) => {
    firstResultSeen = resolve;
  });
  let calls = 0;
  let secondCut: (() => void) | undefined;
  const cutAgain = new Promise<void>((resolve) => {
    secondCut = resolve;
  });
  let startedGenerating: (() => void) | undefined;
  const generating = new Promise<void>((resolve) => {
    startedGenerating = resolve;
  });
  const driver = createClaudeDriver(async () => ({
    query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
      const iterator = prompt[Symbol.asyncIterator]();
      async function* pump() {
        heard.push((await iterator.next()).value!.message.content);
        startedGenerating!();
        await firstResult;
        // The crash path: the result precedes the receipt, and the control
        // request then fails outright.
        yield { type: "result", subtype: "interrupted" };
        rejectFirst!(new Error("interrupt control request failed"));
        heard.push((await iterator.next()).value!.message.content);
        await cutAgain;
        // A SECOND, ordinary cut — this must still be absorbed.
        yield { type: "result", subtype: "interrupted" };
        heard.push((await iterator.next()).value!.message.content);
        yield { type: "assistant", message: { content: [{ type: "text", text: "answered at last" }] } };
        yield { type: "result", subtype: "success", queued_turn_count: 0 };
      }
      return Object.assign(pump(), {
        interrupt: async () => {
          calls += 1;
          if (calls === 1) {
            firstResultSeen!();
            await new Promise<void>((_resolve, reject) => {
              rejectFirst = reject;
            });
            return;
          }
          secondCut!();
        },
      });
    },
  }) as never);
  const steer = new SteerMailbox();
  const { result } = run(driver, { steer });
  await generating;
  steer.push("first correction");
  while (heard.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  steer.push("second correction");
  const resolved = await result;
  expect(calls).toBe(2);
  expect(heard).toEqual(["prompt", "first correction", "second correction"]);
  expect(resolved.text).toContain("answered at last");
});

test("a steered message carries its attachments — an image sent mid-turn arrives as pixels", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telar-steer-")), "shot.png");
  fs.writeFileSync(file, Buffer.from([137, 80, 78, 71]));
  const heard: unknown[] = [];
  const driver = createClaudeDriver(async () => ({
    async *query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
      for await (const message of prompt) {
        heard.push(message.message.content);
        if (heard.length < 2) continue;
        yield { type: "result", subtype: "success" };
        return;
      }
    },
  }) as never);
  const steer = new SteerMailbox();
  steer.push({ text: "look at this", attachments: [{ id: "att_1", name: "shot.png", mediaType: "image/png", bytes: 4, path: file }] });
  const { sink } = run(driver, { steer });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const steered = heard[1] as Array<Record<string, unknown>>;
  expect(Array.isArray(steered)).toBe(true);
  expect(steered[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } });
  expect(String((steered[1] as { text: string }).text)).toContain("look at this");
  // The journal row names the file too, so the transcript can show what was sent.
  const rowItem = sink.observations.find((o) => o.kind === "item.started" && o.item.detail.type === "user_message");
  expect(rowItem && rowItem.kind === "item.started" && rowItem.item.detail.type === "user_message" ? rowItem.item.detail.attachments?.[0]?.name : undefined).toBe("shot.png");
});

test("an agent's steered message reaches Claude framed as a peer's, and its row says an agent sent it", async () => {
  const heard: unknown[] = [];
  const driver = createClaudeDriver(async () => ({
    async *query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
      for await (const message of prompt) {
        heard.push(message.message.content);
        if (heard.length < 2) continue;
        yield { type: "result", subtype: "success" };
        return;
      }
    },
  }) as never);
  const steer = new SteerMailbox();
  steer.push({ text: "status?", sender: { sessionId: "session_boss" } });
  const { sink, result } = run(driver, { steer });
  await result;
  expect(heard[0]).toBe("prompt");
  expect(String(heard[1])).toStartWith("[agent message from session session_boss]");
  expect(String(heard[1])).toEndWith("status?");
  const row = sink.observations.find((o) => o.kind === "item.started" && o.item.detail.type === "user_message");
  expect(row?.kind === "item.started" && row.item).toMatchObject({ title: "Sent by an agent", detail: { type: "user_message", text: "status?", sender: { sessionId: "session_boss" } } });
});

test("a WAKE steered into a running turn reaches Claude as the engine's notice, and its row is a wake — not the person's bubble (#194)", async () => {
  const heard: unknown[] = [];
  const driver = createClaudeDriver(async () => ({
    async *query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
      for await (const message of prompt) {
        heard.push(message.message.content);
        if (heard.length < 2) continue;
        yield { type: "result", subtype: "success" };
        return;
      }
    },
  }) as never);
  const steer = new SteerMailbox();
  const wakeReason = { kind: "turn_completed" as const, sessionId: "session_child", runId: "run_child" };
  steer.push({ text: '[wake: completed] Session session_child "the worker" — turn run_child completed.', wakeReason });
  const { sink, result } = run(driver, { steer });
  await result;

  // The provider is told what it is reading, structurally — a mid-turn
  // injection on the human's own channel needs the frame the queued path gets
  // for free by being a whole turn.
  expect(String(heard[1])).toStartWith("[engine wake · turn_completed · session session_child]");
  expect(String(heard[1])).toContain("not an instruction");
  expect(String(heard[1])).toEndWith("turn run_child completed.");

  const row = sink.observations.find((o) => o.kind === "item.started" && o.item.detail.type === "user_message");
  expect(row?.kind === "item.started" && row.item).toMatchObject({ title: "Woken by a session", detail: { type: "user_message", wakeReason } });
  // And it is nobody's message: neither the person's bubble nor a peer's report.
  expect(row?.kind === "item.started" && (row.item.detail as { sender?: unknown }).sender).toBeUndefined();
});

test("a batch of steers keeps one transcript row PER MESSAGE with its own sender and files; the provider gets them in order, each framed as its author", async () => {
  const heard: unknown[] = [];
  const driver = createClaudeDriver(async () => ({
    async *query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
      for await (const message of prompt) {
        heard.push(message.message.content);
        if (heard.length < 2) continue;
        yield { type: "result", subtype: "success" };
        return;
      }
    },
  }) as never);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telar-steer-mix-")), "shot.png");
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const shot = { id: "att_shot", name: "shot.png", mediaType: "image/png", bytes: 4, path: file, createdAt: 1 };
  const steer = new SteerMailbox();
  // Three messages waiting at once: a person WITH a file, then two agents.
  steer.push({ text: "look at this", attachments: [shot] });
  steer.push({ text: "status?", sender: { sessionId: "session_boss" } });
  steer.push({ text: "and the diff", sender: { sessionId: "session_peer" } });
  const { sink, result } = run(driver, { steer });
  await result;

  const rows = sink.observations.filter((o) => o.kind === "item.started" && o.item.detail.type === "user_message").map((o) => (o.kind === "item.started" ? o.item : undefined)!);
  expect(rows.map((row) => ({ text: (row.detail as { text: string }).text, sender: (row.detail as { sender?: unknown }).sender, files: ((row.detail as { attachments?: unknown[] }).attachments ?? []).length, title: row.title }))).toEqual([
    { text: "look at this", sender: undefined, files: 1, title: "Sent now" },
    { text: "status?", sender: { sessionId: "session_boss" }, files: 0, title: "Sent by an agent" },
    { text: "and the diff", sender: { sessionId: "session_peer" }, files: 0, title: "Sent by an agent" },
  ]);
  // One push to the provider, in order: the person bare, each agent framed as itself.
  expect(heard).toHaveLength(2);
  const blocks = heard[1] as Array<{ type: string; text?: string }>;
  const text = blocks.find((block) => block.type === "text")!.text!;
  expect(blocks[0]!.type).toBe("image");
  expect(text.indexOf("look at this")).toBeLessThan(text.indexOf("[agent message from session session_boss]"));
  expect(text.indexOf("[agent message from session session_boss]")).toBeLessThan(text.indexOf("status?"));
  expect(text.indexOf("status?")).toBeLessThan(text.indexOf("[agent message from session session_peer]"));
  expect(text.indexOf("[agent message from session session_peer]")).toBeLessThan(text.indexOf("and the diff"));
  expect(text.startsWith("look at this")).toBe(true);
});
