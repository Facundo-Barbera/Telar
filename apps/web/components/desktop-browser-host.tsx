"use client";

import { useEffect } from "react";
import {
  publishBrowserRuntimeEvent,
  publishDesktopBrowserPointer,
} from "@/lib/browser-client-events";
import {
  TELAR_BROWSER_MUTATION_EVENT,
  type BrowserRuntimeEvent,
} from "@/lib/browser-runtime-contract";
import {
  diagnosticEventSource,
  diagnosticFetch,
} from "@/lib/client-request-diagnostics";

async function postHost(body: Record<string, unknown>) {
  const response = await diagnosticFetch("/api/browser/desktop-host", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: body.kind === "disconnect",
  }, `desktop host ${String(body.kind ?? "message")}`);
  if (!response.ok) throw new Error(`Desktop browser host request failed (${response.status}).`);
  return response.json() as Promise<{ ok: true; brokerInstanceId: string }>;
}

/**
 * Keeps each session's Electron browser tabs and agent tools on one scoped channel.
 *
 * Architecture invariant: this is only a bridge into the T3 Code-derived
 * Electron browser host. The renderer must not create or own a parallel
 * Playwright/CDP browser; Electron remains responsible for tabs, views,
 * bounds, visibility, and direct interaction.
 */
export function DesktopBrowserHost() {
  useEffect(() => {
    // This stream is intentionally always mounted. Agent browser mutations can
    // happen before the Browser surface exists; the surface-owned subscription
    // is therefore too late to reveal the tab that the agent just opened.
    const { source: events, close } = diagnosticEventSource(
      "/api/browser/events",
      "browser runtime mutations",
    );
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as BrowserRuntimeEvent;
        publishBrowserRuntimeEvent(event);
        if (event.reveal && event.scopeKey) {
          window.dispatchEvent(new CustomEvent(
            TELAR_BROWSER_MUTATION_EVENT,
            { detail: event.scopeKey },
          ));
        }
      } catch {
        // Ignore stale event formats during a development hot reload.
      }
    };
    return close;
  }, []);

  useEffect(() => {
    const bridge = window.telarDesktop?.browser;
    if (!bridge) return;
    const hostId = crypto.randomUUID();
    let disposed = false;
    let events: EventSource | null = null;
    let closeEvents = () => {};
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const publishState = async (kind: "register" | "state", scopeKey = "__host__") => {
      const state = await bridge.getState(scopeKey);
      if (disposed) return null;
      return postHost({ kind, hostId, state });
    };

    const connect = async () => {
      const registration = await publishState("register");
      if (disposed || !registration) return;
      const expectedBrokerInstanceId = registration.brokerInstanceId;
      const tracked = diagnosticEventSource(
        `/api/browser/desktop-host?hostId=${encodeURIComponent(hostId)}`,
        "desktop browser commands",
      );
      events = tracked.source;
      closeEvents = tracked.close;
      events.onmessage = (event) => {
        const command = JSON.parse(event.data) as Partial<{
          kind: "broker";
          brokerInstanceId: string;
          id: string;
          scopeKey: string;
          name: string;
          args: Record<string, unknown>;
        }>;
        if (command.kind === "broker") {
          if (command.brokerInstanceId !== expectedBrokerInstanceId) {
            closeEvents();
            if (!disposed) reconnectTimer = setTimeout(() => void connect(), 100);
          }
          return;
        }
        const id = typeof command.id === "string" ? command.id : "";
        const scopeKey = typeof command.scopeKey === "string"
          ? command.scopeKey.trim()
          : "";
        const name = typeof command.name === "string" ? command.name : "";
        if (!id || !scopeKey || !name) {
          if (id) {
            void postHost({
              kind: "respond",
              hostId,
              id,
              error: "The browser command used an outdated unscoped protocol. Reload Telar and retry.",
            });
          }
          return;
        }
        void bridge.callTool(scopeKey, name, command.args ?? {})
          .then(async (result) => {
            await postHost({ kind: "respond", hostId, id, result });
            await publishState("state", scopeKey);
          })
          .catch((error) => postHost({
            kind: "respond",
            hostId,
            id,
            error: error instanceof Error ? error.message : String(error),
          }));
      };
    };

    const unsubscribe = bridge.onState((state) => {
      if (!disposed) void postHost({ kind: "state", hostId, state });
    });
    const unsubscribePointer = bridge.onPointer(publishDesktopBrowserPointer);
    void connect().catch(() => {
      if (!disposed) reconnectTimer = setTimeout(() => void connect(), 500);
    });
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      unsubscribe();
      unsubscribePointer();
      closeEvents();
      void postHost({ kind: "disconnect", hostId });
    };
  }, []);

  return null;
}
