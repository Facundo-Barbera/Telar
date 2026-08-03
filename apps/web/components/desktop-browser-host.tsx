"use client";

import { useEffect } from "react";

async function postHost(body: Record<string, unknown>) {
  await fetch("/api/browser/desktop-host", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: body.kind === "disconnect",
  });
}

/** Keeps Electron browser tabs and agent tools on one shared channel. */
export function DesktopBrowserHost() {
  useEffect(() => {
    const bridge = window.telarDesktop?.browser;
    if (!bridge) return;
    const hostId = crypto.randomUUID();
    let disposed = false;
    let events: EventSource | null = null;

    const publishState = async (kind: "register" | "state") => {
      const state = await bridge.getState();
      if (!disposed) await postHost({ kind, hostId, state });
    };

    const connect = async () => {
      await publishState("register");
      if (disposed) return;
      events = new EventSource(`/api/browser/desktop-host?hostId=${encodeURIComponent(hostId)}`);
      events.onmessage = (event) => {
        const command = JSON.parse(event.data) as {
          id: string;
          name: string;
          args: Record<string, unknown>;
        };
        void bridge.callTool(command.name, command.args)
          .then(async (result) => {
            await postHost({ kind: "respond", hostId, id: command.id, result });
            await publishState("state");
          })
          .catch((error) => postHost({
            kind: "respond",
            hostId,
            id: command.id,
            error: error instanceof Error ? error.message : String(error),
          }));
      };
    };

    const unsubscribe = bridge.onState((state) => {
      if (!disposed) void postHost({ kind: "state", hostId, state });
    });
    void connect();
    return () => {
      disposed = true;
      unsubscribe();
      events?.close();
      void postHost({ kind: "disconnect", hostId });
    };
  }, []);

  return null;
}
