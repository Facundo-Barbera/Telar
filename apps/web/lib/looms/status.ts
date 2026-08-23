import { loomState, type Loom } from "./store";

/**
 * WHAT A THREAD IS DOING, from the engine's own derived `activity` — never
 * from the task count. Task records survive an engine restart; activity is
 * re-derived from the live queue on every read, so a session whose worker died
 * honestly reads "idle" instead of "working" forever. That forever-working
 * thread was a real bug: the engine stopped mid-loom and the room kept
 * claiming all four threads were busy.
 */
export function threadStatus(activity: string | undefined, state: string): string {
  if (activity === "working" || activity === "queued") return "working";
  if (activity === "blocked") return "waiting on you";
  return state === "active" ? "idle" : state;
}

export type LoomDisplayState = "working" | "idle" | "verifying" | "ready" | "accepted";

/** The lifecycle says "working" until verification starts — but a loom whose
 *  every thread has gone quiet is NOT working, and a chip that says so is a
 *  lie. Display drops to "idle" when nothing runs; the stored lifecycle is
 *  untouched. */
export function displayState(loom: Loom, statuses: string[]): LoomDisplayState {
  const lifecycle = loomState(loom);
  if (lifecycle === "working" && !statuses.some((s) => s === "working" || s === "waiting on you")) return "idle";
  return lifecycle;
}
