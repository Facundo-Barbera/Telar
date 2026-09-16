/**
 * Probe 4 — the three headline "wins" #528 asks us to measure or mark
 * untested: subagents, summarisation/offload, and skills.
 *
 * Each is exercised against a scripted model so the mechanism, not the
 * model's judgement, is what shows up in the output.
 */
import { createDeepAgent, createSummarizationMiddleware, computeSummarizationDefaults } from "deepagents";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

type Step = { name: string; args: any } | string;

/** A model that plays a fixed script and records every message list it is handed. */
function scripted(script: Step[], seen?: { calls: any[][] }) {
  let i = 0;
  class M extends BaseChatModel {
    _llmType() { return "fake"; }
    bindTools() { const n = new M({}); (n as any)._script = script; return n as any; }
    async _generate(messages: any[]) {
      seen?.calls.push(messages);
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      if (typeof step === "string") return { generations: [{ text: step, message: new AIMessage(step) }] };
      return {
        generations: [{
          text: "",
          message: new AIMessage({ content: "", tool_calls: [{ name: step.name, args: step.args, id: `c${i}` }] }),
        }],
      };
    }
  }
  return new M({});
}

console.log("=== WIN 1: subagents — what `task` actually does ===");
{
  const seen = { calls: [] as any[][] };
  const agent = await createDeepAgent({
    model: scripted(
      [{ name: "task", args: { description: "count to three", subagent_type: "general-purpose" } }, "subagent said its piece"],
      seen,
    ),
    subagents: [],
  });
  const res: any = await agent.invoke({ messages: [{ role: "user", content: "delegate something" }] });
  const toolMsg = res.messages.find((m: any) => m._getType?.() === "tool");
  console.log("task tool returned:", JSON.stringify(toolMsg?.content).slice(0, 200));
  console.log("model invocations (parent + subagent share one model here):", seen.calls.length);
  // The subagent's own call is the one whose message list opens with the task
  // description rather than the parent's user turn.
  const subagentCall = seen.calls.find(
    (c) => !c.some((m: any) => typeof m.content === "string" && m.content.includes("delegate something")),
  );
  console.log("a call with a context free of the parent's turn exists:", Boolean(subagentCall));
  console.log("  its message count:", subagentCall?.length ?? 0);
  console.log("parent state keys after delegation:", Object.keys(res).join(", "));
  console.log("parent transcript length (subagent's turns are NOT spliced in):", res.messages.length);
}

console.log("\n=== WIN 2: summarisation / offload thresholds ===");
{
  // The defaults are model-derived: a model that advertises maxInputTokens gets
  // fraction-of-window triggers; anything else falls back to a flat token count.
  class WithProfile extends BaseChatModel {
    profile = { maxInputTokens: 200_000 };
    _llmType() { return "fake"; }
    async _generate() { return { generations: [{ text: "x", message: new AIMessage("x") }] }; }
  }
  class NoProfile extends BaseChatModel {
    _llmType() { return "fake"; }
    async _generate() { return { generations: [{ text: "x", message: new AIMessage("x") }] }; }
  }
  console.log("model advertising maxInputTokens:", JSON.stringify(computeSummarizationDefaults(new WithProfile({}) as any)));
  console.log("model without a profile:      ", JSON.stringify(computeSummarizationDefaults(new NoProfile({}) as any)));
  console.log("middleware present by default:", createSummarizationMiddleware({}).name);
}

console.log("\n=== WIN 2b: does summarisation destroy checkpointed history? ===");
{
  // The middleware stores a summarisation *event* and reconstructs the effective
  // message list, rather than issuing RemoveMessage(REMOVE_ALL_MESSAGES).
  // Consequence: the checkpoint keeps the full transcript.
  const seen = { calls: [] as any[][] };
  const agent = await createDeepAgent({ model: scripted(["ok"], seen) });
  const many = Array.from({ length: 12 }, (_, i) => new HumanMessage(`turn ${i}`));
  const res: any = await agent.invoke({ messages: many });
  console.log("messages handed back in state:", res.messages.length);
  console.log("messages the model was shown:", seen.calls[0]?.length ?? 0);
}

console.log("\n=== WIN 3: skills ===");
{
  // Skills are markdown files read out of the backend, so with the default
  // StateBackend they arrive in `files` — no real directory required.
  const seen = { calls: [] as any[][] };
  const agent = await createDeepAgent({ model: scripted(["read the skill"], seen), skills: ["/skills/"] });
  const res: any = await agent.invoke({
    messages: [{ role: "user", content: "what skills do you have?" }],
    files: {
      // NOTE: the docs' skills example uses the v1 FileData shape
      // (`content` as string[], no mimeType). That shape fails state
      // validation against the installed 1.13.4, which wants v2.
      "/skills/greet/SKILL.md": {
        content: ["---", "name: greet", "description: Say hello politely.", "---", "# Greet", "Say hello."].join("\n"),
        mimeType: "text/markdown",
        created_at: new Date().toISOString(),
        modified_at: new Date().toISOString(),
      },
    },
  });
  console.log("files still in state:", Object.keys(res.files ?? {}).join(", "));
  // The system prompt is assembled at model-call time, so read it off what the
  // model was actually handed — it is not stored in `res.messages`.
  const sent = seen.calls[0] ?? [];
  const sys = sent.find((m: any) => m._getType?.() === "system");
  const sysText = typeof sys?.content === "string" ? sys.content : "";
  console.log("system prompt length:", sysText.length, "chars");
  console.log("skill name surfaced into the system prompt:", sysText.includes("greet"));
  console.log("skill body inlined (vs name-only index):", sysText.includes("Say hello."));
}
