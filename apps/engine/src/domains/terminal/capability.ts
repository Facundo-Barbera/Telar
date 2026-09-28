import type { RunOpenInput } from "@telar/engine-client";
import type { RunOutputFilter, RunWaitOutcome } from "./live-run";
import type { RunClosedBy, RunConfigurationInput, RunConfigurationView, RunOutputLine, RunView } from "./types";

export type RunStopSignal = "SIGTERM" | "SIGINT" | "SIGKILL";

type RunWaitAnswer = RunWaitOutcome;

export type RunTarget = { terminalId?: string; runId?: string };

export type RunStatusAnswer = {
  terminals: RunView[];
  sessionWorktreePath?: string;
};

export type RunCapability = {
  configurations(): Promise<RunConfigurationView[]>;
  createConfiguration(input: RunConfigurationInput): Promise<RunConfigurationView>;
  updateConfiguration(configId: string, patch: Partial<RunConfigurationInput>): Promise<RunConfigurationView>;
  removeConfiguration(configId: string): Promise<void>;

  status(): Promise<RunStatusAnswer>;
  start(input: { configId: string; replace?: boolean; openedBy?: "person" | "agent" }): Promise<RunView>;
  open(input: RunOpenInput): Promise<RunView>;
  stop(input?: RunTarget & { signal?: RunStopSignal; closedBy?: RunClosedBy }): Promise<RunView>;
  restart(input?: RunTarget & { closedBy?: RunClosedBy }): Promise<RunView>;
  output(input?: RunTarget & { after?: number } & RunOutputFilter): Promise<{ lines: RunOutputLine[]; cursor: number; dropped: number }>;
  wait(input: RunTarget & { pattern?: string; ready?: boolean; exit?: boolean; timeoutMs: number }): Promise<RunWaitAnswer>;
  bytes(input?: RunTarget & { after?: number }): Promise<{ chunks: string[]; cursor: number; dropped: number }>;
  write(input: RunTarget & { data: string }): Promise<{ delivered: boolean }>;
  resize(input: RunTarget & { cols: number; rows: number }): Promise<{ resized: boolean }>;
};
