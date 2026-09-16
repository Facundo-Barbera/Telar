/**
 * Probe 3 — runtime behaviour that decides the win/loss table:
 *  (a) what backs the virtual filesystem, and whether it is checkpointed
 *  (b) SqliteSaver on Bun (durable, not MemorySaver)
 *  (c) interruptOn: does a tool approval interrupt, and does it survive a
 *      fresh agent object reading the same sqlite file (restart-shaped)
 *  (d) the subagent mechanism (what `task` actually does)
 */
import { createDeepAgent } from "deepagents";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { BunSqliteSaver as SqliteSaver } from "./bun-sqlite-saver.ts";
import { Command } from "@langchain/langgraph";
import { z } from "zod";
import { rmSync, existsSync, statSync } from "node:fs";

const DB = ".probe-runtime.sqlite";
rmSync(DB, { force: true });

let sends = 0;
const sessionsSend = tool(
  async ({ input }: { input: string }) => { sends += 1; return `sent: ${input}`; },
  { name: "sessions_send", description: "Send a task to a session.", schema: z.object({ input: z.string() }) },
);

/** Scripted model: emits a scripted tool call the first time, then plain text. */
function scripted(script: Array<{ name: string; args: any } | string>) {
  let i = 0;
  class M extends BaseChatModel {
    _llmType() { return "fake"; }
    bindTools() { return new M({}) as any; }
    async _generate() {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      if (typeof step === "string") {
        return { generations: [{ text: step, message: new AIMessage(step) }] };
      }
      const msg = new AIMessage({
        content: "",
        tool_calls: [{ name: step.name, args: step.args, id: `call_${i}` }],
      });
      return { generations: [{ text: "", message: msg }] };
    }
  }
  return new M({});
}

console.log("=== (b) SqliteSaver on Bun ===");
const saver = SqliteSaver.fromConnString(DB);
console.log("constructed:", saver.constructor.name);

console.log("\n=== (a) virtual filesystem: write_file with no cwd ===");
{
  const agent = await createDeepAgent({
    model: scripted([{ name: "write_file", args: { file_path: "/notes.md", content: "hello" } }, "done"]),
    checkpointer: saver,
  });
  const cfg = { configurable: { thread_id: "fs-1" } };
  const res: any = await agent.invoke({ messages: [{ role: "user", content: "write a note" }] }, cfg);
  console.log("state keys:", Object.keys(res).join(", "));
  console.log("files:", JSON.stringify(res.files));
  console.log("real /notes.md on disk?", existsSync("/notes.md"));
  const snap = await agent.getState(cfg);
  console.log("checkpointed files key present:", "files" in (snap.values as any));
}

console.log("\n=== (c) interruptOn + restart across a fresh agent object ===");
{
  const cfg = { configurable: { thread_id: "approve-1" } };
  const agent1 = await createDeepAgent({
    model: scripted([{ name: "sessions_send", args: { input: "do the thing" } }, "reported"]),
    tools: [sessionsSend],
    checkpointer: SqliteSaver.fromConnString(DB),
    interruptOn: { sessions_send: true },
  });
  const r1: any = await agent1.invoke({ messages: [{ role: "user", content: "delegate" }] }, cfg);
  console.log("__interrupt__ present:", Boolean(r1.__interrupt__));
  console.log("interrupt payload:", JSON.stringify(r1.__interrupt__?.[0]?.value ?? r1.__interrupt__).slice(0, 300));
  console.log("tool ran before approval? sends =", sends);

  // Simulate process restart: brand new agent object + new saver on the same file.
  const agent2 = await createDeepAgent({
    model: scripted([{ name: "sessions_send", args: { input: "do the thing" } }, "reported"]),
    tools: [sessionsSend],
    checkpointer: SqliteSaver.fromConnString(DB),
    interruptOn: { sessions_send: true },
  });
  const pending = await agent2.getState(cfg);
  console.log("resumed thread sees pending tasks:", JSON.stringify(pending.tasks?.map((t: any) => t.name)));
  const r2: any = await agent2.invoke(
    new Command({ resume: { decisions: [{ type: "approve" }] } }) as any,
    cfg,
  );
  const last = r2.messages?.[r2.messages.length - 1];
  console.log("after resume, sends =", sends);
  console.log("final message:", typeof last?.content === "string" ? last.content.slice(0, 80) : JSON.stringify(last?.content).slice(0, 80));
}

console.log("\n=== durability ===");
console.log("sqlite file exists:", existsSync(DB), existsSync(DB) ? `${statSync(DB).size} bytes` : "");
