"use client";

// Client-side mutations against a single chat, plus the one invalidation
// convention every surface in the app listens on.
//
// This exists because the archive button, the sidebar's inbox menu and the
// project page were all about to hand-roll the same fetch + router.refresh() +
// telar:refresh broadcast. `telar:refresh` is the app's ONLY cross-surface
// invalidation signal (see lib/telar-refresh.ts and its listeners in
// app-sidebar.tsx, app/page.tsx, projects/page.tsx) — a mutation that forgets
// to dispatch it leaves every other open surface showing stale state until the
// next unrelated poll.

import { dispatchTelarRefresh } from "./telar-refresh";

export type ChatPatch =
  | { title: string }
  | { archived: boolean }
  | { settled: boolean }
  | { snoozeUntil: number | null }
  | { read: boolean };

// SCOPED, never a bare `new Event("telar:refresh")`. A detail-less event is the
// legacy "invalidate everything" spelling (refreshIncludes returns true for
// EVERY domain when there is no detail), which means each settle/snooze/read —
// gestures the inbox invites you to make constantly — would also force an
// immediate `/api/ultra` poll via ultra-dock-signal's `schedule(0)`, plus a
// looms and projects refetch. Nothing here touches any of those: these writes
// change chat rows and nothing else.
function announce() {
  dispatchTelarRefresh({ domains: ["chats"] });
}

/**
 * PATCH one chat. Resolves to whether the write landed — callers that show an
 * error (a snooze instant the server rejected as past, say) can branch on it;
 * the fire-and-forget ones can ignore it exactly as they do today.
 */
export async function patchChat(id: string, patch: ChatPatch): Promise<boolean> {
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    // Best-effort: the refresh below reflects whatever actually persisted.
    return false;
  } finally {
    announce();
  }
}

export async function deleteChat(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  } finally {
    announce();
  }
}
