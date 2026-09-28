import type { EngineTransport } from "../platform/transport";
import type {
  RunBytesAnswer, RunClosedBy, RunConfigurationDraft, RunConfigurationsAnswer, RunConfigurationView, RunOpenInput, RunOutputAnswer, RunOutputFilter,
  RunResizeAnswer, RunStartInput, RunStatusAnswer, RunStopSignal, RunView, RunWaitAnswer, RunWriteAnswer,
} from "./schema";

export type RunTargetInput = { terminalId?: string; runId?: string };

/** Project-scoped answers still live under the asking session's path. */
export const runBase = (sessionId: string) => `/v2/sessions/${encodeURIComponent(sessionId)}/run`;

function runTarget(input: RunTargetInput): { terminalId?: string } {
  const terminalId = input.terminalId ?? input.runId;
  return terminalId === undefined ? {} : { terminalId };
}

function runBody<T extends RunTargetInput>(input: T): Omit<T, "runId" | "terminalId"> & { terminalId?: string } {
  const { runId: _runId, terminalId: _terminalId, ...rest } = input;
  return { ...rest, ...runTarget(input) };
}

/** Shared by the line and byte views so their cursor spelling cannot drift. */
function runCursor(input: RunTargetInput & { after?: number } & RunOutputFilter): string {
  const query = new URLSearchParams();
  const { terminalId } = runTarget(input);
  if (terminalId !== undefined) query.set("terminalId", terminalId);
  if (input.after !== undefined) query.set("after", String(input.after));
  if (input.tail !== undefined) query.set("tail", String(input.tail));
  if (input.grep !== undefined) query.set("grep", input.grep);
  if (input.stream !== undefined) query.set("stream", input.stream);
  return query.size === 0 ? "" : `?${query.toString()}`;
}

const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

export const terminalClient = {
  runConfigurations(this: EngineTransport, sessionId: string): Promise<RunConfigurationsAnswer> {
    return this.request("GET", `${runBase(sessionId)}/configs`);
  },

  createRunConfiguration(this: EngineTransport, sessionId: string, draft: RunConfigurationDraft): Promise<RunConfigurationView> {
    return this.request("POST", `${runBase(sessionId)}/configs`, draft);
  },

  updateRunConfiguration(this: EngineTransport, sessionId: string, configId: string, patch: Partial<RunConfigurationDraft>): Promise<RunConfigurationView> {
    return this.request("POST", `${runBase(sessionId)}/configs/${encodeURIComponent(configId)}`, patch);
  },

  removeRunConfiguration(this: EngineTransport, sessionId: string, configId: string): Promise<{ removed: string }> {
    return this.request("DELETE", `${runBase(sessionId)}/configs/${encodeURIComponent(configId)}`);
  },

  /** The calling session's terminals, newest first. */
  runStatus(this: EngineTransport, sessionId: string): Promise<RunStatusAnswer> {
    return this.request("GET", `${runBase(sessionId)}/status`);
  },

  startRun(this: EngineTransport, sessionId: string, input: RunStartInput): Promise<RunView> {
    return this.request("POST", `${runBase(sessionId)}/start`, input);
  },

  openTerminal(this: EngineTransport, sessionId: string, input: RunOpenInput): Promise<RunView> {
    return this.request("POST", `${runBase(sessionId)}/open`, input);
  },

  stopRun(this: EngineTransport, sessionId: string, terminalId?: string, signal?: RunStopSignal, options: { closedBy?: RunClosedBy } = {}): Promise<RunView> {
    return this.request("POST", `${runBase(sessionId)}/stop`, defined({ terminalId, signal, closedBy: options.closedBy }));
  },

  restartRun(this: EngineTransport, sessionId: string, terminalId?: string, options: { closedBy?: RunClosedBy } = {}): Promise<RunView> {
    return this.request("POST", `${runBase(sessionId)}/restart`, defined({ terminalId, closedBy: options.closedBy }));
  },

  runOutput(this: EngineTransport, sessionId: string, input: RunTargetInput & { after?: number } & RunOutputFilter = {}): Promise<RunOutputAnswer> {
    return this.request("GET", `${runBase(sessionId)}/output${runCursor(input)}`);
  },

  runWait(
    this: EngineTransport,
    sessionId: string,
    input: RunTargetInput & { pattern?: string; ready?: boolean; exit?: boolean; timeoutMs: number },
  ): Promise<RunWaitAnswer> {
    return this.request("POST", `${runBase(sessionId)}/wait`, runBody(input));
  },

  runBytes(this: EngineTransport, sessionId: string, input: RunTargetInput & { after?: number } = {}): Promise<RunBytesAnswer> {
    return this.request("GET", `${runBase(sessionId)}/bytes${runCursor(input)}`);
  },

  writeRun(this: EngineTransport, sessionId: string, input: RunTargetInput & { data: string }): Promise<RunWriteAnswer> {
    return this.request("POST", `${runBase(sessionId)}/write`, runBody(input));
  },

  resizeRun(this: EngineTransport, sessionId: string, input: RunTargetInput & { cols: number; rows: number }): Promise<RunResizeAnswer> {
    return this.request("POST", `${runBase(sessionId)}/resize`, runBody(input));
  },

  sessionTerminals(this: EngineTransport, sessionId: string): Promise<{ open: number }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/terminals`);
  },

  closeSessionTerminals(this: EngineTransport, sessionId: string): Promise<{ closed: number }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/terminals/close`, {});
  },
};
