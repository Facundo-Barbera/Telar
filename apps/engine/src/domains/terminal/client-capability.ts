/**
 * `RunCapability` out of `EngineClient` calls — the worker's copy.
 *
 * THE WORKER MUST NOT OPEN THE TERMINAL ITSELF. Every verb here is an HTTP call
 * to the daemon, because the daemon is what speaks to the desktop's terminal
 * host — and a process a worker spawned would die with the worker instead of
 * living in the session's panel where the person can see and close it.
 *
 * IT SPEAKS THE CLIENT'S TYPED VERBS, NOT A VOCABULARY OF ITS OWN, so the
 * compiler is what keeps the two halves spelling the same thing.
 */
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

/** `terminalId`, or the same thing under its old name. */
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
    /**
     * OVER HTTP LIKE EVERY OTHER VERB, and the worker waits on the SOCKET
     * rather than on a loop of its own: the conditions are facts the DAEMON
     * holds, so a worker that re-implemented this would be polling for them.
     */
    wait: (input) => client.runWait(sessionId, input),
    bytes: (input) => client.runBytes(sessionId, input ?? {}),
    // Present so the two implementations cannot disagree about the shape. The
    // toolkit does not expose either — typing is a person's act.
    write: (input) => client.writeRun(sessionId, input),
    resize: (input) => client.resizeRun(sessionId, input),
  };
}
