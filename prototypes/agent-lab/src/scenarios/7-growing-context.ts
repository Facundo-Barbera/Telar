/**
 * SCENARIO 7 — FORTY TURNS, AND WHERE THE CONTEXT GOES.
 *
 * The question the issue asks is not "how many tokens" but "where does each
 * variant start trimming or summarising, and does it lose the approval state
 * when it does". So this prints prompt tokens per model call as a SERIES, and
 * then checks that the thing a trim would most plausibly throw away — the
 * approved delegation from turn 3 — is still there at turn 40.
 *
 * ── THE ANSWER FOR A, STATED UP FRONT ───────────────────────────────────────
 * LangGraph trims nothing. `MessagesAnnotation` appends, the checkpointer stores
 * what it is given, and the prompt is whatever the graph hands the model. There
 * is no summariser, no window and no eviction anywhere in the package — so the
 * curve is linear until the provider refuses. That is not a defect: the
 * framework is a runtime, not a context manager. It IS the thing B claims to do
 * differently, which is why this number is the one that matters in the
 * comparison.
 *
 * ── THE LIVE CALL ───────────────────────────────────────────────────────────
 * With `TELAR_LIVE_SMOKE=1` the forty turns still run recorded — forty real
 * turns would be a model benchmark, which the issue forbids — and then ONE real
 * OpenCode Go call is made with the whole accumulated history. That answers the
 * only question a fake model cannot: does a prompt of this size, with these tool
 * schemas, work against the real endpoint, and what does the PROVIDER say the
 * prompt cost.
 *
 * Run: `bun run scenario:7`   ·   live: `TELAR_LIVE_SMOKE=1 bun run scenario:7`
 */
