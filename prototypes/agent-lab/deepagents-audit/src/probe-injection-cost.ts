/**
 * Probe 2 — the measurable per-turn cost of what deepagents injects,
 * and how far the injection can be narrowed.
 */
import { createDeepAgent, createFilesystemMiddleware, createSubAgentMiddleware } from "deepagents";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getEncoding } from "js-tiktoken";

const enc = getEncoding("cl100k_base");
const count = (s: string) => enc.encode(s).length;

function capture() {
  const seen: { tools: any[]; messages: any[] } = { tools: [], messages: [] };
  class FakeModel extends BaseChatModel {
    _llmType() { return "fake"; }
    bindTools(tools: any[]) { seen.tools = tools; return new FakeModel({}) as any; }
    async _generate(messages: any[]) {
      seen.messages = messages;
      return { generations: [{ text: "ok", message: new AIMessage("ok") }] };
    }
  }
  return { seen, Model: FakeModel };
}

function schemaOf(t: any) {
  // What actually goes on the wire: name + description + JSON schema.
  const name = t.name ?? t.function?.name;
  const description = t.description ?? t.function?.description ?? "";
  let params: unknown = {};
  try {
    params = t.schema ? JSON.parse(JSON.stringify(t.schema)) : (t.function?.parameters ?? {});
  } catch { params = {}; }
  return { name, description, params };
}

async function measure(label: string, build: (Model: any) => Promise<any>) {
  const { seen, Model } = capture();
  const agent = await build(Model);
  await agent.invoke({ messages: [{ role: "user", content: "hi" }] });
  const sys = seen.messages.find((m: any) => m._getType?.() === "system");
  const sysText = typeof sys?.content === "string" ? sys.content : "";
  const specs = seen.tools.map(schemaOf);
  const perTool = specs.map((s) => {
    const blob = `${s.name}\n${s.description}\n${JSON.stringify(s.params)}`;
    return { name: s.name, descChars: s.description.length, tokens: count(blob) };
  });
  const toolTokens = perTool.reduce((a, b) => a + b.tokens, 0);
  console.log(`\n### ${label}`);
  console.log(`system prompt: ${sysText.length} chars / ${sysText ? count(sysText) : 0} tokens`);
  console.log(`tools: ${seen.tools.length}  total ${toolTokens} tokens`);
  for (const t of perTool) console.log(`  ${String(t.name).padEnd(12)} ${String(t.tokens).padStart(5)} tok  (${t.descChars} desc chars)`);
  return { toolTokens, sysTokens: sysText ? count(sysText) : 0, names: perTool.map((t) => t.name) };
}

const myTool = tool(async () => "x", {
  name: "sessions_list",
  description: "List sessions.",
  schema: z.object({ limit: z.number().optional() }),
});

const a = await measure("DEFAULT createDeepAgent (one custom tool)", async (Model) =>
  createDeepAgent({ model: new Model({}), tools: [myTool] }));

const b = await measure("NARROWED: filesystem tools -> [read_file], no subagents", async (Model) =>
  createDeepAgent({
    model: new Model({}),
    tools: [myTool],
    middleware: [
      createFilesystemMiddleware({ tools: ["read_file"] }),
      createSubAgentMiddleware({ subagents: [], generalPurposeAgent: false }),
    ] as any,
  }));

console.log("\n=== OVERHEAD vs a bare tool list ===");
const bare = count(`${myTool.name}\n${myTool.description}\n${JSON.stringify(JSON.parse(JSON.stringify(myTool.schema)))}`);
console.log(`bare custom tool alone: ${bare} tokens`);
console.log(`default injection adds: ${a.toolTokens - bare} tokens/turn (${a.names.join(", ")})`);
console.log(`narrowed injection adds: ${b.toolTokens - bare} tokens/turn (${b.names.join(", ")})`);
