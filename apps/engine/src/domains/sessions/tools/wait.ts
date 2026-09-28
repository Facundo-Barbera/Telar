import { z } from "zod";
import type { CohortMember } from "@telar/engine-client";
import { DELEGATION_WAIT_MAX_SECONDS, failure } from "../../agent-tools";
import type { SessionsCapability } from "./shared";

export const WAIT = z
  .number()
  .int()
  .min(1)
  .max(DELEGATION_WAIT_MAX_SECONDS)
  .optional()
  .describe(`Seconds to wait for its result, at most ${DELEGATION_WAIT_MAX_SECONDS}. A timeout cancels nothing: you are subscribed instead. Omit for several tasks at once.`);

export type Delegation =
  | { done: true; member: CohortMember }
  | { blocked: true; cohortId: string }
  | { timedOut: true; cohortId: string }
  | { delivered: true }
  | { unsupported: string };

type Clock = { now?: () => number; pause?: (ms: number) => Promise<void> };

const POLL_MS = 1_000;
const pauseFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitForDelegation(capability: SessionsCapability, sessionId: string, seconds: number, clock: Clock = {}): Promise<Delegation> {
  const self = capability.self;
  if (!self || !capability.subscribeCohort || !capability.cohorts) return { unsupported: "this session cannot wait on another here" };
  const now = clock.now ?? Date.now;
  const pause = clock.pause ?? pauseFor;
  const deadline = now() + seconds * 1_000;
  let cohortId: string;
  try {
    cohortId = (await capability.subscribeCohort(self.sessionId, { sessionIds: [sessionId] })).id;
  } catch (error) {
    return { unsupported: failure(error) };
  }
  for (;;) {
    const cohort = (await capability.cohorts(self.sessionId)).find((each) => each.id === cohortId);
    if (!cohort) return { delivered: true };
    const member = cohort.members.find((each) => each.sessionId === sessionId);
    if (member?.outcome) {
      await capability.unsubscribe(cohortId, self.sessionId);
      return { done: true, member };
    }
    if (member?.blocked) return { blocked: true, cohortId };
    if (now() >= deadline) return { timedOut: true, cohortId };
    await pause(Math.min(POLL_MS, Math.max(0, deadline - now())));
  }
}

export function delegationAnswer(delegation: Delegation): Record<string, unknown> {
  if ("done" in delegation) {
    const { member } = delegation;
    return {
      done: true,
      outcome: member.outcome,
      ...(member.firstLine ? { firstLine: member.firstLine } : {}),
      ...(member.excerpt ? { excerpt: member.excerpt } : {}),
      ...(member.chars ? { chars: member.chars } : {}),
      ...(member.fetch ? { fetch: member.fetch } : {}),
      note: "Done. Its answer is above; nothing else will wake you for it. Read the rest with sessions_read(fetch) if chars exceeds the excerpt.",
    };
  }
  if ("blocked" in delegation) {
    return { blocked: true, cohortId: delegation.cohortId, note: "It sent a blocker. Read it, answer it, then end your turn: you stay subscribed until it is done." };
  }
  if ("timedOut" in delegation) {
    return { timedOut: true, cohortId: delegation.cohortId, note: "Still working; nothing was cancelled. You are subscribed and will be woken when it is done. End your turn now." };
  }
  if ("delivered" in delegation) return { done: true, note: "Done; its result reached you as a notification." };
  return { waited: false, note: `Did not wait: ${delegation.unsupported}. Subscribe and end your turn.` };
}
