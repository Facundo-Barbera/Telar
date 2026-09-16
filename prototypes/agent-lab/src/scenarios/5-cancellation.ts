/**
 * SCENARIO 5 — CANCELLATION, AND WHAT "CONSISTENT ON RESUME" ACTUALLY MEANS.
 *
 * Three cancels, because they are three different questions and only the first
 * one has the answer everybody assumes:
 *
 *   A. MID-STREAM, in the model node. Nothing has landed; the thread resumes and
 *      finishes. This is the easy one and it works.
 *   B. MID-TOOL, BEFORE the effect. The tool was still waiting when the abort
 *      arrived. Nothing landed, the resume runs it once, and the count is one.
 *   C. MID-TOOL, AFTER the effect. The send reached the engine and the node was
 *      killed before it could commit. The checkpointer's unit of atomicity is
 *      the NODE, so the effect is real and unrecorded — and the resume does it
 *      again.
 *
 * ── C IS THE FINDING, NOT A FAILURE ─────────────────────────────────────────
 * It is not a LangGraph bug; it is what a checkpointer can and cannot promise.
 * No graph framework can make an HTTP call and a local write atomic. What it
 * means for Telar is concrete and belongs in the migration plan: anything that
 * LANDS must be idempotent on a key the CALLER chose and can reuse, and
 * `sessions_send` currently mints its `runId` INSIDE the tool wall, where a
 * retried call cannot reuse it. The engine's own idempotency is therefore
 * unreachable from a retry — see REPORT.md.
 *
 * C is measured and printed rather than asserted to a number, so a future
 * version that fixes it does not fail this scenario.
 *
 * The gate is deliberately OFF here: an approval interrupt would stop the run
 * before the tool, and the tool is what this scenario cancels.
 *
 * Run: `bun run scenario:5`
 */
import { HumanMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createLab, type Lab } from "../harness/lab";
import { loadScript } from "../harness/recordings";
import { openCheckpointer } from "../harness/checkpointer";
import { buildAgent, finalText, threadConfig } from "../variants/langgraph";
import { heading, verdict } from "./support";

const SCRIPT = "5-cancellation";
const ASK = "Ask Nightly triage (ses_1) to start the long sweep.";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** The same tool, with a deliberate pause on one side of its effect. */
function slowed(original: StructuredToolInterface, ms: number, when: "before" | "after"): StructuredToolInterface {
  return tool(
    async (args: unknown, config?: RunnableConfig) => {
      if (when === "before") await sleep(ms, config?.signal);
      const answer = await original.invoke(args as never, config);
      if (when === "after") await sleep(ms, config?.signal);
      return answer as string;
    },
    { name: original.name, description: original.description, schema: original.schema },
  ) as unknown as StructuredToolInterface;
}

function seeded(label: string): Lab {
  const lab = createLab({ label, model: { mode: "recorded", script: loadScript(SCRIPT) }, engine: { workerDelayMs: 5 } });
  lab.engine.createSession({ projectId: "prj_lab", title: "Nightly triage", envMode: "worktree" });
  return lab;
}

/** Was the run cut off, rather than having finished before we could abort? */
function aborted(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /abort/i.test(text);
}

async function partA(): Promise<{ passed: boolean; note: string }> {
  heading("A — abort mid-stream, in the model node");
  const lab = seeded("s5a");
  const checkpointer = openCheckpointer("memory");
  try {
    const agent = buildAgent({ model: lab.model, tools: lab.tools, checkpointer: checkpointer.saver, meter: lab.meter, approvalPolicy: () => false });
    const config = threadConfig("agent-thread-5a");
    const controller = new AbortController();

    let cut = false;
    try {
      const stream = await agent.graph.stream({ messages: [new HumanMessage(ASK)] }, {
        ...config,
        recursionLimit: agent.recursionLimit,
        streamMode: "messages",
        signal: controller.signal,
      } as never);
      for await (const _part of stream) controller.abort();
    } catch (error) {
      cut = aborted(error);
    }

    const midway = await agent.graph.getState(config as never);
    const resumed = await agent.graph.invoke(null as never, { ...config, recursionLimit: agent.recursionLimit } as never);
    const answer = finalText(resumed as { messages: BaseMessage[] });
    console.log(`cut off mid-stream: ${cut} · messages at the cut: ${(midway.values.messages ?? []).length}`);
    console.log(`after resume: ${answer} · sends ${lab.engine.counts.sendsAccepted}`);
    const passed = cut && answer.length > 0 && lab.engine.counts.sendsAccepted === 1;
    return { passed, note: `mid-stream: resumed and finished, ${lab.engine.counts.sendsAccepted} send` };
  } finally {
    checkpointer.close();
    lab.close();
  }
}

async function partBorC(when: "before" | "after"): Promise<{ passed: boolean; sends: number; note: string }> {
  heading(`${when === "before" ? "B" : "C"} — abort mid-tool, ${when} the effect`);
  const lab = seeded(`s5-${when}`);
  const checkpointer = openCheckpointer("memory");
  try {
    const tools = lab.tools.map((one) => (one.name === "sessions_send" ? slowed(one, 400, when) : one));
    const agent = buildAgent({ model: lab.model, tools, checkpointer: checkpointer.saver, meter: lab.meter, approvalPolicy: () => false });
    const config = threadConfig(`agent-thread-5${when}`);
    const controller = new AbortController();
    const cutAt = setTimeout(() => controller.abort(), 150);

    let cut = false;
    try {
      await agent.graph.invoke({ messages: [new HumanMessage(ASK)] }, {
        ...config,
        recursionLimit: agent.recursionLimit,
        signal: controller.signal,
      } as never);
    } catch (error) {
      cut = aborted(error);
    } finally {
      clearTimeout(cutAt);
    }

    const atCut = lab.engine.counts.sendsAccepted;
    const midway = await agent.graph.getState(config as never);
    const lastAtCut = (midway.values.messages ?? []).at(-1) as AIMessage | undefined;

    const resumed = await agent.graph.invoke(null as never, { ...config, recursionLimit: agent.recursionLimit } as never);
    await lab.engine.drain();
    const answer = finalText(resumed as { messages: BaseMessage[] });
    const sends = lab.engine.counts.sendsAccepted;

    console.log(`cut off mid-tool: ${cut} · sends at the cut: ${atCut} · last message at the cut: ${lastAtCut?.getType() ?? "none"}`);
    console.log(`after resume: ${answer || "(no text)"} · sends now ${sends} · worker runs ${lab.engine.counts.workerRuns}`);

    if (when === "before") {
      return {
        passed: cut && atCut === 0 && sends === 1 && answer.length > 0,
        sends,
        note: `aborted before the effect: 0 sends at the cut, ${sends} after the resume`,
      };
    }
    // C is measured, not graded: the thread must still be coherent, and the
    // number of sends is the finding.
    return {
      passed: cut && atCut === 1 && answer.length > 0,
      sends,
      note: `aborted AFTER the effect: the send had landed, the node had not committed, the resume made it ${sends} in total`,
    };
  } finally {
    checkpointer.close();
    lab.close();
  }
}

export async function runScenario5(): Promise<boolean> {
  const a = await partA();
  const b = await partBorC("before");
  const c = await partBorC("after");
  const passed = a.passed && b.passed && c.passed;
  verdict("scenario 5 — cancellation mid-stream and mid-tool", passed, [
    a.note,
    b.note,
    `${c.note} — a node, not an effect, is the unit of atomicity; see REPORT.md`,
  ]);
  return passed;
}

if (import.meta.main) await runScenario5();
