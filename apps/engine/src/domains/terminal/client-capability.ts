import type { EngineClient } from "@telar/engine-client";
import type { RunCapability } from "./capability";

export type RunClient = Pick<
  EngineClient,
  | "runConfigurations"
  | "createRunConfiguration"
  | "updateRunConfiguration"
  | "removeRunConfiguration"
  | "runStatus"
  | "startRun"
  | "openTerminal"
  | "stopRun"
  | "restartRun"
  | "runOutput"
  | "runWait"
  | "runBytes"
  | "writeRun"
  | "resizeRun"
>;

const idOf = (input?: { terminalId?: string; runId?: string }) => input?.terminalId ?? input?.runId;

export function clientRunCapability(client: RunClient, sessionId: string): RunCapability {
  return {
    configurations: async () => (await client.runConfigurations(sessionId)).configurations,
    createConfiguration: (input) => client.createRunConfiguration(sessionId, input),
    updateConfiguration: (configId, patch) => client.updateRunConfiguration(sessionId, configId, patch),
    removeConfiguration: async (configId) => {
      await client.removeRunConfiguration(sessionId, configId);
    },
    status: () => client.runStatus(sessionId),
    start: (input) => client.startRun(sessionId, input),
    open: (input) => client.openTerminal(sessionId, input),
    stop: (input) =>
      client.stopRun(sessionId, idOf(input), input?.signal, ...(input?.closedBy ? [{ closedBy: input.closedBy }] : [])),
    restart: (input) => client.restartRun(sessionId, idOf(input), ...(input?.closedBy ? [{ closedBy: input.closedBy }] : [])),
    output: (input) => client.runOutput(sessionId, input ?? {}),
    wait: (input) => client.runWait(sessionId, input),
    bytes: (input) => client.runBytes(sessionId, input ?? {}),
    write: (input) => client.writeRun(sessionId, input),
    resize: (input) => client.resizeRun(sessionId, input),
  };
}
