/**
 * WHAT THE MAIN SESSION LEFT ON DISK — issue #531.
 *
 * `decommission-sweep.ts`'s judgement, one document smaller: the code that read
 * `main-session.json` is gone, so the file is not state any more, it is litter
 * with no reader. A startup step rather than a command, because the machines
 * carrying it are nobody's to administer and a cleanup you have to know to run
 * is a cleanup that does not happen.
 *
 * ── NO MIGRATION, AND THAT IS THE OWNER'S DECISION ──────────────────────────
 * The owner confirmed on #531 that no `telar`-driver session exists on any
 * store — Main was switched off before any turn ran — so the migrate-or-archive
 * branch was dropped rather than written and never exercised. What a session
 * designated under #523 keeps is everything: it was always an ordinary session,
 * and dropping the designation leaves an ordinary session. Nothing is moved
 * because nothing changes hands.
 *
 * ── ONE THING IS CARRIED, AND IT IS NOT HISTORY ─────────────────────────────
 * A key somebody pasted under #526 lived as a sensitive variable on the `telar`
 * provider login, which goes with the driver kind. Asking them to paste the
 * same key again would be the upgrade losing something it did not have to, so
 * `EngineStore.carryOverAgentKey` moves it across before this runs. That is the
 * whole of the migration, and it is a credential rather than a conversation.
 *
 * ── IT SAYS WHAT WENT, ONCE ─────────────────────────────────────────────────
 * Deleting somebody's document in silence leaves them no evidence but the
 * absence. One line, and only when something actually went: a daemon that
 * reports "removed nothing" on every start trains its reader to skip the line
 * that matters. There is no marker file — `existsSync` on one path is cheaper
 * than the marker would be, and the answer is the same.
 */
import fs from "node:fs";
import path from "node:path";

/** The document the designation lived in, at the engine root. */
export function mainSessionFile(engineRoot: string): string {
  return path.join(engineRoot, "main-session.json");
}

export type MainSweep = {
  /** Whether the document was there to delete. */
  removed: boolean;
  /** Whether a #526 key was moved to the Agent's own store on the way past. */
  carriedKey: boolean;
  /**
   * Whether the `telar` login's leftover secret was dropped afterwards.
   *
   * SEPARATE FROM `carriedKey` BECAUSE THE TWO CAN DISAGREE. A machine that
   * pasted no key under #526 has a row to retire and nothing to carry, and the
   * upgrade should still say it tidied the credential file.
   */
  droppedSecrets: boolean;
};

/**
 * Delete `main-session.json`, and say whether it was there.
 *
 * TOLERANT OF A FAILURE TO DELETE, for `sweepSpoolAndLooms`' reason: a file the
 * engine cannot remove is a permissions problem on somebody's machine, and it
 * must not stop a daemon from starting over litter.
 */
export function sweepMainSession(engineRoot: string): boolean {
  const file = mainSessionFile(engineRoot);
  if (!fs.existsSync(file)) return false;
  try {
    fs.rmSync(file);
    return true;
  } catch {
    return false;
  }
}

/** The line, or nothing. Nothing is the ordinary case on every machine that
 *  never switched Main on, which is almost all of them. */
export function mainSweepReport(sweep: MainSweep): string | undefined {
  if (!sweep.removed && !sweep.carriedKey && !sweep.droppedSecrets) return undefined;
  const parts: string[] = [];
  if (sweep.removed) parts.push("removed main-session.json — the Main session is now the Agent");
  if (sweep.carriedKey) parts.push("carried its OpenCode Go key over to the Agent's own settings");
  if (sweep.droppedSecrets) parts.push("dropped the retired telar login's leftover secret");
  return `Telar engine: ${parts.join("; ")}.`;
}