import { HumanMessage, SystemMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages";
import { createLab } from "../harness/lab";
import { loadScript, saveLiveCapture } from "../harness/recordings";
import { openCheckpointer } from "../harness/checkpointer";
import { buildAgent, effectKey, threadConfig } from "../variants/langgraph";
import { drive } from "../harness/drive";
import { describeCredential, goChatModel, liveSmokeEnabled } from "../harness/model";
import { estimatePromptTokens } from "../harness/recorded";
import { heading, verdict } from "./support";
import { GATED_TURN, TURNS } from "./7-shape";

const SCRIPT = "7-growing-context";
const THREAD = "agent-thread-7";

/** The delegation the run approves at turn 3 — the state a trimmer would eat. */
const GATED_ARGS = { sessionId: "ses_1", intent: "task", input: "Take the backlog sweep while I keep watch." };

export async function runScenario7(): Promise<boolean> {
  const live = liveSmokeEnabled();
  const lab = createLab({ label: "s7", model: { mode: "recorded", script: loadScript(SCRIPT) }, engine: { workerDelayMs: 5 } });
  const checkpointer = openCheckpointer("memory");
  try {
    lab.engine.createSession({ projectId: "prj_lab", title: "Nightly triage", envMode: "worktree" });
    lab.engine.send("ses_1", { runId: "run_seed", input: "warm up", intent: "task" });
    await lab.engine.drain();

    const agent = buildAgent({ model: lab.model, tools: lab.tools, checkpointer: checkpointer.saver, meter: lab.meter, recursionLimit: 12 });
    const config = threadConfig(THREAD);

    heading(`${TURNS} turns, one tool result each, approval-gated at turn ${GATED_TURN}`);
    let approvalsAsked = 0;
    let lastState: { messages: BaseMessage[]; effects: Record<string, string> } | undefined;
    for (let turn = 1; turn <= TURNS; turn += 1) {
      const result = await drive(
        agent,
        { messages: [new HumanMessage(`Turn ${turn}: what is ses_1 doing?`)] },
        config,
      );
      approvalsAsked += result.approvals.length;
      lastState = result.state;
      lab.meter.nextTurn();
    }
    await lab.engine.drain();

    lab.meter.printSeries(5);
    lab.meter.print();

    const messages = lastState?.messages ?? [];
    const first = lab.meter.samples[0];
    const last = lab.meter.samples[lab.meter.samples.length - 1];
    const growth = first && last ? last.promptTokens / Math.max(1, first.promptTokens) : 0;
    /** Did anything shrink? A trim or a summary would show as a fall. */
    const everFell = lab.meter.samples.some((sample, index) => index > 0 && sample.promptTokens < lab.meter.samples[index - 1].promptTokens);

    // The approval state, at turn 40: the ledger key from turn 3 and the
    // ToolMessage that answered it must both still be on the thread.
    const key = effectKey("sessions_send", GATED_ARGS);
    const ledgerKept = Boolean(lastState?.effects?.[key]);
    const sendToolMessageKept = messages.some((one) => one.getType() === "tool" && (one as { name?: string }).name === "sessions_send");

    console.log(`\nmessages on the thread after ${TURNS} turns: ${messages.length}`);
    console.log(`prompt tokens: first call ${first?.promptTokens ?? 0} → last call ${last?.promptTokens ?? 0} (×${growth.toFixed(1)})`);
    console.log(`prompt ever got smaller (a trim or a summary): ${everFell}`);
    console.log(`turn ${GATED_TURN}'s approved delegation still on the thread: ledger ${ledgerKept}, tool message ${sendToolMessageKept}`);
    console.log(`approvals asked across ${TURNS} turns: ${approvalsAsked} · sends the fixture saw: ${lab.engine.counts.sendsAccepted}`);

    let liveNote = "no live call (TELAR_LIVE_SMOKE unset)";
    if (live) {
      heading("LIVE — one real OpenCode Go call with the whole accumulated history");
      console.log(describeCredential());
      const model = goChatModel({ threadId: THREAD });
      const bound = model.bindTools(lab.tools);
      const prompt: BaseMessage[] = [
        new SystemMessage("You are Telar's built-in Agent. Answer in one sentence."),
        ...messages,
        new HumanMessage("In one sentence: what have we been doing for the last forty turns?"),
      ];
      try {
        const answer = (await bound.invoke(prompt)) as AIMessage;
        const usage = answer.usage_metadata;
        liveNote = `live: provider reported ${usage?.input_tokens ?? "?"} prompt tokens for ${prompt.length} messages (estimate said ${estimatePromptTokens(prompt)})`;
        console.log(liveNote);
        console.log(`live answer: ${typeof answer.content === "string" ? answer.content : JSON.stringify(answer.content)}`);
        const file = saveLiveCapture(SCRIPT, {
          at: new Date().toISOString(),
          thread: THREAD,
          messages: prompt.length,
          estimatedPromptTokens: estimatePromptTokens(prompt),
          usage,
          answer: answer.content,
        });
        console.log(`live capture written to ${file}`);
      } catch (error) {
        liveNote = `live call FAILED: ${error instanceof Error ? error.message : String(error)}`;
        console.log(liveNote);
      }
    }

    const passed =
      lab.meter.turns === TURNS &&
      lab.meter.samples.length >= TURNS &&
      everFell === false &&
      ledgerKept &&
      sendToolMessageKept &&
      approvalsAsked === 1 &&
      lab.engine.counts.sendsAccepted === 2; // the seeded warm-up plus turn 3's

    verdict(`scenario 7 — growing context over ${TURNS} turns`, passed, [
      `prompt tokens grew ${first?.promptTokens ?? 0} → ${last?.promptTokens ?? 0} across ${lab.meter.samples.length} model calls and never fell: LangGraph trims and summarises NOTHING`,
      `the approval state from turn ${GATED_TURN} was still on the thread at turn ${TURNS}`,
      liveNote,
    ]);
    return passed;
  } finally {
    checkpointer.close();
    lab.close();
  }
}

if (import.meta.main) await runScenario7();
