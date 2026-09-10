/**
 * The one durable fact about a run: that we started it and had not seen it end.
 *
 * WHY THIS EXISTS AT ALL, GIVEN THERE IS NO SUPERVISOR. Runs live in the
 * daemon's memory, and if the daemon dies uncleanly that memory goes with it —
 * along with every trace that a `bun run dev` is still holding port 3000. The
 * next daemon would then cheerfully accept "start the dev server" and hand the
 * human a port collision, which is the exact failure the singleton exists to
 * prevent. So one record is written BEFORE the spawn and removed when the run
 * ends cleanly, and whatever is left over on startup is read back as `unknown`.
 *
 * IT DOES NOT ADOPT ANYTHING. A recovered record is not a process handle: the
 * pid in it is a number from a previous boot of a previous daemon, and the
 * kernel may well have handed it to something else since. Nothing signals it,
 * nothing polls it, nothing claims it is alive. The record's only power is to
 * BLOCK the project's slot and tell a human where to look — and `release` is
 * how they say "I checked; it is gone".
 *
 * The pid is recorded purely so that sentence can name it.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../atomic";

/** Enough to describe, to a human, a process we can no longer see. */
export type RunRecord = {
  runId: string;
  projectId: string;
  configId: string;
  configName: string;
  command: string;
  worktreePath: string;
  worktreeBranch?: string;
  cwd: string;
  sessionId?: string;
  startedAt: number;
  /** The process-group leader we spawned. Reported, never signalled. */
  pid?: number;
};

export type RunJournal = {
  /** Upsert. Called before the spawn, and again once there is a pid. */
  open(record: RunRecord): void;
  close(runId: string): void;
  list(): RunRecord[];
};

/**
 * The journal could not be read, so what it says is unknown.
 *
 * THIS IS NOT "THERE ARE NO RUNS". A file we cannot parse may describe a dev
 * server still holding port 3000, and the difference between "no records" and
 * "no answer" is the difference between letting the next launch proceed and
 * letting it collide. Every caller that would act on emptiness has to see this
 * instead.
 */
export class RunJournalUnreadable extends Error {
  constructor(
    message: string,
    /** What to tell a human, and what the file is called. */
    readonly file: string,
  ) {
    super(message);
    this.name = "RunJournalUnreadable";
  }
}

/** A journal that forgets everything, for callers that want no durability. */
export const nullRunJournal: RunJournal = {
  open() {},
  close() {},
  list: () => [],
};

/** Why this entry is not a record, or `undefined` when it is one. */
function recordFault(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "an entry is not an object";
  const record = value as Record<string, unknown>;
  const strings = ["runId", "projectId", "configId", "configName", "command", "worktreePath", "cwd"] as const;
  for (const field of strings) {
    if (typeof record[field] !== "string" || !record[field]) return `an entry has no ${field}`;
  }
  if (typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt)) return "an entry has no startedAt";
  const optionalStrings = ["worktreeBranch", "sessionId"] as const;
  for (const field of optionalStrings) {
    if (record[field] !== undefined && typeof record[field] !== "string") return `an entry has a malformed ${field}`;
  }
  if (record.pid !== undefined && (typeof record.pid !== "number" || !Number.isInteger(record.pid))) {
    return "an entry has a malformed pid";
  }
  return undefined;
}

/**
 * One small JSON file listing the runs believed to be live.
 *
 * WRITTEN SYNCHRONOUSLY, ON PURPOSE. `open()` is called on the path to a spawn,
 * and a record that lands after the process does is a record that can be missed
 * by exactly the crash it exists for. It is a handful of bytes.
 *
 * A FILE WE CANNOT READ IS NOT AN EMPTY FILE. Reading a truncated, unreadable or
 * half-written journal as "no runs" is the worst possible answer: it is exactly
 * the situation where something IS probably still running, and answering "empty"
 * both frees the slot and — because `open()` rewrites the file from what it just
 * read — destroys the only evidence of what to look for. So anything other than
 * "this file does not exist" throws `RunJournalUnreadable`, the bad file is left
 * on disk untouched, and starting runs is what fails. The rest of the daemon is
 * not the journal's business and keeps working.
 */
export class RunJournalFile implements RunJournal {
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "open-runs.json");
  }

  list(): RunRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      // ENOENT is the ONLY error that means "nothing was ever recorded". A
      // permission or I/O failure means the records may exist and be hidden.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new RunJournalUnreadable(
        `${this.file} could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"}), so Telar cannot tell whether processes from a previous run are still alive`,
        this.file,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RunJournalUnreadable(`${this.file} is not valid JSON, so the runs it describes cannot be read back`, this.file);
    }
    const runs = (parsed as { runs?: unknown } | null)?.runs;
    if (!Array.isArray(runs)) {
      throw new RunJournalUnreadable(`${this.file} does not contain a list of runs`, this.file);
    }
    // NO SILENT FILTERING. A record we cannot parse is a process we cannot
    // describe; dropping it would quietly free the slot it was written to hold.
    for (const entry of runs) {
      const fault = recordFault(entry);
      if (fault) throw new RunJournalUnreadable(`${this.file} is malformed: ${fault}`, this.file);
    }
    return runs as RunRecord[];
  }

  open(record: RunRecord): void {
    const runs = this.list().filter((entry) => entry.runId !== record.runId);
    runs.push(record);
    this.save(runs);
  }

  close(runId: string): void {
    const runs = this.list();
    const next = runs.filter((entry) => entry.runId !== runId);
    if (next.length !== runs.length) this.save(next);
  }

  private save(runs: RunRecord[]): void {
    atomicWrite(this.file, { runs });
  }
}
