"use client";

import { useEffect, useState } from "react";
import { MessagesSquareIcon } from "lucide-react";
// Client-safety: type-only from @telar/core (this is a "use client" file).
import type { Loom } from "@telar/core";
import { Button } from "@/components/ui/button";
import { SessionView, type InitialChat } from "@/components/session/session-view";
import {
  BlockedAnswerForm,
  ParkExplanation,
} from "@/components/looms/blocked-escalation";

// M11.3 — the conversational-escalation surface for a loom parked in `blocked`
// (docs/adaptive-verification.md §8). LEADS with the park explanation + a
// prominent "Discuss with the orchestrator" chat; keeps the quick answer form as
// the SECONDARY "I already know the command" path. Both write paths converge on
// the SAME core answerBlocked (same accept-guard, same persist tiers, same
// server-bound human `by`) — the chat's write is the human-gated answer_blocked
// tool, the form's is POST /block/answer.
//
// HARD REQUIREMENT (non-negotiable): a FRESH conversation never auto-starts —
// no session is created, no agent turn runs, no tokens are spent until the
// human clicks "Discuss with the orchestrator" for the first time. But an
// escalation chat now PERSISTS with role:"escalation" (store.ts's Chat.role)
// exactly like the loom Chat tab's steerer session does, so once the human has
// opened it, navigating away and back REATTACHES that same conversation instead
// of losing it — `seed` below fetches the loom's most-recent escalation chat on
// mount (GET /api/looms/[id]/chat?role=escalation, chat-tab.tsx's own pattern)
// and a non-null result opens the surface already-discussing with that
// transcript, no re-click required. This is resuming what the human already
// began (and already spent tokens on), never starting something new on its own.
export function DiscussEscalation({ loom }: { loom: Loom }) {
  // undefined = still checking for a prior discussion; null = none found (stay
  // closed, gated behind the click, per the HARD REQUIREMENT above); InitialChat
  // = a prior discussion exists for this loom — reattach it below.
  const [seed, setSeed] = useState<InitialChat | null | undefined>(undefined);
  const [discussing, setDiscussing] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/looms/${loom.id}/chat?role=escalation`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setSeed(d.chat ?? null);
      })
      .catch(() => {
        if (alive) setSeed(null);
      });
    return () => {
      alive = false;
    };
  }, [loom.id]);

  const open = discussing || !!seed;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
      <ParkExplanation loom={loom} />

      {/* Primary path: talk it through with the orchestrator. */}
      {open ? (
        // Bounded height so SessionView's flex column fits; mirrors the loom
        // Chat tab's embedding (chat-tab.tsx). `seed` (when present) reattaches
        // the loom's existing escalation chat instead of starting fresh — see
        // the HARD REQUIREMENT note above. On a genuinely fresh open (no seed)
        // SessionView auto-fires a single hidden kickoff turn (M11 finding-1)
        // so the agent OPENS with a real verification proposal; every turn
        // sends role:"escalation"+loomId regardless.
        <div className="flex h-[calc(100dvh-24rem)] min-h-[28rem] flex-col overflow-hidden rounded-lg border">
          <SessionView
            project={loom.project}
            account={loom.account}
            // Minimal seed — SessionView hydrates the full registry via useAccounts().
            accounts={[{ name: loom.account }]}
            escalation
            // Suppress standalone chrome (back button, identity header,
            // account/usage bar, dock-minimize) — the escalation surface
            // (ParkExplanation above) already carries identity/context.
            embedded
            loomId={loom.id}
            {...(seed ? { initialChat: seed, routeSessionId: seed.id } : {})}
          />
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          {/* Disabled while the reattach check is in flight (`seed === undefined`)
              — avoids a race where a click starts a FRESH chat a beat before the
              fetch would have found an existing one to reattach instead. */}
          <Button onClick={() => setDiscussing(true)} disabled={seed === undefined}>
            <MessagesSquareIcon className="size-4" />
            Discuss with the orchestrator
          </Button>
          <p className="max-w-[62ch] text-xs text-muted-foreground">
            Open a chat to work out the verification method together. Nothing runs
            and nothing is spent until you start it. When you've settled on the
            answer, the orchestrator asks you to approve and the loom resumes.
          </p>
        </div>
      )}

      {/* Secondary path: you already know the command. */}
      <div className="flex flex-col gap-2">
        <span className="px-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
          Or answer directly
        </span>
        <BlockedAnswerForm loom={loom} />
      </div>
    </div>
  );
}
