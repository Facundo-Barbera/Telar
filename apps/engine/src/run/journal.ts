/**
 * What a restarted engine needs to pick its terminals back up — and nothing
 * about whether they are alive.
 *
 * THIS USED TO BE A LIVENESS RECORD, AND IT IS NOT ANY MORE. It was written
 * before each spawn and read back after a crash as an `unknown` run that held
 * its project's one deployment slot until a person "released" it, because a
 * dev server nobody could see might still be holding the port. "Run = a new
 * terminal" removed the slot, the `unknown` and the release, and with them the
 * reason to fear a record: nothing here can block a launch now.
 *
 * WHAT IS LEFT IS A NAME TAG. The desktop host keeps its terminals across an
 * engine restart — the terminal owns its process, so the engine going down is
 * not a reason to end a person's dev server. When a new engine starts it asks
 * the host which terminals it holds (`GET /state`), and this file is how it
 * tells which of those it opened and WHICH CONFIGURATION TO REDACT THEM WITH:
 * the host's list carries a session and a title, never a secret, and output
 * mirrored to the cockpit without its configuration's secrets would print
 * them. So one entry per terminal is written once the host names it, and
 * removed when it ends.
 *
 * ENTRIES THE HOST NO LONGER HOLDS ARE DROPPED WITHOUT A WORD. There is no
 * orphan to show and no pid to go looking for: a terminal the host does not
 * have has ended, and the host is the only one who could have ended it.
 *
 * A FILE THAT CANNOT BE READ IS TREATED AS EMPTY. That used to latch the
 * engine into refusing every launch; with nothing left for this file to
 * protect, a bad file costs only the re-listing, and the next write replaces
 * it.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../atomic";
import type { RunOrigin } from "./types";

/** Enough to re-attach a terminal the host still holds. No secret, no pid. */
export type RunRecord = {
  terminalId: string;
  projectId: string;
  sessionId: string;
  origin: RunOrigin;
  title: string;
  /** Where its secrets live — resolved again from the store on re-attach. */
  configId?: string;
  configName: string;
  command: string;
  worktreePath: string;
  worktreeBranch?: string;
  cwd: string;
  readinessUrl?: string;
  startedAt: number;
};

export type RunJournal = {
  /** Upsert, once the host has named the terminal. */
  open(record: RunRecord): void;
  close(terminalId: string): void;
  list(): RunRecord[];
  /** Replace the whole set — what re-listing leaves behind. */
  replace(records: RunRecord[]): void;
};

/** A journal that forgets everything, for callers that want no re-listing. */
export const nullRunJournal: RunJournal = {
  open() {},
  close() {},
  list: () => [],
  replace() {},
};

function isRecord(value: unknown): value is RunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const field of ["terminalId", "projectId", "sessionId", "title", "configName", "command", "worktreePath", "cwd"] as const) {
    if (typeof record[field] !== "string" || !record[field]) return false;
  }
  if (record.origin !== "run" && record.origin !== "agent") return false;
  for (const field of ["configId", "worktreeBranch", "readinessUrl"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") return false;
  }
  return typeof record.startedAt === "number" && Number.isFinite(record.startedAt);
}

/**
 * One small JSON file of the terminals the engine opened and has not seen end.
 *
 * NEVER THROWS OUT OF A READ. A missing, unreadable or malformed file is an
 * empty list, and a malformed ENTRY is skipped rather than failing the others —
 * the cost of either is one terminal the new engine does not re-list, which is
 * a terminal that keeps running in the panel and can still be closed there.
 */
export class RunJournalFile implements RunJournal {
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "open-terminals.json");
  }

  list(): RunRecord[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
    const terminals = (parsed as { terminals?: unknown } | null)?.terminals;
    return Array.isArray(terminals) ? terminals.filter(isRecord) : [];
  }

  open(record: RunRecord): void {
    this.replace([...this.list().filter((entry) => entry.terminalId !== record.terminalId), record]);
  }

  close(terminalId: string): void {
    const terminals = this.list();
    const next = terminals.filter((entry) => entry.terminalId !== terminalId);
    if (next.length !== terminals.length) this.replace(next);
  }

  replace(records: RunRecord[]): void {
    atomicWrite(this.file, { terminals: records });
  }
}
