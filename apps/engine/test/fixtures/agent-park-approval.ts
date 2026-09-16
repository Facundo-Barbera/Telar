/**
 * PARK AN APPROVAL AND DIE — the first half of the restart test (#531).
 *
 * A REAL CHILD PROCESS, not a second object in the same heap. That distinction
 * is the whole claim: `MemorySaver` survives anything you build beside it and
 * nothing across a process boundary, so a "restart" that stayed in one process
 * would prove the checkpointer's durability by never testing it. The lab made
 * the same choice for the same reason.
 *
 * Run as `bun run test/fixtures/agent-park-approval.ts <engineRoot>`. It prints
 * one line of JSON — the request id and run id it parked — and exits 0. The
 * parent then opens a FRESH runtime over the same directory and expects to find
 * that exact approval waiting.
 */
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { SocketTool } from "../../src/mcp-socket";
import { AgentRuntime } from "../../src/agent/runtime";

/** One turn's worth of model: ask to send a task, which is gated. */
class AsksToDelegate extends BaseChatModel {
  _llmType(): string {
    return "asks-to-delegate";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    const message = new AIMessage({
      content: "",
      tool_calls: [{ id: "call_restart", name: "sessions_send", args: { sessionId: "session_peer", intent: "task", input: "do the thing" }, type: "tool_call" }],
    });
    return { generations: [{ text: "", message }] };
  }
}

/** The wall this child holds. It must never be REACHED — the approval parks
 *  first — and it throws if it is, so a regression fails loudly here rather
 *  than quietly sending something in the parent's assertion. */
const wall: SocketTool[] = [
  {
    name: "sessions_send",
    description: "send",
    shape: {},
    run: async () => {
      throw new Error("the child reached the wall: the approval did not park before the effect");
    },
  },
];

const engineRoot = process.argv[2];
if (!engineRoot) throw new Error("usage: agent-park-approval.ts <engineRoot>");

const agent = new AgentRuntime({ engineRoot, tools: () => wall, model: () => new AsksToDelegate({}) });
agent.patch({ enabled: true });
agent.submit({ text: "delegate it" });

const deadline = Date.now() + 15_000;
while (Date.now() < deadline && !agent.state().request) await Bun.sleep(10);

const request = agent.state().request;
if (!request) throw new Error("the child never parked an approval");
// The handle is closed BEFORE the process exits, so the parent opens a database
// nothing is holding — which is what a real restart looks like.
agent.close();
process.stdout.write(`${JSON.stringify({ id: request.id, runId: request.runId, tool: request.tool, args: request.args })}\n`);
