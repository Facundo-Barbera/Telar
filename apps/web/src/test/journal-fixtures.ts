import type { Item, Turn } from "@telar/engine-client";

export const turn: Turn = {
  runId: "run_1",
  sessionId: "s1",
  sequence: 1,
  input: "Please help",
  state: "running",
  acceptedAt: 1,
  updatedAt: 1,
};

export const item = (over: Partial<Item> & Pick<Item, "id" | "detail">): Item => ({
  runId: "run_1",
  sessionId: "s1",
  status: "inProgress",
  startedAt: 1,
  ...over,
});

export const envelope = { at: 1, sessionId: "s1", runId: "run_1" } as const;
