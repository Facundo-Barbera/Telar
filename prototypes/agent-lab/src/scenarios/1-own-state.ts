/**
 * SCENARIO 1 — THE AGENT HAS ITS OWN STATE, AND NO TELAR SESSION.
 *
 * The product correction behind #528 is that Main must not be any designated
 * Telar session. So the question this scenario answers is narrow and
 * load-bearing: can the framework hold the Agent's whole conversation itself,
 * with the engine's sessions appearing only as things the Agent OPERATES ON?
 *
 * WHAT IS ASSERTED
 *   · The thread is persisted by LangGraph's own durable checkpointer.
 *   · `sessions_create` is called ZERO times for the Agent itself. The fixture
 *     counts creations; the Agent's own existence costs none.
 *   · A FRESH PROCESS, given only the thread id and the file, resumes the
 *     conversation with its history and answers from it.
 *   · MemorySaver, run the same way, has nothing — reported rather than
 *     asserted away.
 *
 * Run: `bun run scenario:1`
 */
import { HumanMessage } from "@langchain/core/messages";
import { createLab } from "../harness/lab";
import { loadScript } from "../harness/recordings";
import { openCheckpointer } from "../harness/checkpointer";
import { buildAgent, finalText, threadConfig } from "../variants/langgraph";
import { emitChildResult, flag, freshThreadFile, heading, readChildResult, scriptPath, spawnResume, verdict } from "./support";

const SCRIPT = "1-own-state";
const THREAD = "agent-thread-1";

type ResumeResult = {
  messageCount: number;
  firstHuman: string;
  answer: string;
  createCalls: number;
};

/** The second half, in a process that has never seen the first. */
async function resumeInThisProcess(file: string, threadId: string): Promise<ResumeResult> {
  const lab = createLab({ label: "s1-resume", model: { mode: "recorded", script: loadScript(SCRIPT) } });
  const checkpointer = openCheckpointer("sqlite", file);
  try {
    const agent = buildAgent({ model: lab.model, tools: lab.tools, checkpointer: checkpointer.saver, meter: lab.meter });
    const config = threadConfig(threadId);

    const before = await agent.graph.getState(config);
    const priorMessages = before.values.messages ?? [];
    const firstHuman = priorMessages.find((one: { getType(): string }) => one.getType() === "human");

    const after = await agent.graph.invoke({ messages: [new HumanMessage("What did I ask you first?")] }, config);
    return {
      messageCount: priorMessages.length,
      firstHuman: firstHuman ? String(firstHuman.content) : "",
      answer: finalText(after),
      createCalls: lab.engine.counts.create,
    };
  } finally {
    checkpointer.close();
    lab.close();
  }
}

export async function runScenario1(): Promise<boolean> {
  const file = freshThreadFile(SCRIPT);

  heading("first process — the Agent answers, and its thread is written to sqlite");
  const lab = createLab({ label: "s1", model: { mode: "recorded", script: loadScript(SCRIPT) } });
  const checkpointer = openCheckpointer("sqlite", file);
  let firstAnswer = "";
  let createCallsFirstHalf = 0;
  try {
    lab.engine.createSession({ projectId: "prj_lab", title: "Nightly triage", envMode: "worktree" });
    const seeded = lab.engine.counts.create;

    const agent = buildAgent({ model: lab.model, tools: lab.tools, checkpointer: checkpointer.saver, meter: lab.meter });
    const state = await agent.graph.invoke({ messages: [new HumanMessage("Which sessions are live on this engine?")] }, threadConfig(THREAD));
    firstAnswer = finalText(state);
    createCallsFirstHalf = lab.engine.counts.create - seeded;

    console.log(`thread file: ${checkpointer.location}`);
    console.log(`answer: ${firstAnswer}`);
    console.log(`sessions created FOR THE AGENT ITSELF: ${createCallsFirstHalf}`);
    lab.meter.print();
  } finally {
    checkpointer.close();
    lab.close();
  }

  heading("MemorySaver, for the comparison the issue asks for");
  const memoryLab = createLab({ label: "s1-memory", model: { mode: "recorded", script: loadScript(SCRIPT) } });
  let memorySurvived = true;
  try {
    const first = openCheckpointer("memory");
    const agent = buildAgent({ model: memoryLab.model, tools: memoryLab.tools, checkpointer: first.saver, meter: memoryLab.meter });
    await agent.graph.invoke({ messages: [new HumanMessage("Which sessions are live on this engine?")] }, threadConfig(THREAD));
    // A new process gets a new MemorySaver, and this is what that looks like.
    const second = openCheckpointer("memory");
    const reopened = buildAgent({ model: memoryLab.model, tools: memoryLab.tools, checkpointer: second.saver, meter: memoryLab.meter });
    const state = await reopened.graph.getState(threadConfig(THREAD));
    memorySurvived = (state.values.messages ?? []).length > 0;
    console.log(`MemorySaver, same thread id, fresh saver: ${(state.values.messages ?? []).length} messages`);
  } finally {
    memoryLab.close();
  }

  heading("second process — resume by thread id alone");
  const child = await spawnResume(scriptPath(import.meta.url), ["--resume", THREAD, "--file", file]);
  if (child.code !== 0) {
    console.log(child.stdout);
    console.error(child.stderr);
    verdict("scenario 1", false, ["the resuming child process exited non-zero"]);
    return false;
  }
  const resumed = readChildResult<ResumeResult>(child);
  console.log(`child saw ${resumed.messageCount} messages already on the thread`);
  console.log(`child read the first human message as: ${JSON.stringify(resumed.firstHuman)}`);
  console.log(`child's answer: ${resumed.answer}`);

  const passed =
    createCallsFirstHalf === 0 &&
    resumed.messageCount === 4 &&
    resumed.firstHuman === "Which sessions are live on this engine?" &&
    resumed.answer.includes("Nightly triage") &&
    resumed.createCalls === 0 &&
    memorySurvived === false;

  verdict("scenario 1 — own state, no Telar session", passed, [
    `the Agent's thread cost ${createCallsFirstHalf} sessions_create calls`,
    `sqlite: a fresh process resumed ${resumed.messageCount} messages by thread id alone`,
    `MemorySaver: a fresh saver on the same thread id found 0 messages`,
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
    await runScenario1();
  }
}
