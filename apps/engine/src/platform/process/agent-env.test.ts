import { expect, test } from "bun:test";
import { agentEnv } from "./agent-env";

test("an agent's environment drops the engine's store, tokens and Electron marker, turns git's fsmonitor off, and keeps the rest", () => {
  const engine = {
    PATH: "/usr/bin",
    HOME: "/Users/me",
    TELAR_HOME: "/live/store",
    ELECTRON_RUN_AS_NODE: "1",
    TELAR_HOST_TOKEN: "t",
    TELAR_DESKTOP_BROWSER_CONTROL_PORT: "1",
    TELAR_DESKTOP_BROWSER_CONTROL_TOKEN: "t",
    TELAR_DESKTOP_RUN_TERMINAL_PORT: "1",
    TELAR_DESKTOP_RUN_TERMINAL_TOKEN: "t",
  };
  expect(agentEnv(engine)).toEqual({ PATH: "/usr/bin", HOME: "/Users/me", GIT_CONFIG_PARAMETERS: "'core.fsmonitor=false' 'core.untrackedCache=false'" });
  expect(engine.TELAR_HOME).toBe("/live/store");
});
