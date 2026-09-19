/**
 * The variant's own claims — the ones REPORT.md makes in prose and would
 * otherwise be asserting by assertion.
 */
import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { createLab } from "../src/harness/lab";
import { loadScript } from "../src/harness/recordings";
import { openCheckpointer } from "../src/harness/checkpointer";
import { buildAgent, defaultApprovalPolicy, defaultIdempotencyPolicy, effectKey, threadConfig } from "../src/variants/langgraph";
import { parkedInterrupts } from "../src/harness/drive";

const script = () => loadScript("3-approval-restart");

describe("approval policy", () => {
  test("gates sessions_send with intent task, and nothing else", () => {
    expect(defaultApprovalPolicy({ name: "sessions_send", args: { intent: "task" }, id: "1", type: "tool_call" })).toBe(true);
    expect(defaultApprovalPolicy({ name: "sessions_send", args: { intent: "report" }, id: "1", type: "tool_call" })).toBe(false);
    expect(defaultApprovalPolicy({ name: "sessions_list", args: {}, id: "1", type: "tool_call" })).toBe(false);
  });

  test("only the two tools that land anything are ledgered", () => {
    expect(defaultIdempotencyPolicy({ name: "sessions_send", args: { a: 1 }, id: "1", type: "tool_call" })).toBeString();
    expect(defaultIdempotencyPolicy({ name: "sessions_create", args: { a: 1 }, id: "1", type: "tool_call" })).toBeString();
    expect(defaultIdempotencyPolicy({ name: "sessions_read", args: { a: 1 }, id: "1", type: "tool_call" })).toBeUndefined();
  });

  test("the effect key is stable for the same arguments and different for others", () => {
    expect(effectKey("sessions_send", { b: 2, a: 1 })).toBe(effectKey("sessions_send", { b: 2, a: 1 }));
    expect(effectKey("sessions_send", { a: 1 })).not.toBe(effectKey("sessions_send", { a: 2 }));
  });
});

describe("the two approval modes the issue asks about", () => {
  test('interrupt() parks WITH the call it is about', async () => {
    const lab = createLab({ label: "v-interrupt", model: { mode: "recorded", script: script() } });
    const checkpointer = openCheckpointer("memory");
    try {
      lab.engine.createSession({ projectId: "prj_lab", title: "Worker", envMode: "worktree" });
      const agent = buildAgent({ model: lab.model, tools: lab.tools, checkpointer: checkpointer.saver, meter: lab.meter });
      const config = threadConfig("v1");
      await agent.graph.invoke({ messages: [new HumanMessage("delegate it")] }, { ...config, recursionLimit: agent.recursionLimit } as never);

      const parked = await parkedInterrupts(agent, config);
      expect(parked).toHaveLength(1);
      expect(parked[0].tool).toBe("sessions_send");
      expect(parked[0].args.intent).toBe("task");
      expect(lab.engine.counts.sendCalls).toBe(0);
    } finally {
      checkpointer.close();
      lab.close();
    }
  });

  test("interruptBefore stops at the node and carries NO payload", async () => {
    const lab = createLab({ label: "v-before", model: { mode: "recorded", script: script() } });
    const checkpointer = openCheckpointer("memory");
    try {
      lab.engine.createSession({ projectId: "prj_lab", title: "Worker", envMode: "worktree" });
      const agent = buildAgent({
        model: lab.model,
        tools: lab.tools,
        checkpointer: checkpointer.saver,
        meter: lab.meter,
        approvalMode: "interruptBefore",
        // The static gate is node-level, so the dynamic gate is off: with both
        // on, the run would stop twice for one call.
        approvalPolicy: () => false,
      });
      const config = threadConfig("v2");
      await agent.graph.invoke({ messages: [new HumanMessage("delegate it")] }, { ...config, recursionLimit: agent.recursionLimit } as never);

      const state = await agent.graph.getState(config as never);
      expect(state.next).toEqual(["tools"]);
      expect(await parkedInterrupts(agent, config)).toHaveLength(0);
      expect(lab.engine.counts.sendCalls).toBe(0);

      // Resumed by invoking with null — there is no decision to carry.
      await agent.graph.invoke(null as never, { ...config, recursionLimit: agent.recursionLimit } as never);
      await lab.engine.drain();
      expect(lab.engine.counts.sendCalls).toBe(1);
    } finally {
      checkpointer.close();
      lab.close();
    }
  });
});
