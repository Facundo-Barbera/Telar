// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
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
