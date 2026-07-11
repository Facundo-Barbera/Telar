"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Autodetected OAuth status shared by the MCP settings card and the project
// detail page's Manifest rail (docs/mcp-oauth-design.md §3). The status route
// probes every http server and returns { requiresOAuth, connected, expiresAt?,
// health? }; stdio servers aren't in the map (shown as "Local" from transport).
// `health` is the live authenticated liveness probe (checkMcpHealth) — absent
// until the route responds, which the dot renders as "checking".
export type McpHealth = "connected" | "needs-auth" | "error";

export type HttpStatus = {
  requiresOAuth: boolean;
  connected: boolean;
  expiresAt?: number;
  health?: McpHealth;
};

// Tolerant read of the status route so the UI survives whatever exact shape the
// route exposes (it may lag a redeploy): a { servers: { [name]: {...} } } object.
// Anything unrecognized is omitted, which renders as the "checking" dot.
export function normalizeStatus(raw: unknown): Record<string, HttpStatus> {
  const src = (raw as { servers?: Record<string, unknown> } | null)?.servers;
  if (!src || typeof src !== "object") return {};
  const out: Record<string, HttpStatus> = {};
  for (const [server, v] of Object.entries(src)) {
    if (v && typeof v === "object") {
      const o = v as {
        requiresOAuth?: unknown;
        connected?: unknown;
        expiresAt?: unknown;
        health?: unknown;
      };
      const h = o.health;
      out[server] = {
        requiresOAuth: o.requiresOAuth === true,
        connected: o.connected === true,
        expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : undefined,
        health:
          h === "connected" || h === "needs-auth" || h === "error"
            ? h
            : undefined,
      };
    }
  }
  return out;
}

// A very small colored liveness dot next to a server name, driven by the live
// health probe (checkMcpHealth) the status route runs. green=connected,
// amber=needs-auth, red=error; neutral gray both while "checking" (before the
// route responds) and for stdio ("local"). The label shows on hover.
export function HealthDot({
  transport,
  status,
}: {
  transport: "stdio" | "http";
  status?: HttpStatus;
}) {
  const state: McpHealth | "checking" | "local" =
    transport === "stdio"
      ? "local"
      : !status || !status.health
        ? "checking"
        : status.health;
  const { color, label } = {
    connected: { color: "bg-emerald-500", label: "Connected" },
    "needs-auth": { color: "bg-amber-400", label: "Needs sign-in" },
    error: { color: "bg-destructive", label: "Unreachable" },
    checking: { color: "bg-muted-foreground/40", label: "Checking…" },
    local: { color: "bg-muted-foreground/40", label: "Local" },
  }[state];
  return (
    <Tooltip>
      <TooltipTrigger
        className={cn(
          "size-1.5 shrink-0 cursor-help rounded-full outline-none",
          color,
        )}
        aria-label={`Health: ${label}`}
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
