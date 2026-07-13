"use client";

import { useState } from "react";
import { MessagesSquareIcon } from "lucide-react";
// Client-safety: type-only from @telar/core (this is a "use client" file).
import type { Loom } from "@telar/core";
import { Button } from "@/components/ui/button";
import { SessionView } from "@/components/session/session-view";
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
// HARD REQUIREMENT (non-negotiable): the chat NEVER auto-starts. No session is
// created, no agent turn runs, no tokens are spent until the human clicks
// "Discuss with the orchestrator". `discussing` starts false and resets false on
// every mount (component-local useState, no persistence, no reattach) — a user
// who navigates away and back finds the surface CLOSED unless they re-click,
// never an already-open conversation. Only after the click does the embedded
// SessionView mount (which is the first thing that can POST /api/chat).
export function DiscussEscalation({ loom }: { loom: Loom }) {
  const [discussing, setDiscussing] = useState(false);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
      <ParkExplanation loom={loom} />

      {/* Primary path: talk it through with the orchestrator. */}
      {discussing ? (
        // Bounded height so SessionView's flex column fits; mirrors the loom
        // Chat tab's embedding (chat-tab.tsx). No initialChat/routeSessionId —
        // the escalation session always starts FRESH (never reattaches a prior
        // conversation). On mount (i.e. AFTER this click) SessionView auto-fires
        // a single hidden kickoff turn (M11 finding-1) so the agent OPENS with a
        // real verification proposal; turn 1 sends role:"escalation"+loomId.
        <div className="flex h-[calc(100dvh-24rem)] min-h-[28rem] flex-col overflow-hidden rounded-lg border">
          <SessionView
            project={loom.project}
            account={loom.account}
            // Minimal seed — SessionView hydrates the full registry via useAccounts().
            accounts={[{ name: loom.account }]}
            escalation
            loomId={loom.id}
          />
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <Button onClick={() => setDiscussing(true)}>
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
