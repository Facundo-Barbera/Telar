/**
 * Probe 1 — what deepagents injects by default, on Bun.
 * Constructs an agent with a fake model, runs one turn, and reports:
 *  - the tools bound to the model (the DEFAULT injected set)
 *  - the system prompt actually sent (length + text)
 *  - the middleware stack
 *  - the state keys after the turn (what backs the virtual filesystem)
 */
import { createDeepAgent, BASE_AGENT_PROMPT, TASK_SYSTEM_PROMPT, EXECUTION_SYSTEM_PROMPT, DEFAULT_SUBAGENT_PROMPT } from "deepagents";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";

type Captured = { tools: any[]; messages: any[] };
const captured: Captured = { tools: [], messages: [] };

class FakeModel extends BaseChatModel {
  boundTools: any[] = [];
  _llmType() { return "fake"; }
  bindTools(tools: any[]) {
    const next = new FakeModel({});
    next.boundTools = tools;
    captured.tools = tools;
    return next as any;
  }
  async _generate(messages: any[]) {
    captured.messages = messages;
    return { generations: [{ text: "ok", message: new AIMessage("ok") }] };
  }
}

const agent = await createDeepAgent({ model: new FakeModel({}) as any });

console.log("=== GRAPH NODES ===");
console.log(Object.keys((agent as any).nodes ?? {}).join(", "));

const res: any = await agent.invoke({ messages: [{ role: "user", content: "hi" }] });

console.log("\n=== DEFAULT TOOLS BOUND TO MODEL ===");
for (const t of captured.tools) {
  const name = t.name ?? t.function?.name ?? "(unnamed)";
  const desc = (t.description ?? t.function?.description ?? "").replace(/\s+/g, " ").slice(0, 160);
  console.log(`- ${name}: ${desc}`);
}
console.log(`TOOL COUNT: ${captured.tools.length}`);

console.log("\n=== SYSTEM PROMPT ACTUALLY SENT ===");
const sys = captured.messages.find((m: any) => m._getType?.() === "system" || m.role === "system");
const sysText = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content);
console.log(`PRESENT: ${Boolean(sys)}`);
console.log(`LENGTH: ${sysText ? sysText.length : 0} chars`);
console.log("---8<---");
console.log(sysText ?? "(none)");
console.log("--->8---");

console.log("\n=== EXPORTED PROMPT CONSTANTS (lengths) ===");
for (const [k, v] of Object.entries({ BASE_AGENT_PROMPT, TASK_SYSTEM_PROMPT, EXECUTION_SYSTEM_PROMPT, DEFAULT_SUBAGENT_PROMPT })) {
  console.log(`${k}: ${typeof v === "string" ? v.length : typeof v} chars`);
}

console.log("\n=== RESULT STATE KEYS ===");
console.log(Object.keys(res).join(", "));
console.log("files value:", JSON.stringify(res.files));
console.log("todos value:", JSON.stringify(res.todos));
