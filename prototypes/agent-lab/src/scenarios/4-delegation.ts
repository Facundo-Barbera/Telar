/**
 * SCENARIO 4 — THE DELEGATION ROUND TRIP.
 *
 * Create a session, give it work, subscribe to it, be woken when it finishes,
 * and report what it said. This is the Agent's whole reason to exist, and it is
 * the one scenario where Telar's own model — peers and subscriptions, no parent
 * and no child — meets a framework that has its own opinions about subagents.
 *
 * ── THE WAKE ARRIVES AS A TURN, NOT AS A RETURN VALUE ───────────────────────
 * `sessions_send` does not block and must not: the tool answers "accepted for
 * execution, not answered" and the agent's turn ENDS. What comes back later is a
 * new turn on the Agent's own thread, carrying the wake. That is exactly how the
 * engine already wakes a subscribed session, and it is why this scenario runs
 * the graph TWICE on one thread — the second run is the wake, and the fact that
 * it can see everything the first one did is the checkpointer doing its job.
 *
 * ── THE GATE IS ON ──────────────────────────────────────────────────────────
 * The send is approval-gated, so the run parks and `drive` plays the person who
 * accepts. Scenario 3 is where the gate is the subject; here it is the ordinary
 * path a delegation takes.
 *
 * Run: `bun run scenario:4`
 */
import { HumanMessage } from "@langchain/core/messages";
import { createLab } from "../harness/lab";
import { loadScript } from "../harness/recordings";
import { openCheckpointer } from "../harness/checkpointer";
import { buildAgent, finalText, threadConfig } from "../variants/langgraph";
import { drive } from "../harness/drive";
import { heading, verdict } from "./support";

const SCRIPT = "4-delegation";
const THREAD = "agent-thread-4";

export async function runScenario4(): Promise<boolean> {
  const lab = createLab({ label: "s4", model: { mode: "recorded", script: loadScript(SCRIPT) }, engine: { workerDelayMs: 30 } });
  const checkpointer = openCheckpointer("memory");
  try {
    const agent = buildAgent({ model: lab.model, tools: lab.tools, checkpointer: checkpointer.saver, meter: lab.meter });
    const config = threadConfig(THREAD);

    heading("turn one — create, delegate, subscribe");
    const first = await drive(agent, { messages: [new HumanMessage("Get someone to draft the release notes for 0.4, and tell me when it lands.")] }, config);
    console.log(`approvals asked for: ${first.approvals.length} (${first.approvals.map((one) => `${one.request.tool}→${one.decision}`).join(", ")})`);
    console.log(`answer: ${finalText(first.state)}`);
    console.log(`sessions created: ${lab.engine.counts.create} · sends: ${lab.engine.counts.sendsAccepted} · subscriptions: ${lab.engine.subscriptions("agent_builtin").length}`);

    heading("the worker runs, and the wake comes back as a turn on the Agent's thread");
    await lab.engine.drain();
    const wakes = lab.engine.wakes;
    console.log(`wakes delivered: ${wakes.length}${wakes[0] ? ` → ${wakes[0].kind} on ${wakes[0].targetSessionId}` : ""}`);
    if (wakes.length === 0) {
      verdict("scenario 4", false, ["no wake was delivered"]);
      return false;
    }

    const notice =
      `[wake] ${wakes[0].kind} on session ${wakes[0].targetSessionId} (run ${wakes[0].runId}). ` +
      "Read what it did and report back to the person.";
    const second = await drive(agent, { messages: [new HumanMessage(notice)] }, config);
    const answer = finalText(second.state);
    console.log(`answer: ${answer}`);
    lab.meter.print();

    const workerTurn = lab.engine.turns(wakes[0].targetSessionId)[0];
    const passed =
      lab.engine.counts.create === 1 &&
      lab.engine.counts.sendsAccepted === 1 &&
      wakes.length === 1 &&
      wakes[0].kind === "turn_completed" &&
      workerTurn?.state === "completed" &&
      answer.toLowerCase().includes("release notes");

    verdict("scenario 4 — delegation round trip", passed, [
      `one create, one send, one subscription, one wake, one report`,
      `the wake ran as a second turn on the SAME thread and saw the first turn's history`,
      `approvals: ${first.approvals.length} asked, all accepted`,
    ]);
    return passed;
  } finally {
    checkpointer.close();
    lab.close();
  }
}

if (import.meta.main) await runScenario4();
