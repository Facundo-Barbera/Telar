/**
 * SCENARIO 6 — A RETRY MUST NOT DELEGATE TWICE.
 *
 * The fixture worker is told to fail once. The Agent is woken with the failure,
 * looks at the session, and asks for the SAME task to be sent again — which is
 * the reasonable thing for a model to do and the dangerous thing for an engine
 * to obey. Two sweeps queued on one worker is two agents editing one worktree.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
 *   · The model asked for `sessions_send` TWICE. (Counted off the thread's own
 *     messages, so the scenario cannot pass by the model not retrying.)
 *   · The tool wall was reached ONCE. The effect ledger short-circuited the
 *     second call before it left the graph.
 *   · The fixture saw exactly ONE send and ONE create.
 *   · The person was asked to approve ONCE, not twice — a deduped call is not
 *     a new decision.
 *
 * ── AND WHAT THIS DOES NOT PROVE ────────────────────────────────────────────
 * The ledger is a property of the THREAD. It stops a retry the agent makes; it
 * does not stop a duplicate that two processes make concurrently, and it does
 * not survive a cancel that lands the effect and loses the node (scenario 5C).
 * The durable answer is an idempotency key the CALLER owns, sent to an engine
 * that dedupes on it — see REPORT.md.
 *
 * Run: `bun run scenario:6`
 */
import { HumanMessage, type AIMessage } from "@langchain/core/messages";
import { createLab } from "../harness/lab";
import { loadScript } from "../harness/recordings";
import { openCheckpointer } from "../harness/checkpointer";
import { buildAgent, finalText, threadConfig } from "../variants/langgraph";
import { drive } from "../harness/drive";
import { heading, verdict } from "./support";

const SCRIPT = "6-no-duplicate-delegation";
const THREAD = "agent-thread-6";

export async function runScenario6(): Promise<boolean> {
  const wallCalls: string[] = [];
  const lab = createLab({
    label: "s6",
    model: { mode: "recorded", script: loadScript(SCRIPT) },
    engine: { workerDelayMs: 20, failOnce: true },
    onToolCall: (name) => wallCalls.push(name),
  });
  const checkpointer = openCheckpointer("memory");
  try {
    const agent = buildAgent({ model: lab.model, tools: lab.tools, checkpointer: checkpointer.saver, meter: lab.meter });
    const config = threadConfig(THREAD);

    heading("turn one — delegate the sweep");
    const first = await drive(agent, { messages: [new HumanMessage("Get the triage sweep run, and tell me how it goes.")] }, config);
    console.log(`answer: ${finalText(first.state)}`);

    heading("the worker fails, and the Agent is woken with the failure");
    await lab.engine.drain();
    const wake = lab.engine.wakes[0];
    console.log(`wake: ${wake?.kind ?? "none"} on ${wake?.targetSessionId ?? "-"}`);
    if (!wake || wake.kind !== "turn_failed") {
      verdict("scenario 6", false, ["the fixture did not deliver a turn_failed wake"]);
      return false;
    }

    heading("turn two — the Agent retries the identical send");
    const second = await drive(
      agent,
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

    console.log(`answer: ${finalText(second.state)}`);
    console.log(`sessions_send — model asked ${requested}× · wall reached ${reachedWall}× · fixture saw ${lab.engine.counts.sendCalls}× · approvals asked ${approvals}×`);
    console.log(`sessions_create — fixture saw ${lab.engine.counts.create}× · worker runs ${lab.engine.counts.workerRuns}`);
    lab.meter.print();

    const passed =
      requested === 2 &&
      reachedWall === 1 &&
      lab.engine.counts.sendCalls === 1 &&
      lab.engine.counts.sendsAccepted === 1 &&
      lab.engine.counts.create === 1 &&
      approvals === 1;

    verdict("scenario 6 — no duplicate delegation on retry", passed, [
      `the model asked for the send ${requested} times; the fixture saw exactly ${lab.engine.counts.sendCalls}`,
      `one create, one worker, one approval — the retry cost nothing and woke nobody`,
    ]);
    return passed;
  } finally {
    checkpointer.close();
    lab.close();
  }
}

if (import.meta.main) await runScenario6();
