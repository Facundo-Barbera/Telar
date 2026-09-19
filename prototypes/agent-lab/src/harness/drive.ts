/**
 * DRIVING A THREAD THAT CAN STOP AND ASK.
 *
 * An agent with an approval gate does not run to completion: it runs to an
 * INTERRUPT, and something outside it decides. In the product that something is
 * a person looking at the cockpit. In a scenario it is `decide`, which is what
 * lets scenarios 4, 6 and 7 exercise the gate without each of them rewriting
 * the resume loop.
 *
 * ── THE LOOP IS BOUNDED ─────────────────────────────────────────────────────
 * A decider that always declines and a model that always retries is an infinite
 * loop, and a lab that can hang is a lab nobody runs. `maxApprovals` ends it
 * with a thrown error naming the tool that kept asking.
 */
import { Command } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { ApprovalDecision, ApprovalRequest, BuiltAgent } from "../variants/langgraph";

export type DriveResult = {
  state: { messages: BaseMessage[]; effects: Record<string, string> };
  /** Every approval the run asked for, in order, with what was decided. */
  approvals: Array<{ request: ApprovalRequest; decision: ApprovalDecision }>;
};

/** The interrupts parked on a thread right now, as their payloads. */
export async function parkedInterrupts(agent: BuiltAgent, config: Record<string, unknown>): Promise<ApprovalRequest[]> {
  const state = await agent.graph.getState(config as never);
  const found: ApprovalRequest[] = [];
  for (const task of state.tasks ?? []) {
    for (const one of task.interrupts ?? []) found.push(one.value as ApprovalRequest);
  }
  return found;
}

export async function drive(
  agent: BuiltAgent,
  input: unknown,
  config: Record<string, unknown>,
  decide: (request: ApprovalRequest) => ApprovalDecision = () => "accept",
  maxApprovals = 8,
): Promise<DriveResult> {
  const approvals: DriveResult["approvals"] = [];
  const runConfig = { ...config, recursionLimit: agent.recursionLimit };
  let next: unknown = input;
  for (let attempt = 0; attempt <= maxApprovals; attempt += 1) {
    const state = (await agent.graph.invoke(next as never, runConfig as never)) as DriveResult["state"];
    const pending = await parkedInterrupts(agent, config);
    if (pending.length === 0) return { state, approvals };
    const request = pending[0];
    const decision = decide(request);
    approvals.push({ request, decision });
    next = new Command({ resume: decision });
  }
  throw new Error(`the thread asked for approval more than ${maxApprovals} times; the decider and the model disagree`);
}
