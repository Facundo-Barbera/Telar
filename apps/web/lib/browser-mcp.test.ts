// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { beforeEach, describe, expect, test } from "bun:test";
import type { ControlledBrowserState } from "@/lib/browser-runtime-contract";
import { browserTools } from "@/lib/browser-mcp";
import { desktopBrowserHost } from "@/lib/server/desktop-browser-host";
import { controlledBrowserRuntime } from "@/lib/server/browser-runtime";

const desktopState: ControlledBrowserState = {
  scopeKey: "telar:session-a",
  available: true,
  running: true,
  provider: "desktop",
  tabs: [{
    index: 0,
    id: "tab-telar",
    title: "Telar",
    url: "http://localhost:3000/",
    active: true,
  }],
  screenshot: null,
  error: null,
  version: 1,
};

// THESE TESTS MUST NOT REACH A REAL BROWSER. `controlledBrowserRuntime().call`
// tries the desktop CONTROL SOCKET first (browser-runtime.ts's
// desktopControlRequest) and only falls back to the in-process broker the tests
// below register. That socket is discovered purely from two env vars — so when
// the suite is run from a shell that has a live Telar desktop host in it, every
// call here is answered by THAT browser: the first test sees the operator's
// real open tabs instead of its own fixture, and the second waits on a reply
// its fake host will never be asked for and times out at 5s.
//
// Deleted rather than overridden with a dead port: an unroutable port would
// still be *attempted*, and the fetch failure would surface as a thrown error
// rather than the clean "no desktop control socket configured" null that
// desktopControlConfig() returns when the vars are absent.
//
// Re-deleted before EVERY test because bun runs all files in one process, and
// nothing stops another file from setting them.
beforeEach(() => {
  delete process.env.TELAR_DESKTOP_BROWSER_CONTROL_PORT;
  delete process.env.TELAR_DESKTOP_BROWSER_CONTROL_TOKEN;
});

describe("browser MCP agent bridge", () => {
  test("routes an agent tool call to the registered Electron tab host", async () => {
    const broker = desktopBrowserHost();
    const hostId = `browser-mcp-test-${crypto.randomUUID()}`;
    broker.register(hostId, desktopState);
    const unsubscribe = broker.subscribeCommands(hostId, (command) => {
      expect(command.name).toBe("browser_tabs");
      expect(command.args).toEqual({ action: "list" });
      broker.respond(hostId, command.id, {
        content: [{
          type: "text",
          text: "- 0: (current) [Telar](http://localhost:3000/)",
        }],
      });
    });

    try {
      const listTabs = browserTools({ scopeKey: "telar:session-a" }).find((tool) => tool.name === "browser_list_tabs");
      if (!listTabs) throw new Error("browser_list_tabs was not registered");
      const handler = listTabs.handler as unknown as (
        args: Record<string, unknown>,
      ) => Promise<{ content: Array<Record<string, unknown>> }>;
      const result = await handler({});
      expect(result.content[0]).toEqual({
        type: "text",
        text: "- 0: (current) [Telar](http://localhost:3000/)",
      });
    } finally {
      unsubscribe();
      broker.disconnect(hostId);
    }
  });

  test("tags mutating agent calls with their owning panel scope", async () => {
    const broker = desktopBrowserHost();
    const runtime = controlledBrowserRuntime();
    const hostId = `browser-mcp-scope-${crypto.randomUUID()}`;
    const events: Array<{
      reveal: boolean;
      scopeKey?: string;
      stateChanged: boolean;
      presence?: { status: string; tool: string };
    }> = [];
    broker.register(hostId, desktopState);
    const unsubscribeEvents = runtime.subscribe((event) => events.push(event));
    const unsubscribeCommands = broker.subscribeCommands(hostId, (command) => {
      expect(command.scopeKey).toBe("telar:session-a");
      broker.respond(hostId, command.id, {
        content: [{ type: "text", text: "Opened a new browser tab." }],
      });
    });

    try {
      const tabs = browserTools({ scopeKey: "telar:session-a" })
        .find((tool) => tool.name === "browser_tabs");
      if (!tabs) throw new Error("browser_tabs was not registered");
      const handler = tabs.handler as unknown as (
        args: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ action: "new", url: "http://localhost:3000" });
      expect(events.some((event) =>
        event.reveal && event.scopeKey === "telar:session-a",
      )).toBe(true);
      expect(events.some((event) =>
        event.presence?.status === "acting" &&
        event.presence.tool === "browser_tabs" &&
        event.stateChanged === false,
      )).toBe(true);
      expect(events.some((event) =>
        event.presence?.status === "settling" && event.stateChanged,
      )).toBe(true);
      expect(events.some((event) =>
        event.reveal && event.scopeKey === "telar:session-b",
      )).toBe(false);
    } finally {
      unsubscribeCommands();
      unsubscribeEvents();
      broker.disconnect(hostId);
    }
  });
});
