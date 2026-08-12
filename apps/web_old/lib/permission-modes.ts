// Client-safe permission-mode constants. This module has NO server/SDK
// dependency (no node:* imports, no loom-mcp / @telar/core), so it is safe to
// import — as a runtime value, not just a type — from "use client" components
// (composer-settings.tsx, session-view.tsx, store.ts).
//
// These deliberately do NOT live in lib/permissions.ts: that file pulls in
// ./loom-mcp -> @anthropic-ai/claude-agent-sdk (node:async_hooks), which cannot
// be bundled for the client. permissions.ts re-exports these for server call
// sites; client code must import from HERE directly.

// The only SDK permission modes a client may ever select. The SDK's own
// PermissionMode also includes "bypassPermissions" (skips canUseTool
// entirely, requires an extra opt-in flag) and "dontAsk"/"plan" (not
// meaningful choices from this UI) — none of those are ever accepted from a
// client request even if sent; see isValidPermissionMode and its use in the
// chat route's 400 check.
export const PERMISSION_MODES = ["default", "auto", "acceptEdits"] as const;
export type ClientPermissionMode = (typeof PERMISSION_MODES)[number];

export function isValidPermissionMode(mode: unknown): mode is ClientPermissionMode {
  return typeof mode === "string" && (PERMISSION_MODES as readonly string[]).includes(mode);
}
