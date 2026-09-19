/**
 * SCENARIO 3 — AN APPROVAL SURVIVES THE PROCESS GOING AWAY.
 *
 * The gate is on `sessions_send` with `intent: task` — the call that puts
 * another session to work, and the one a person would want to have agreed to.
 * The Agent asks; the process exits with the question unanswered; a NEW process
 * finds the question still parked, with the arguments it was about, answers it,
 * and the send happens exactly once.
 *
 * ── WHY THE PARKED PAYLOAD MATTERS AS MUCH AS THE PARK ──────────────────────
 * A gate that survives a restart but forgets WHICH call it was about is a gate
 * that asks the person to approve a mystery. The child asserts it can read the
 * tool name and the arguments out of the checkpoint before it decides.
 *
 * ── THE FIXTURE IS PER PROCESS, AND THAT IS THE POINT ───────────────────────
 * Each process builds its own fixture engine, so "the parent sent nothing and
 * the child sent once" is measured on two separate counters. The worker session
 * is seeded identically in both (ids are deterministic), which is what the real
 * thing has for free: the engine outlives both processes.
 *
 * Run: `bun run scenario:3`
 */
import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { createLab } from "../harness/lab";
import { loadScript } from "../harness/recordings";
import { openCheckpointer } from "../harness/checkpointer";
import { buildAgent, finalText, threadConfig, type ApprovalRequest } from "../variants/langgraph";
import { parkedInterrupts } from "../harness/drive";
import { emitChildResult, flag, freshThreadFile, heading, readChildResult, scriptPath, spawnResume, verdict } from "./support";

const SCRIPT = "3-approval-restart";
const THREAD = "agent-thread-3";
const ASK = "Ask Nightly triage (ses_1) to run the sweep and report back.";

type ChildResult = {
  parkedTool: string;
  parkedArgs: Record<string, unknown>;
  answer: string;
  sendCalls: number;
  sendsAccepted: number;
  workerRuns: number;
};

function seed(lab: ReturnType<typeof createLab>): void {
  lab.engine.createSession({ projectId: "prj_lab", title: "Nightly triage", envMode: "worktree" });
}

async function resumeInThisProcess(file: string, threadId: string): Promise<ChildResult> {
  const lab = createLab({ label: "s3-resume", model: { mode: "recorded", script: loadScript(SCRIPT) } });
  const checkpointer = openCheckpointer("sqlite", file);
  try {
    seed(lab);
    const agent = buildAgent({ model: lab.model, tools: lab.tools, checkpointer: checkpointer.saver, meter: lab.meter });
    const config = threadConfig(threadId);

    const parked = await parkedInterrupts(agent, config);
    if (parked.length !== 1) throw new Error(`expected exactly one parked approval, found ${parked.length}`);
    const request = parked[0];

    const state = await agent.graph.invoke(new Command({ resume: "accept" }) as never, {
      ...config,
      recursionLimit: agent.recursionLimit,
    } as never);
    await lab.engine.drain();

    return {
      parkedTool: request.tool,
      parkedArgs: request.args,
      answer: finalText(state),
      sendCalls: lab.engine.counts.sendCalls,
      sendsAccepted: lab.engine.counts.sendsAccepted,
      workerRuns: lab.engine.counts.workerRuns,
    };
  } finally {
    checkpointer.close();
    lab.close();
  }
}

export async function runScenario3(): Promise<boolean> {
  const file = freshThreadFile(SCRIPT);

  heading("first process — the Agent asks, and nothing is sent");
  const lab = createLab({ label: "s3", model: { mode: "recorded", script: loadScript(SCRIPT) } });
  const checkpointer = openCheckpointer("sqlite", file);
  let parkedInParent: ApprovalRequest | undefined;
  let parentSendCalls = 0;
  try {
    seed(lab);
    const agent = buildAgent({ model: lab.model, tools: lab.tools, checkpointer: checkpointer.saver, meter: lab.meter });
    const config = threadConfig(THREAD);
    await agent.graph.invoke({ messages: [new HumanMessage(ASK)] }, { ...config, recursionLimit: agent.recursionLimit } as never);
    const parked = await parkedInterrupts(agent, config);
    parkedInParent = parked[0];
    parentSendCalls = lab.engine.counts.sendCalls;
    console.log(`parked approvals: ${parked.length}`);
    if (parkedInParent) console.log(`  → ${parkedInParent.tool} ${JSON.stringify(parkedInParent.args)}`);
    console.log(`sends the fixture saw in this process: ${parentSendCalls}`);
    lab.meter.print();
  } finally {
    checkpointer.close();
    lab.close();
  }

  heading("second process — the approval is still there, and is answered");
  const child = await spawnResume(scriptPath(import.meta.url), ["--resume", THREAD, "--file", file]);
  if (child.code !== 0) {
    console.log(child.stdout);
    console.error(child.stderr);
    verdict("scenario 3", false, ["the resuming child process exited non-zero"]);
    return false;
  }
  const resumed = readChildResult<ChildResult>(child);
  console.log(`child found the approval parked on: ${resumed.parkedTool} ${JSON.stringify(resumed.parkedArgs)}`);
  console.log(`child's answer: ${resumed.answer}`);
  console.log(`sends the fixture saw in the child: ${resumed.sendCalls} (worker runs ${resumed.workerRuns})`);

  const passed =
    parentSendCalls === 0 &&
    parkedInParent?.tool === "sessions_send" &&
    resumed.parkedTool === "sessions_send" &&
    resumed.parkedArgs.intent === "task" &&
    resumed.parkedArgs.sessionId === "ses_1" &&
    resumed.sendCalls === 1 &&
    resumed.sendsAccepted === 1 &&
    resumed.answer.length > 0;

  verdict("scenario 3 — permission interrupt survives restart", passed, [
    `parent: interrupt parked before any effect, ${parentSendCalls} sends`,
    `child: read the parked call's own arguments out of the checkpoint, then sent exactly ${resumed.sendCalls}`,
  ]);
  return passed;
}

if (import.meta.main) {
  const resume = flag("resume");
  if (resume !== undefined) {
    const file = flag("file");
    if (!file) throw new Error("--resume needs --file");
    emitChildResult(await resumeInThisProcess(file, resume));
  } else {
    await runScenario3();
  }
}
