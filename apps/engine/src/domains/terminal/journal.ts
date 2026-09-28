import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../../platform/fs/atomic";
import type { RunOrigin } from "./types";

export type RunRecord = {
  terminalId: string;
  projectId: string;
  sessionId: string;
  origin: RunOrigin;
  title: string;
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
  open(record: RunRecord): void;
  close(terminalId: string): void;
  list(): RunRecord[];
  replace(records: RunRecord[]): void;
};

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
