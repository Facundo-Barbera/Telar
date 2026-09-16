/**
 * THE SEVEN SCENARIOS, RUN AGAINST VARIANT B.
 *
 * Same fixture, same walls, same model scripts, same checkpointer and the same
 * assertions as `src/scenarios/*` — only `buildDeepAgent` replaces `buildAgent`.
 * Anywhere B is asserted differently from A, the difference is a FINDING and it
 * is commented at the point it happens rather than quietly relaxed.
 *
 * One file rather than seven because the seven bodies differ from A's only in
 * the builder; duplicating A's prose seven times would make the diff between
 * the variants harder to see, not easier.
 *
 *   bun run scenarios:b            all seven
 *   bun run scenarios:b -- --only 3
 *   TELAR_LIVE_SMOKE=1 bun run scenarios:b -- --only 7
 */
import { HumanMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { SystemMessage } from "@langchain/core/messages";
import { createLab, type Lab } from "../harness/lab";
import { loadScript, saveLiveCapture } from "../harness/recordings";
import { openCheckpointer } from "../harness/checkpointer";
import { buildDeepAgent, finalText, threadConfig, effectKey } from "../variants/deepagents";
import { drive, parkedInterrupts } from "../harness/drive";
import { describeCredential, goChatModel, liveSmokeEnabled } from "../harness/model";
import { estimatePromptTokens } from "../harness/recorded";
import { GATED_TURN, TURNS } from "../scenarios/7-shape";
import {
  emitChildResult,
  flag,
  freshThreadFile,
  hasFlag,
  heading,
  readChildResult,
  scriptPath,
  spawnResume,
  verdict,
} from "../scenarios/support";

const ME = scriptPath(import.meta.url);

/** Every scenario's evidence row, printed as JSON at the end for the report. */
type Row = {
  scenario: number;
  name: string;
  passed: boolean;
  modelCalls: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  storage: string;
  note: string;
};
const rows: Row[] = [];

function record(row: Row) {
  rows.push(row);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
}

function aborted(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /abort/i.test(text);
}

/** A tool that takes its time, so an abort can land either side of the effect. */
function slowed(inner: StructuredToolInterface, ms: number, when: "before" | "after"): StructuredToolInterface {
  return tool(
    async (args: Record<string, unknown>, config?: RunnableConfig) => {
      if (when === "before") await sleep(ms, config?.signal);
      const answer = await inner.invoke(args as never, config);
      if (when === "after") await sleep(ms, config?.signal);
      return typeof answer === "string" ? answer : String((answer as { content: unknown }).content);
    },
    { name: inner.name, description: inner.description, schema: inner.schema as never },
  ) as unknown as StructuredToolInterface;
}

// ── 1 ───────────────────────────────────────────────────────────────────────

const S1 = "1-own-state";
const T1 = "b-agent-thread-1";

async function resume1(file: string, threadId: string) {
  const lab = createLab({ label: "b1-resume", model: { mode: "recorded", script: loadScript(S1) } });
  const cp = openCheckpointer("sqlite", file);
  try {
    const agent = buildDeepAgent({ model: lab.model, tools: lab.tools, checkpointer: cp.saver, meter: lab.meter });
    const config = threadConfig(threadId);
    const before = await agent.graph.getState(config);
    const prior: BaseMessage[] = before.values.messages ?? [];
    const firstHuman = prior.find((one) => one.getType() === "human");
    const after = await agent.graph.invoke({ messages: [new HumanMessage("What did I ask you first?")] }, config);
    return {
      messageCount: prior.length,
      firstHuman: firstHuman ? String(firstHuman.content) : "",
      answer: finalText(after),
      createCalls: lab.engine.counts.create,
      // What Deep Agents put in the checkpoint BESIDE the messages.
      stateKeys: Object.keys(before.values ?? {}),
    };
  } finally {
    cp.close();
    lab.close();
  }
}

async function scenario1(): Promise<boolean> {
  const file = freshThreadFile(`b-${S1}`);
  heading("B/1 — the Agent's own thread, in the framework's checkpointer");
  const lab = createLab({ label: "b1", model: { mode: "recorded", script: loadScript(S1) } });
  const cp = openCheckpointer("sqlite", file);
  let createdForItself = 0;
  try {
    lab.engine.createSession({ projectId: "prj_lab", title: "Nightly triage", envMode: "worktree" });
    const seeded = lab.engine.counts.create;
    const agent = buildDeepAgent({ model: lab.model, tools: lab.tools, checkpointer: cp.saver, meter: lab.meter });
    const state = await agent.graph.invoke({ messages: [new HumanMessage("Which sessions are live on this engine?")] }, threadConfig(T1));
    createdForItself = lab.engine.counts.create - seeded;
    console.log(`answer: ${finalText(state)}`);
    console.log(`sessions created FOR THE AGENT ITSELF: ${createdForItself}`);
    console.log(`state keys Deep Agents checkpoints: ${Object.keys(state).join(", ")}`);
    console.log(`tools the model was shown: ${agent.injectedToolNames().length} (${lab.tools.length} walls + ${agent.injectedToolNames().length - lab.tools.length} injected)`);
    lab.meter.print();
  } finally {
    cp.close();
    lab.close();
  }

  heading("B/1 — second process, resume by thread id alone");
  const child = await spawnResume(ME, ["--only", "1", "--resume", T1, "--file", file]);
  if (child.code !== 0) {
    console.log(child.stdout);
    console.error(child.stderr);
    verdict("B scenario 1", false, ["the resuming child exited non-zero"]);
    return false;
  }
  const resumed = readChildResult<Awaited<ReturnType<typeof resume1>>>(child);
  console.log(`child saw ${resumed.messageCount} messages · state keys ${resumed.stateKeys.join(", ")}`);
  console.log(`child's answer: ${resumed.answer}`);

  const passed =
    createdForItself === 0 &&
    resumed.messageCount === 4 &&
    resumed.firstHuman === "Which sessions are live on this engine?" &&
    resumed.answer.includes("Nightly triage") &&
    resumed.createCalls === 0;

  verdict("B scenario 1 — own state, no Telar session", passed, [
    `the Agent's thread cost ${createdForItself} sessions_create calls`,
    `a fresh process resumed ${resumed.messageCount} messages from sqlite by thread id alone`,
    `Deep Agents also checkpoints its virtual filesystem: state keys were ${resumed.stateKeys.join(", ")}`,
  ]);
  return passed;
}

// ── 2 ───────────────────────────────────────────────────────────────────────

const S2 = "2-streaming-read";

async function scenario2(): Promise<boolean> {
  const live = liveSmokeEnabled();
  const lab = createLab({ label: "b2", model: { mode: "recorded", script: loadScript(S2) } });
  const cp = openCheckpointer("memory");
  try {
    lab.engine.createSession({ projectId: "prj_lab", title: "Nightly triage", envMode: "worktree" });
    const agent = buildDeepAgent({ model: lab.model, tools: lab.tools, checkpointer: cp.saver, meter: lab.meter });
    const config = threadConfig("b-agent-thread-2");

    heading("B/2 — one read tool, then tokens");
    const chunks: string[] = [];
    let toolCalls = 0;
    let firstChunkAfterTool = false;
    const stream = await agent.graph.stream({ messages: [new HumanMessage("What is Nightly triage doing right now?")] }, {
      ...config,
      recursionLimit: agent.recursionLimit,
      streamMode: "messages",
    } as never);
    for await (const part of stream as AsyncIterable<[BaseMessage, unknown]>) {
      const [message] = part;
      if (message.getType() === "tool") { toolCalls += 1; continue; }
      const text = typeof message.content === "string" ? message.content : "";
      if (!text) continue;
      if (toolCalls > 0 && chunks.length === 0) firstChunkAfterTool = true;
      chunks.push(text);
    }
    const answer = chunks.join("");
    console.log(`chunks: ${chunks.length} · tool results seen in the stream: ${toolCalls}`);
    console.log(`answer: ${answer}`);
    lab.meter.print();

    let note = "recorded only";
    if (live) {
      heading("B/2 LIVE — one real OpenCode Go call through Deep Agents");
      console.log(describeCredential());
      const liveLab = createLab({ label: "b2-live", model: { mode: "live", threadId: "b-agent-thread-2" } });
      const liveCp = openCheckpointer("memory");
      try {
        liveLab.engine.createSession({ projectId: "prj_lab", title: "Nightly triage", envMode: "worktree" });
        const liveAgent = buildDeepAgent({ model: liveLab.model, tools: liveLab.tools, checkpointer: liveCp.saver, meter: liveLab.meter });
        const result = await liveAgent.graph.invoke(
          { messages: [new HumanMessage("Call sessions_list once, then say in one sentence what is live.")] },
          { ...threadConfig("b-agent-thread-2-live"), recursionLimit: liveAgent.recursionLimit },
        );
        const summary = liveLab.meter.summary();
        note = `live: ${summary.modelCalls} model calls, provider reported ${summary.promptTokens} prompt / ${summary.completionTokens} completion tokens`;
        console.log(note);
        console.log(`live answer: ${finalText(result)}`);
        console.log(`live capture: ${saveLiveCapture("b-2-streaming-read", { at: new Date().toISOString(), answer: finalText(result), meter: summary, injectedTools: liveAgent.injectedToolNames() })}`);
      } catch (error) {
        note = `live call FAILED: ${error instanceof Error ? error.message : String(error)}`;
        console.log(note);
      } finally {
        liveCp.close();
        liveLab.close();
      }
    }

    const passed = chunks.length >= 2 && toolCalls >= 1 && firstChunkAfterTool && answer.trim().length > 0;
    verdict("B scenario 2 — streaming after a read tool", passed, [
      `${chunks.length} token chunks, the first arriving after ${toolCalls} tool result(s)`,
      note,
    ]);
    const m = lab.meter;
    record({ scenario: 2, name: "streaming + read tool", passed, modelCalls: m.modelCalls, toolCalls: m.totalToolCalls, promptTokens: m.promptTokens, completionTokens: m.completionTokens, storage: "memory", note });
    return passed;
  } finally {
    cp.close();
    lab.close();
  }
}

// ── 3 ───────────────────────────────────────────────────────────────────────

const S3 = "3-approval-restart";
const T3 = "b-agent-thread-3";

async function resume3(file: string, threadId: string) {
  const lab = createLab({ label: "b3-resume", model: { mode: "recorded", script: loadScript(S3) } });
  const cp = openCheckpointer("sqlite", file);
  try {
    lab.engine.createSession({ projectId: "prj_lab", title: "Nightly triage", envMode: "worktree" });
    const agent = buildDeepAgent({ model: lab.model, tools: lab.tools, checkpointer: cp.saver, meter: lab.meter });
    const config = threadConfig(threadId);
    const parked = (await parkedInterrupts(agent as never, config))[0];
    const result = await drive(agent as never, null, config, () => "accept");
    await lab.engine.drain();
    return {
      parkedTool: parked?.tool ?? "",
      parkedArgs: (parked?.args ?? {}) as Record<string, unknown>,
      sendCalls: lab.engine.counts.sendCalls,
      sendsAccepted: lab.engine.counts.sendsAccepted,
      answer: finalText(result.state),
    };
  } finally {
    cp.close();
    lab.close();
  }
}

async function scenario3(): Promise<boolean> {
  const file = freshThreadFile(`b-${S3}`);
  heading("B/3 — the gate parks, and the process goes away");
  const lab = createLab({ label: "b3", model: { mode: "recorded", script: loadScript(S3) } });
  const cp = openCheckpointer("sqlite", file);
  let parentSends = 0;
  let parkedTool = "";
  try {
    lab.engine.createSession({ projectId: "prj_lab", title: "Nightly triage", envMode: "worktree" });
    const agent = buildDeepAgent({ model: lab.model, tools: lab.tools, checkpointer: cp.saver, meter: lab.meter });
    const config = threadConfig(T3);
    await agent.graph.invoke({ messages: [new HumanMessage("Ask Nightly triage (ses_1) to take the backlog sweep.")] }, { ...config, recursionLimit: agent.recursionLimit });
    const parked = (await parkedInterrupts(agent as never, config))[0];
    parkedTool = parked?.tool ?? "";
    parentSends = lab.engine.counts.sendCalls;
    console.log(`parked: ${parkedTool} ${JSON.stringify(parked?.args ?? {})}`);
    console.log(`sends before anyone approved: ${parentSends}`);
  } finally {
    cp.close();
    lab.close();
  }

  heading("B/3 — a new process answers the question it never asked");
  const child = await spawnResume(ME, ["--only", "3", "--resume", T3, "--file", file]);
  if (child.code !== 0) {
    console.log(child.stdout);
    console.error(child.stderr);
    verdict("B scenario 3", false, ["the resuming child exited non-zero"]);
    return false;
  }
  const resumed = readChildResult<Awaited<ReturnType<typeof resume3>>>(child);
  console.log(`child read the parked call as ${resumed.parkedTool} ${JSON.stringify(resumed.parkedArgs)}`);
  console.log(`child sent ${resumed.sendCalls} · answer: ${resumed.answer}`);

  const passed =
    parentSends === 0 &&
    parkedTool === "sessions_send" &&
    resumed.parkedTool === "sessions_send" &&
    resumed.parkedArgs.intent === "task" &&
    resumed.parkedArgs.sessionId === "ses_1" &&
    resumed.sendCalls === 1 &&
    resumed.sendsAccepted === 1 &&
    resumed.answer.length > 0;

  verdict("B scenario 3 — permission interrupt survives restart", passed, [
    `parent parked before any effect: ${parentSends} sends`,
    `child read the parked call's own arguments out of the checkpoint, then sent exactly ${resumed.sendCalls}`,
  ]);
  return passed;
}

// ── 4 ───────────────────────────────────────────────────────────────────────

async function scenario4(): Promise<boolean> {
  const lab = createLab({ label: "b4", model: { mode: "recorded", script: loadScript("4-delegation") }, engine: { workerDelayMs: 20 } });
  const cp = openCheckpointer("memory");
  try {
    const agent = buildDeepAgent({ model: lab.model, tools: lab.tools, checkpointer: cp.saver, meter: lab.meter });
    const config = threadConfig("b-agent-thread-4");

    heading("B/4 — create, send, subscribe");
    const first = await drive(agent as never, { messages: [new HumanMessage("Get the release notes drafted by a worker, then tell me what it said.")] }, config);
    console.log(`turn one: ${finalText(first.state)}`);

    await lab.engine.drain();
    const wakes = lab.engine.wakes;
    console.log(`wakes delivered: ${wakes.map((one) => one.kind).join(", ") || "none"}`);

    heading("B/4 — the wake runs as a second turn on the same thread");
    const wake = wakes[0];
    const second = await drive(
      agent as never,
      { messages: [new HumanMessage(`[wake] ${wake?.kind} on session ${wake?.targetSessionId} (run ${wake?.runId}). Read it and report.`)] },
      config,
    );
    const answer = finalText(second.state);
    const workerTurn = wake ? lab.engine.turns(wake.targetSessionId)[0] : undefined;
    console.log(`turn two: ${answer}`);
    lab.meter.print();

    const passed =
      lab.engine.counts.create === 1 &&
      lab.engine.counts.sendsAccepted === 1 &&
      wakes.length === 1 &&
      wakes[0].kind === "turn_completed" &&
      workerTurn?.state === "completed" &&
      answer.toLowerCase().includes("release notes");

    verdict("B scenario 4 — delegation round trip", passed, [
      `one create, one send, one subscription, one wake, one report`,
      `the wake ran as a second turn on the SAME thread and saw the first turn's history`,
      `approvals: ${first.approvals.length + second.approvals.length} asked`,
    ]);
    const m = lab.meter;
    record({ scenario: 4, name: "delegation round trip", passed, modelCalls: m.modelCalls, toolCalls: m.totalToolCalls, promptTokens: m.promptTokens, completionTokens: m.completionTokens, storage: "memory", note: "wake arrives as a second turn, not a return value" });
    return passed;
  } finally {
    cp.close();
    lab.close();
  }
}

// ── 5 ───────────────────────────────────────────────────────────────────────

function seeded5(label: string): Lab {
  const lab = createLab({ label, model: { mode: "recorded", script: loadScript("5-cancellation") }, engine: { workerDelayMs: 20 } });
  lab.engine.createSession({ projectId: "prj_lab", title: "Nightly triage", envMode: "worktree" });
  return lab;
}

const ASK5 = "Ask Nightly triage (ses_1) to start the long sweep.";

async function scenario5(): Promise<boolean> {
  heading("B/5A — abort mid-stream");
  let aPassed = false;
  let aNote = "";
  {
    const lab = seeded5("b5a");
    const cp = openCheckpointer("memory");
    try {
      const agent = buildDeepAgent({ model: lab.model, tools: lab.tools, checkpointer: cp.saver, meter: lab.meter, approvalPolicy: () => false });
      const config = threadConfig("b-agent-thread-5a");
      const controller = new AbortController();
      let cut = false;
      try {
        const stream = await agent.graph.stream({ messages: [new HumanMessage(ASK5)] }, { ...config, recursionLimit: agent.recursionLimit, streamMode: "messages", signal: controller.signal } as never);
        for await (const _part of stream as AsyncIterable<unknown>) controller.abort();
      } catch (error) { cut = aborted(error); }
      const resumed = await agent.graph.invoke(null, { ...config, recursionLimit: agent.recursionLimit });
      const answer = finalText(resumed);
      aPassed = cut && answer.length > 0 && lab.engine.counts.sendsAccepted === 1;
      aNote = `mid-stream: cut ${cut}, resumed and finished, ${lab.engine.counts.sendsAccepted} send`;
      console.log(aNote);
    } finally { cp.close(); lab.close(); }
  }

  const part = async (when: "before" | "after") => {
    heading(`B/5${when === "before" ? "B" : "C"} — abort mid-tool, ${when} the effect`);
    const lab = seeded5(`b5-${when}`);
    const cp = openCheckpointer("memory");
    try {
      const tools = lab.tools.map((one) => (one.name === "sessions_send" ? slowed(one, 400, when) : one));
      const agent = buildDeepAgent({ model: lab.model, tools, checkpointer: cp.saver, meter: lab.meter, approvalPolicy: () => false });
      const config = threadConfig(`b-agent-thread-5${when}`);
      const controller = new AbortController();
      const cutAt = setTimeout(() => controller.abort(), 150);
      let cut = false;
      try {
        await agent.graph.invoke({ messages: [new HumanMessage(ASK5)] }, { ...config, recursionLimit: agent.recursionLimit, signal: controller.signal });
      } catch (error) { cut = aborted(error); } finally { clearTimeout(cutAt); }

      const atCut = lab.engine.counts.sendsAccepted;
      const resumed = await agent.graph.invoke(null, { ...config, recursionLimit: agent.recursionLimit });
      await lab.engine.drain();
      const answer = finalText(resumed);
      const sends = lab.engine.counts.sendsAccepted;
      console.log(`cut ${cut} · sends at the cut ${atCut} · sends after resume ${sends}`);
      if (when === "before") return { passed: cut && atCut === 0 && sends === 1 && answer.length > 0, sends, note: `aborted before the effect: 0 at the cut, ${sends} after the resume` };
      return { passed: cut && atCut === 1 && answer.length > 0, sends, note: `aborted AFTER the effect: the send had landed, the node had not committed, total ${sends}` };
    } finally { cp.close(); lab.close(); }
  };

  const b = await part("before");
  const c = await part("after");
  const passed = aPassed && b.passed && c.passed;
  verdict("B scenario 5 — cancellation mid-stream and mid-tool", passed, [aNote, b.note, `${c.note} — a node, not an effect, is the unit of atomicity`]);
  record({ scenario: 5, name: "cancellation", passed, modelCalls: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, storage: "memory", note: `${c.note}` });
  return passed;
}

// ── 6 ───────────────────────────────────────────────────────────────────────

async function scenario6(): Promise<boolean> {
  const wallCalls: string[] = [];
  const lab = createLab({
    label: "b6",
    model: { mode: "recorded", script: loadScript("6-no-duplicate-delegation") },
    engine: { workerDelayMs: 20, failOnce: true },
    onToolCall: (name) => wallCalls.push(name),
  });
  const cp = openCheckpointer("memory");
  try {
    const agent = buildDeepAgent({ model: lab.model, tools: lab.tools, checkpointer: cp.saver, meter: lab.meter });
    const config = threadConfig("b-agent-thread-6");

    heading("B/6 — delegate, fail once, retry");
    const first = await drive(agent as never, { messages: [new HumanMessage("Get the triage sweep run, and tell me how it goes.")] }, config);
    console.log(`turn one: ${finalText(first.state)}`);
    await lab.engine.drain();
    const wake = lab.engine.wakes[0];
    if (!wake || wake.kind !== "turn_failed") {
      verdict("B scenario 6", false, ["the fixture did not deliver a turn_failed wake"]);
      return false;
    }
    const second = await drive(
      agent as never,
      { messages: [new HumanMessage(`[wake] ${wake.kind} on session ${wake.targetSessionId} (run ${wake.runId}). Find out what happened and get the work done.`)] },
      config,
    );
    await lab.engine.drain();

    const requested = second.state.messages
      .filter((one): one is AIMessage => one.getType() === "ai")
      .flatMap((one) => one.tool_calls ?? [])
      .filter((call) => call.name === "sessions_send").length;
    const reachedWall = wallCalls.filter((name) => name === "sessions_send").length;
    const approvals = [...first.approvals, ...second.approvals].filter((one) => one.request.tool === "sessions_send").length;

    console.log(`sessions_send — model asked ${requested}× · wall reached ${reachedWall}× · fixture saw ${lab.engine.counts.sendCalls}× · approvals ${approvals}×`);
    lab.meter.print();

    const passed =
      requested === 2 &&
      reachedWall === 1 &&
      lab.engine.counts.sendCalls === 1 &&
      lab.engine.counts.sendsAccepted === 1 &&
      lab.engine.counts.create === 1 &&
      approvals === 1;

    verdict("B scenario 6 — no duplicate delegation on retry", passed, [
      `the model asked for the send ${requested} times; the fixture saw ${lab.engine.counts.sendCalls}`,
      `the ledger that made this pass is ours, not the framework's — Deep Agents ships no idempotency`,
    ]);
    const m = lab.meter;
    record({ scenario: 6, name: "no duplicate delegation", passed, modelCalls: m.modelCalls, toolCalls: m.totalToolCalls, promptTokens: m.promptTokens, completionTokens: m.completionTokens, storage: "memory", note: "passes only because variant B carries a hand-written effect ledger" });
    return passed;
  } finally {
    cp.close();
    lab.close();
  }
}

// ── 7 ───────────────────────────────────────────────────────────────────────

const GATED_ARGS = { sessionId: "ses_1", intent: "task", input: "Take the backlog sweep while I keep watch." };

async function scenario7(): Promise<boolean> {
  const live = liveSmokeEnabled();
  const lab = createLab({ label: "b7", model: { mode: "recorded", script: loadScript("7-growing-context") }, engine: { workerDelayMs: 5 } });
  const cp = openCheckpointer("memory");
  try {
    lab.engine.createSession({ projectId: "prj_lab", title: "Nightly triage", envMode: "worktree" });
    lab.engine.send("ses_1", { runId: "run_seed", input: "warm up", intent: "task" });
    await lab.engine.drain();

    const agent = buildDeepAgent({ model: lab.model, tools: lab.tools, checkpointer: cp.saver, meter: lab.meter, recursionLimit: 12 });
    const config = threadConfig("b-agent-thread-7");

    heading(`B/7 — ${TURNS} turns, approval-gated at turn ${GATED_TURN}`);
    let approvalsAsked = 0;
    let lastState: { messages: BaseMessage[]; effects: Record<string, string> } | undefined;
    for (let turn = 1; turn <= TURNS; turn += 1) {
      const result = await drive(agent as never, { messages: [new HumanMessage(`Turn ${turn}: what is ses_1 doing?`)] }, config);
      approvalsAsked += result.approvals.length;
      lastState = result.state as never;
      lab.meter.nextTurn();
    }
    await lab.engine.drain();
    lab.meter.printSeries(5);
    lab.meter.print();

    const messages = lastState?.messages ?? [];
    const first = lab.meter.samples[0];
    const last = lab.meter.samples[lab.meter.samples.length - 1];
    const growth = first && last ? last.promptTokens / Math.max(1, first.promptTokens) : 0;
    const everFell = lab.meter.samples.some((s, i) => i > 0 && s.promptTokens < lab.meter.samples[i - 1].promptTokens);

    const key = effectKey("sessions_send", GATED_ARGS);
    const ledgerKept = Boolean(lastState?.effects?.[key]);
    const sendToolMessageKept = messages.some((one) => one.getType() === "tool" && (one as { name?: string }).name === "sessions_send");

    console.log(`\nmessages on the thread after ${TURNS} turns: ${messages.length}`);
    console.log(`prompt tokens: ${first?.promptTokens ?? 0} → ${last?.promptTokens ?? 0} (×${growth.toFixed(1)})`);
    console.log(`prompt ever got smaller (a trim or a summary): ${everFell}`);
    console.log(`turn ${GATED_TURN}'s approved delegation still on the thread: ledger ${ledgerKept}, tool message ${sendToolMessageKept}`);

    let liveNote = "no live call (TELAR_LIVE_SMOKE unset)";
    if (live) {
      heading("B/7 LIVE — one real OpenCode Go call with the whole accumulated history");
      console.log(describeCredential());
      try {
        const model = goChatModel({ threadId: "b-agent-thread-7" });
        const bound = model.bindTools(lab.tools);
        const prompt: BaseMessage[] = [
          new SystemMessage("You are Telar's built-in Agent. Answer in one sentence."),
          ...messages,
          new HumanMessage("In one sentence: what have we been doing for the last forty turns?"),
        ];
        const answer = (await bound.invoke(prompt)) as AIMessage;
        liveNote = `live: provider reported ${answer.usage_metadata?.input_tokens ?? "?"} prompt tokens for ${prompt.length} messages (estimate said ${estimatePromptTokens(prompt)})`;
        console.log(liveNote);
        console.log(`live capture: ${saveLiveCapture("b-7-growing-context", { at: new Date().toISOString(), messages: prompt.length, estimatedPromptTokens: estimatePromptTokens(prompt), usage: answer.usage_metadata, answer: answer.content })}`);
      } catch (error) {
        liveNote = `live call FAILED: ${error instanceof Error ? error.message : String(error)}`;
        console.log(liveNote);
      }
    }

    const passed =
      lab.meter.turns === TURNS &&
      lab.meter.samples.length >= TURNS &&
      ledgerKept &&
      sendToolMessageKept &&
      approvalsAsked === 1 &&
      lab.engine.counts.sendsAccepted === 2;

    verdict(`B scenario 7 — growing context over ${TURNS} turns`, passed, [
      `prompt tokens ${first?.promptTokens ?? 0} → ${last?.promptTokens ?? 0} across ${lab.meter.samples.length} model calls; ever fell: ${everFell}`,
      `the approval state from turn ${GATED_TURN} was still on the thread at turn ${TURNS}`,
      liveNote,
    ]);
    const m = lab.meter;
    record({ scenario: 7, name: "growing context, 40 turns", passed, modelCalls: m.modelCalls, toolCalls: m.totalToolCalls, promptTokens: m.promptTokens, completionTokens: m.completionTokens, storage: "memory", note: `first ${first?.promptTokens ?? 0} → last ${last?.promptTokens ?? 0} tok, summarised: ${everFell}` });
    return passed;
  } finally {
    cp.close();
    lab.close();
  }
}

/**
 * 7F — THE SAME FORTY TURNS, WITH THE SUMMARISER FORCED TO FIRE.
 *
 * Scenario 7 shows that Deep Agents' summariser does NOT run at Telar's sizes:
 * its default trigger for a model that declares no context window is a flat
 * 170,000 tokens, and forty turns reach about 9,600. That answers "does it
 * change the numbers" with "no", but it leaves the more interesting question
 * unanswered — when it DOES fire, is the approved delegation from turn 3 still
 * there at turn 40?
 *
 * So this run drops the trigger to 2,000 tokens, which forty turns cross early,
 * and then asks exactly the questions the issue asks: does the prompt curve
 * bend, and does the approval state survive the bend.
 */
async function scenario7Forced(): Promise<boolean> {
  const lab = createLab({ label: "b7f", model: { mode: "recorded", script: loadScript("7-growing-context") }, engine: { workerDelayMs: 5 } });
  const cp = openCheckpointer("memory");
  try {
    lab.engine.createSession({ projectId: "prj_lab", title: "Nightly triage", envMode: "worktree" });
    lab.engine.send("ses_1", { runId: "run_seed", input: "warm up", intent: "task" });
    await lab.engine.drain();

    const agent = buildDeepAgent({
      model: lab.model, tools: lab.tools, checkpointer: cp.saver, meter: lab.meter,
      recursionLimit: 12, summarizeAfterTokens: 2000,
    });
    const config = threadConfig("b-agent-thread-7f");

    heading(`B/7F — ${TURNS} turns with the summariser triggered at 2,000 tokens`);
    let approvalsAsked = 0;
    let lastState: { messages: BaseMessage[]; effects: Record<string, string> } | undefined;
    let stoppedAt = 0;
    let stoppedBecause = "";
    try {
      for (let turn = 1; turn <= TURNS; turn += 1) {
        stoppedAt = turn;
        const result = await drive(agent as never, { messages: [new HumanMessage(`Turn ${turn}: what is ses_1 doing?`)] }, config);
        approvalsAsked += result.approvals.length;
        lastState = result.state as never;
        lab.meter.nextTurn();
      }
      stoppedAt = TURNS;
    } catch (error) {
      stoppedBecause = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
    lab.meter.printSeries(5);

    const samples = lab.meter.samples;
    const peak = samples.length ? Math.max(...samples.map((s) => s.promptTokens)) : 0;
    const falls = samples.filter((s, i) => i > 0 && s.promptTokens < samples[i - 1].promptTokens).length;
    const smallest = samples.length ? Math.min(...samples.map((s) => s.messages)) : 0;

    const messages = lastState?.messages ?? [];
    const key = effectKey("sessions_send", GATED_ARGS);
    const ledgerKept = Boolean(lastState?.effects?.[key]);
    const state = await agent.graph.getState(config);
    const historyFiles = Object.keys(state.values?.files ?? {});

    console.log(`\nprompt tokens fell ${falls} time(s) across ${samples.length} calls · peak ${peak}`);
    console.log(`smallest message list the model was handed after a summary: ${smallest}`);
    console.log(`turns completed before the run stopped: ${stoppedAt} of ${TURNS}${stoppedBecause ? ` — ${stoppedBecause}` : ""}`);
    console.log(`offloaded history files in the virtual filesystem: ${historyFiles.length ? historyFiles.join(", ") : "none"}`);
    console.log(`approvals asked: ${approvalsAsked} · sends the fixture accepted: ${lab.engine.counts.sendsAccepted}`);

    // ── WHAT THIS RUN CAN AND CANNOT SHOW ────────────────────────────────────
    // It shows the summariser FIRES and what it leaves behind. It cannot show
    // whether the approval survives forty turns, for two compounding reasons:
    //
    //  1. `RecordedChatModel`'s cursor is the AI-message count, which a
    //     summariser rewrites — so the stock fixture replays its opening
    //     forever. `CursorlessModel` above works around that.
    //  2. With the trigger forced low enough to fire inside forty small turns,
    //     the summariser hands the model a ONE-MESSAGE context in the middle of
    //     a tool cycle — the tool result it is supposed to answer is gone — and
    //     the agent loop cannot close the turn. That is what the trace shows and
    //     what ends the run.
    //
    // (2) may well be an artefact of an unrealistically low trigger rather than
    // a defect: the shipped default is 170,000 tokens and nothing in Telar's
    // sizes comes near it. Either way it is not free behaviour you switch on —
    // it needs its own tuning and its own tests. Recorded as UNTESTED, not as a
    // loss.
    const summariserFired = falls > 0;
    const passed = summariserFired;
    verdict("B scenario 7F — forced summarisation (a probe, not a grade)", passed, [
      `the summariser ran: the prompt curve bent ${falls} time(s), which scenario 7's never does`,
      `after a summary the model was handed as few as ${smallest} message(s)${stoppedBecause ? `, mid-tool-cycle, and the run stopped at turn ${stoppedAt}/${TURNS}: ${stoppedBecause}` : ` — the run still completed all ${TURNS} turns`}`,
      `nothing was offloaded to the virtual filesystem at this size (${historyFiles.length} files)`,
      `WHETHER THE TURN-${GATED_TURN} APPROVAL SURVIVES SUMMARISATION IS UNTESTED — see the comment in this function for why`,
    ]);
    const m = lab.meter;
    record({
      scenario: 7.5, name: "forced summarisation (probe)", passed,
      modelCalls: m.modelCalls, toolCalls: m.totalToolCalls, promptTokens: m.promptTokens, completionTokens: m.completionTokens,
      storage: "memory",
      note: `summariser fires (curve fell ${falls}×) but hands back ${smallest}-message contexts mid-tool-cycle; approval preservation UNTESTED`,
    });
    return passed;
  } finally {
    cp.close();
    lab.close();
  }
}

// ── entry ───────────────────────────────────────────────────────────────────

const RUNNERS: Record<string, () => Promise<boolean>> = { "1": scenario1, "2": scenario2, "3": scenario3, "4": scenario4, "5": scenario5, "6": scenario6, "7": scenario7, "7f": scenario7Forced };

if (import.meta.main) {
  const only = flag("only");
  const resume = flag("resume");
  if (resume !== undefined && resume !== "") {
    const file = flag("file");
    if (!file) throw new Error("--resume needs --file");
    if (only === "1") emitChildResult(await resume1(file, resume));
    else if (only === "3") emitChildResult(await resume3(file, resume));
    else throw new Error(`no resume path for scenario ${only}`);
  } else {
    const wanted = only ? [only] : ["1", "2", "3", "4", "5", "6", "7", "7f"];
    let allPassed = true;
    for (const n of wanted) {
      const passed = await RUNNERS[n]?.();
      if (passed === false) allPassed = false;
    }
    if (hasFlag("json")) console.log(`\n@@ROWS@@ ${JSON.stringify(rows)}`);
    if (!allPassed) process.exitCode = 1;
  }
}
