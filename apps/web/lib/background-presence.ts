/**
 * WHAT THE "N TASKS STILL WORKING" BANNER'S VIEW OPENS.
 *
 * It always lands on the Processes tab. When exactly one task is still working
 * and it is a process, its row opens too, so its live log is the first thing
 * on screen; with several, picking one for the reader would be a guess, so
 * none opens. A lone backgrounded sub-agent is counted by the banner but lives
 * on the Agents tab, so there is no Processes row to open for it.
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
