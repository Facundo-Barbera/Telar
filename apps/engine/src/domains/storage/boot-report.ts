import type { EngineStore } from "../../state";
import { readWorktreesRoot } from "../worktrees";
import { retireAgentReport, retireAgentStore, sweepReport, sweepSpoolAndLooms } from "./decommission-sweep";
import { reapNodeModules, reapReport } from "./node-modules-reap";

const count = (value: number) => value.toLocaleString("en-US");

/**
 * The once-per-start housekeeping, each part best-effort and one line on stdout only when something actually
 * happened: a log that says "removed nothing" on every start trains its reader past the start that matters.
 */
export function reportBootHousekeeping(store: EngineStore, now: () => number, say: (line: string) => void): void {
  const swept = store.executionHousekeeping();
  if (swept) {
    const parts: string[] = [];
    if (swept.receipts > 0) parts.push(`${count(swept.receipts)} spent command receipts`);
    if (swept.backup?.removed) {
      const mb = (swept.backup.bytes / 1_000_000).toFixed(1);
      const days = Math.floor(swept.backup.ageMs / 86_400_000);
      parts.push(`the pre-SQLite JSON backup (${count(swept.backup.files)} files, ${mb} MB, ${days} days old)`);
    }
    if (parts.length > 0) say(`Telar engine: removed ${parts.join(" and ")}`);
  }
  const indexed = store.sessionIndexBackfill;
  if (indexed && (indexed.built > 0 || indexed.removed > 0)) {
    const built = indexed.built > 0 ? `indexed ${count(indexed.built)} sessions` : "";
    const removed = indexed.removed > 0 ? `dropped ${count(indexed.removed)} orphaned rows` : "";
    say(`Telar engine: ${[built, removed].filter(Boolean).join(" and ")}`);
  }
  const summarised = store.turnSummaryBackfill;
  if (summarised && summarised.turns > 0) say(`Telar engine: summarised ${count(summarised.turns)} turns across ${count(summarised.sessions)} sessions`);
  const decommissioned = sweepReport(sweepSpoolAndLooms(store.paths.root));
  if (decommissioned) say(decommissioned);
  try {
    // Asked first: a checkouts root on a drive that is out makes every tree look gone, and reaping on that reading is wrong.
    const checkouts = readWorktreesRoot(store.paths.root);
    const reaped = reapReport(
      reapNodeModules(store.paths.root, { rootReadable: checkouts.kind === "configured" || checkouts.kind === "default", candidates: store.worktrees.reapable() }),
    );
    if (reaped) say(reaped);
  } catch {
    /* never the reason an engine fails to start; the next start tries again */
  }
  // Not a sweep: the backfill for the lock the cut applies, silent because it runs on every start.
  store.worktrees.lockLive();
  const retiredAgent = retireAgentReport(retireAgentStore(store.paths.root, now));
  if (retiredAgent) say(retiredAgent);
  // Once on the way up, so a drive already unplugged is known before the first listing.
  const away = store
    .projectRegistry.list()
    .map((project) => ({ project, availability: store.projectProbes.availability(project) }))
    .filter((entry) => entry.availability !== "available");
  if (away.length > 0) {
    const named = away.map((entry) => `${entry.project.name} (${entry.availability})`).join(", ");
    say(`Telar engine: ${away.length === 1 ? "a project is" : `${away.length} projects are`} unreadable — ${named}`);
  }
}
