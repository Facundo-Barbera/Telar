"use client";

/**
 * THE APPROVAL THE AGENT IS PARKED ON (#531).
 *
 * ── WHY THIS IS NOT `ApprovalCard` ──────────────────────────────────────────
 * It looks the same on purpose and it is a different component on purpose, and
 * the reason is one button. A session's approval offers Allow once / Always
 * allow / Deny, and `acceptForSession` is exactly what its name says — this
 * session, no glob, no persistence past it.
 *
 * THE AGENT HAS NO SESSION TO SCOPE AN "ALWAYS" TO. Its gate is argument-aware
 * and decided per call (`agent/approval.ts`): `sessions_send` with `intent:
 * task` needs approval, the same tool reporting does not. There is nothing for
 * a blanket permission to attach to, and `POST /v2/agent/requests/:id` takes
 * `accept` or `decline` and nothing else.
 *
 * So the choice is between a third button that no route could honour and a card
 * that offers two. A button that lies about how much rope was handed over is
 * the worst thing to put on the one screen where a person is deciding exactly
 * that — the frozen app's own note on `ApprovalCard` makes the same argument
 * about printing a rule it does not enforce.
 *
 * WHAT IS SHARED IS THE GRAMMAR, not the code: the same warning tone, the same
 * mono eyebrow over a verb, the same inset box for the argument, the same order.
 * `--warning` and not `--destructive`, because a request is a QUESTION — red
 * would say the Agent had failed, which turns a routine confirmation into an
 * alarm.
 *
 * THE REASON IS THE ENGINE'S OWN SENTENCE, written where the gate is and
 * carried whole on the request. A second copy of "what does `sessions_stop`
 * mean" here would be the one that goes stale.
 */

import { ShieldIcon } from "lucide-react";
import { displayToolName, type AgentRequest } from "@telar/engine-client";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { CodeSurface } from "@/components/ui/code-surface";
import { cn } from "@/lib/utils";

/** The arguments, as the thing a person is actually being asked about. Pretty
 *  JSON rather than a summary: the whole point of an argument-aware gate is
 *  that WHICH call it is matters, and a summary is where that gets lost. */
export function approvalArgument(args: Record<string, unknown>): string | undefined {
  const keys = Object.keys(args);
  if (keys.length === 0) return undefined;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    // A value that will not serialise (a cycle, a BigInt) is not worth failing
    // the card over — the verb and the reason still say what is being asked.
    return undefined;
  }
}

export function AgentApproval({
  request,
  sending,
  onDecide,
}: {
  request: AgentRequest;
  sending: boolean;
  onDecide: (requestId: string, decision: "accept" | "decline") => void;
}) {
  const argument = approvalArgument(request.args);
  return (
    <section className={cn(cardSurface(), "flex flex-col gap-3 border-warning/40 bg-warning/5 p-4")} aria-label="Approval required">
      <p className="font-mono text-3xs tracking-wide text-muted-foreground uppercase">tool call</p>

      <p className="flex items-center gap-1.5 text-sm font-medium">
        <ShieldIcon className="size-3.5 shrink-0 text-warning" />
        {/* `sessions_send`, not the qualified name. The long form is
            addressing; a human being asked to permit something reads the verb. */}
        {displayToolName(request.tool)}
      </p>

      {/* THE ENGINE'S OWN SENTENCE, specific to this call. */}
      {request.reason && <p className="text-sm text-muted-foreground">{request.reason}</p>}

      {argument && <CodeSurface text={argument} wrap tone="foreground" />}

      <div className="flex flex-wrap items-stretch gap-2">
        <Button size="sm" disabled={sending} onClick={() => onDecide(request.id, "accept")}>
          Allow
        </Button>
        <Button variant="ghost" size="sm" disabled={sending} onClick={() => onDecide(request.id, "decline")} className="text-destructive hover:text-destructive">
          Deny
        </Button>
      </div>
    </section>
  );
}
