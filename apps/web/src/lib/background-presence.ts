/**
 * The banner's view always opens the Processes tab; a lone process task also opens
 * its row. A lone sub-agent lives on the Agents tab, so nothing opens for it.
 */
import { countsAsActivity, isBackgroundWork, type Task } from "@telar/engine-client";

type BannerTask = Pick<Task, "id" | "kind" | "backgrounded" | "state" | "ambient">;

/** The tasks the banner counts — the same predicates the cockpit uses. */
export function stillWorking<T extends BannerTask>(tasks: readonly T[]): T[] {
  return tasks.filter((task) => isBackgroundWork(task) && countsAsActivity(task));
}

/** The Processes row to open, or `undefined` to open none. */
export function processToReveal(tasks: readonly BannerTask[]): string | undefined {
  const working = stillWorking(tasks);
  const only = working.length === 1 ? working[0] : undefined;
  return only?.kind === "background" ? only.id : undefined;
}
