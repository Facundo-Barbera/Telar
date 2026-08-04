// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  getBrowserAgentPresence,
  publishBrowserRuntimeEvent,
} from "./browser-client-events";

describe("browser agent presence", () => {
  test("keeps simultaneous agent activity isolated by session scope", () => {
    publishBrowserRuntimeEvent({
      version: 1,
      reveal: true,
      stateChanged: true,
      presence: {
        status: "acting",
        scopeKey: "session:first",
        tool: "browser_navigate",
        phase: "navigate",
        startedAt: "2026-08-03T12:00:00.000Z",
      },
    });
    publishBrowserRuntimeEvent({
      version: 2,
      reveal: true,
      stateChanged: true,
      presence: {
        status: "acting",
        scopeKey: "session:second",
        tool: "browser_click",
        phase: "click",
        startedAt: "2026-08-03T12:00:01.000Z",
      },
    });

    expect(getBrowserAgentPresence("session:first")?.tool).toBe("browser_navigate");
    expect(getBrowserAgentPresence("session:second")?.tool).toBe("browser_click");
    expect(getBrowserAgentPresence("session:missing")).toBeNull();
  });
});
