import { expect, test } from "bun:test";
import { agentEnv } from "./agent-env";

test("an agent's environment drops the engine's store, tokens and Electron marker but keeps the rest", () => {
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
  expect(agentEnv(engine)).toEqual({ PATH: "/usr/bin", HOME: "/Users/me" });
  expect(engine.TELAR_HOME).toBe("/live/store");
});
