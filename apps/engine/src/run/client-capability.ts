/**
 * `RunCapability` out of `EngineClient` calls — the worker's copy.
 *
 * THE WORKER MUST NOT SPAWN THE PROCESS. Every verb here is an HTTP call to the
 * daemon, because a dev server spawned by a worker would be a child of ONE
 * conversation: it would die when that conversation ended and be invisible to
 * every other session. The daemon owns the process group, so the run outlives
 * whoever launched it — which is the entire point of the feature.
 *
 * IT SPEAKS THE CLIENT'S TYPED VERBS, NOT A VOCABULARY OF ITS OWN. An earlier
 * draft invented RPC-ish method names (`configs/create`) that no route matched:
 * three verbs that typechecked, read fine, and would have 404'd the first time
 * an agent used them. Naming `EngineClient`'s methods means the compiler is what
 * keeps the two halves spelling the same thing.
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
  | "stopRun"
  | "restartRun"
  | "releaseRun"
  | "runOutput"
>;

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
    stop: (input) => client.stopRun(sessionId, input?.runId),
    restart: (input) => client.restartRun(sessionId, input?.runId),
    release: (input) => client.releaseRun(sessionId, input.runId),
    output: (input) => client.runOutput(sessionId, input ?? {}),
  };
}
