import type { RunJournal } from "./journal";
import type { RunHandle, RunLauncher } from "./launcher";
import type { RunKill, RunProcessGroup } from "./platform";
import { type RunClosedBy, type RunConfiguration, RunError, type RunOrigin, type RunOutputLine, type RunProbe, type RunReadiness, type RunStatus, type RunView } from "./types";

export const MAX_LINES = 2000;
export const MAX_LINE_CHARS = 4000;
export const MAX_BYTE_CHUNKS = 4000;
export const MAX_BYTE_CHARS = 256_000;
export const CLOSE_SETTLE_MS = 2000;
export const READY_POLL_MS = 500;
export const KEEP_FINISHED = 10;
export const WAIT_TICK_MS = 50;

export type RunOutputFilter = {
  tail?: number;
  grep?: string;
  stream?: "stdout" | "stderr";
};

export type RunWaitOutcome = { fired: "pattern" | "ready" | "exit" | "timeout"; cursor: number; lines: RunOutputLine[] };

export function compile(source: string, field: string): RegExp {
  try {
    return new RegExp(source);
  } catch (error) {
    throw new RunError("invalid_request", `${field} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type StartRunInput = {
  projectId: string;
  sessionId: string;
  config: RunConfiguration;
  worktreePath: string;
  worktreeBranch?: string;
  origin?: RunOrigin;
  openedBy?: "person" | "agent";
  readyPattern?: string;
};

export type LiveRun = {
  terminalId: string;
  projectId: string;
  sessionId: string;
  origin: RunOrigin;
  baseTitle: string;
  instance: number;
  config: RunConfiguration;
  configName: string;
  command: string;
  worktreePath: string;
  worktreeBranch?: string;
  cwd: string;
  status: RunStatus;
  readiness: RunReadiness;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  signal?: string;
  error?: string;
  warning?: string;
  closedBy?: RunClosedBy;
  closing?: RunClosedBy;
  agentWatching: boolean;
  readyPattern?: RegExp;
  closeTask?: Promise<void>;
  handle?: RunHandle;
  blind: boolean;
  lines: RunOutputLine[];
  dropped: number;
  bytes: string[];
  byteChars: number;
  bytesDropped: number;
  secrets: string[];
  readyTimer?: ReturnType<typeof setInterval>;
  waiters: Array<() => void>;
};

export type RunManagerOptions = {
  now?: () => number;
  probe?: RunProbe;
  kill?: RunKill;
  platform?: NodeJS.Platform;
  processGroup?: RunProcessGroup;
  launcher?: RunLauncher;
  journal?: RunJournal;
  stopGraceMs?: number;
  closeSettleMs?: number;
  readyPollMs?: number;
  personClosed?: (run: RunView) => void;
};

export const defaultProbe: RunProbe = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: "manual" });
    return { answered: true, serving: response.status < 500 };
  } catch {
    return { answered: false, serving: false };
  }
};

export function portOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return url;
  }
}

export type RunStatusEvent = {
  type: "run.status";
  projectId: string;
  sessionId: string;
  run: RunView;
};
