/**
 * SCENARIO 2 — STREAMING, AFTER A READ TOOL.
 *
 * The shape the cockpit needs: the Agent calls one read tool, then the answer
 * arrives as TOKENS rather than as a paragraph that appears at once. Both halves
 * matter — a framework that streams but cannot tell you a tool ran, or that runs
 * tools but only streams the final block, is a different product.
 *
 * ── THE LIVE HALF ───────────────────────────────────────────────────────────
 * With `TELAR_LIVE_SMOKE=1` this is one of the two scenarios that spends a real
 * OpenCode Go call, through the engine's own credential resolver and with the
 * two identification headers. It proves the prompt shape, the tool schemas the
 * walls produce, and the streaming path work against the real endpoint — which
 * is the only thing a recorded model cannot tell us. The provider's own token
 * counts are printed and written to `recordings/live/`.
 *
 * Run: `bun run scenario:2`   ·   live: `TELAR_LIVE_SMOKE=1 bun run scenario:2`
 */
import { HumanMessage, type AIMessageChunk } from "@langchain/core/messages";
import { createLab } from "../harness/lab";
import { loadScript, saveLiveCapture } from "../harness/recordings";
import { openCheckpointer } from "../harness/checkpointer";
import { buildAgent, threadConfig } from "../variants/langgraph";
import { describeCredential, liveSmokeEnabled } from "../harness/model";
import { heading, verdict } from "./support";

const SCRIPT = "2-streaming-read";
const THREAD = "agent-thread-2";

const ASK =
  "Is the Nightly triage session (id ses_1) busy right now? Call sessions_status on ses_1 first, then answer in one or two " +
  "sentences from what it returned.";

export async function runScenario2(): Promise<boolean> {
  const live = liveSmokeEnabled();
  heading(live ? "LIVE — one real OpenCode Go call" : "recorded");
  if (live) console.log(describeCredential());

  const lab = createLab({
    label: live ? "s2-live" : "s2",
    model: live ? { mode: "live", threadId: THREAD } : { mode: "recorded", script: loadScript(SCRIPT) },
  });
  const checkpointer = openCheckpointer("memory");
  try {
    lab.engine.createSession({ projectId: "prj_lab", title: "Nightly triage", envMode: "worktree" });
    lab.engine.send("ses_1", { runId: "run_seed", input: "warm it up", intent: "task" });
    await lab.engine.drain();

    const agent = buildAgent({ model: lab.model, tools: lab.tools, checkpointer: checkpointer.saver, meter: lab.meter });
    const config = { ...threadConfig(THREAD), recursionLimit: agent.recursionLimit, streamMode: "messages" as const };

    const chunks: string[] = [];
    let toolCallsSeen = 0;
    let firstChunkAfterTool = false;
    const stream = await agent.graph.stream({ messages: [new HumanMessage(ASK)] }, config as never);
    for await (const part of stream) {
      const [message] = part as [AIMessageChunk, Record<string, unknown>];
      // ASSISTANT TOKENS ONLY. `streamMode: "messages"` also carries the tool
      // result back out, and counting a 2 KB JSON answer as "streamed tokens"
      // would make every framework look like it streams.
      if (message?.getType?.() !== "ai") continue;
      const text = typeof message?.content === "string" ? message.content : "";
      if ((message?.tool_call_chunks?.length ?? 0) > 0) toolCallsSeen += message.tool_call_chunks!.length;
      if (!text) continue;
      if (toolCallsSeen > 0) firstChunkAfterTool = true;
      chunks.push(text);
    }

    const answer = chunks.join("");
    console.log(`stream chunks carrying text: ${chunks.length}`);
    console.log(`answer: ${answer.trim()}`);
    lab.meter.print();

    const toolCalls = lab.meter.totalToolCalls;
    const passed = chunks.length >= 2 && toolCalls >= 1 && firstChunkAfterTool && answer.trim().length > 0;

    if (live) {
      const file = saveLiveCapture(SCRIPT, {
        at: new Date().toISOString(),
        thread: THREAD,
        ask: ASK,
        answer,
        chunks: chunks.length,
        meter: lab.meter.summary(),
        samples: lab.meter.samples,
      });
      console.log(`live capture written to ${file}`);
    }

    verdict(`scenario 2 — streaming after a read tool${live ? " (LIVE)" : ""}`, passed, [
      `${toolCalls} tool call(s), then ${chunks.length} text chunks`,
      `model calls ${lab.meter.modelCalls} · prompt ${lab.meter.promptTokens} · completion ${lab.meter.completionTokens}${live ? " (provider-reported)" : " (estimated, 4 chars/token)"}`,
    ]);
    return passed;
  } finally {
    checkpointer.close();
    lab.close();
  }
}

if (import.meta.main) await runScenario2();
