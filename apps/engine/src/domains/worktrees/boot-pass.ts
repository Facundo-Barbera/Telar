import { isShelved, settlingActivityOf, type Session, type SettlingOptions } from "@telar/engine-client";
import { eachBounded, existsWithin, type VolumeGate } from "../../platform/fs/volume-gate";

const LOCK_CONCURRENCY = 4;

export type LiveCheckout = { sessionId: string; projectId: string; path: string };

/** The checkouts on the rail: not archived, settled, snoozed or released. History never reaches the boot passes. */
export function liveCheckouts(sessions: readonly Session[], at: SettlingOptions): LiveCheckout[] {
  return sessions.flatMap((session) => {
    if (session.state === "archived" || session.workspace.mode !== "worktree" || session.workspace.released || !session.projectId) return [];
    const shelvable = { ...session, archived: false, draft: session.draft !== undefined };
    if (isShelved(shelvable, settlingActivityOf(session), at)) return [];
    return [{ sessionId: session.id, projectId: session.projectId, path: session.workspace.path }];
  });
}

/** Locks each checkout that is there, a few at a time and awaited; returns the sessions it locked. */
export async function lockCheckouts(
  checkouts: readonly LiveCheckout[],
  gate: VolumeGate,
  lock: (checkout: LiveCheckout) => Promise<unknown>,
): Promise<string[]> {
  await gate.admit(checkouts.map((checkout) => checkout.path));
  const locked: string[] = [];
  await eachBounded(checkouts, LOCK_CONCURRENCY, async (checkout) => {
    if (!(await existsWithin(gate, checkout.path))) return;
    await lock(checkout);
    locked.push(checkout.sessionId);
  });
  return locked;
}
