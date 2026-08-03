// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { ControlledBrowserState } from "@/lib/browser-runtime-contract";
import { DesktopBrowserHostBroker } from "@/lib/server/desktop-browser-host";

const emptyDesktopState = (): ControlledBrowserState => ({
  available: true,
  running: true,
  provider: "desktop",
  tabs: [],
  screenshot: null,
  error: null,
  version: 1,
});

describe("desktop browser host broker", () => {
  test("routes one agent command to the registered Electron host", async () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState());
    const unsubscribe = broker.subscribeCommands("desktop-a", (command) => {
      expect(command.name).toBe("browser_tabs");
      expect(command.args).toEqual({ action: "list" });
      broker.respond("desktop-a", command.id, {
        content: [{ type: "text", text: "- 0: (current) [Telar](http://localhost:3000/)" }],
      });
    });

    const result = await broker.call("browser_tabs", { action: "list" });
    expect(result.content[0]).toEqual({
      type: "text",
      text: "- 0: (current) [Telar](http://localhost:3000/)",
    });
    unsubscribe();
  });

  test("publishes desktop state and rejects pending work on disconnect", async () => {
    const broker = new DesktopBrowserHostBroker();
    const state = emptyDesktopState();
    state.tabs = [{ index: 0, id: "tab-a", title: "Telar", url: "http://localhost:3000/", active: true }];
    broker.register("desktop-a", state);
    expect(broker.state()?.provider).toBe("desktop");
    expect(broker.state()?.tabs[0]?.id).toBe("tab-a");

    const pending = broker.call("browser_snapshot", {});
    broker.disconnect("desktop-a");
    await expect(pending).rejects.toThrow("disconnected");
    expect(broker.state()).toBeNull();
  });

  test("replacing a host cannot be undone by the old renderer cleanup", () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState());
    broker.register("desktop-b", { ...emptyDesktopState(), version: 2 });
    broker.disconnect("desktop-a");
    expect(broker.online()).toBe(true);
    expect(broker.state()?.version).toBe(2);
  });
});
