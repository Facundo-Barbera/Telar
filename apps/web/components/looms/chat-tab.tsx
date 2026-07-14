"use client";

import { useEffect, useState } from "react";
import type { Loom } from "@telar/core"; // type-only — client-safety boundary
import { SessionView, type InitialChat } from "@/components/session/session-view";

// The loom Chat tab: a loom-aware STEERING session. Reuses SessionView wholesale
// (exactly as /looms/plan/[project] reuses it for planning), wired with
// `steerer loomId` so route.ts binds the session to this loom, pre-loads its
// live context, and grants the steer/reject/resume/cancel/watch tools — but
// NEVER an accept path (the moat). Acceptance stays a human click in the rail.
export function ChatTab({ loom }: { loom: Loom }) {
  // undefined = loading; null = no prior steerer chat (start fresh); InitialChat
  // = resume the most-recent steerer session for this loom (cross-reload cont.).
  const [seed, setSeed] = useState<InitialChat | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    fetch(`/api/looms/${loom.id}/chat`)
      .then((r) => r.json())
      .then((d) => alive && setSeed(d.chat ?? null))
      .catch(() => alive && setSeed(null));
    return () => {
      alive = false;
    };
  }, [loom.id]);

  if (seed === undefined) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    // Bounded height so SessionView's flex column fits the tab; it fills the
    // left grid column (minmax(0,1fr)). The offset accounts for the cockpit
    // chrome (page padding + tab strip).
    <div className="flex h-[calc(100dvh-13rem)] min-h-[32rem] flex-col overflow-hidden rounded-lg border">
      <SessionView
        project={loom.project}
        account={loom.account}
        // Minimal seed — SessionView hydrates the full registry via useAccounts().
        accounts={[{ name: loom.account }]}
        steerer
        // Chrome-light: the loom cockpit header already carries identity, so the
        // embedded chat drops the standalone back button / identity header /
        // account+usage bar (critique 1.7) — transcript + composer only.
        embedded
        loomId={loom.id}
        {...(seed ? { initialChat: seed, routeSessionId: seed.id } : {})}
      />
    </div>
  );
}
