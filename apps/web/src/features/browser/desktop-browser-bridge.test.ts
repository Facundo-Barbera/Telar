import { expect, test } from "bun:test";
import { desktopBrowserBridge } from "./desktop-browser-bridge";
import type { DesktopBrowserBridge } from "./types";

test("remote host routes cannot use this computer's native browser", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const bridge = {} as DesktopBrowserBridge;
  const location = { pathname: "/projects/project_local/sessions/session_local" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location, telarDesktop: { browser: bridge } } });
  try {
    expect(desktopBrowserBridge()).toBe(bridge);
    location.pathname = "/hosts/remote-mac/projects/project_remote/sessions/session_remote";
    expect(desktopBrowserBridge()).toBeUndefined();
    location.pathname = "/projects/project_local/sessions/session_local";
    expect(desktopBrowserBridge()).toBe(bridge);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
