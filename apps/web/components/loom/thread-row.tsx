"use client";

/**
 * THE LOOMS PLACE'S SHARED VOCABULARY — thread status, tier, and verification,
 * spelled ONCE and in the app's own language.
 *
 * A loom thread IS a session, so its liveness must read exactly like a session
 * row's: the same `activityBadge` words ("Working", "Waiting on you"), the
 * same spinner-for-alive / dot-for-parked marks, the same `ACTIVITY_TONE`
 * colours, the same ticking duration. Before this file, looms spoke a second
 * dialect for facts the rest of the app already had words for — coloured dots
 * and mono strings — and the place read as a different product because it was
 * literally written like one.
 */
import { useEffect, useState } from "react";
import { CircleDashedIcon, CircleDotIcon } from "lucide-react";
import type { SessionActivity } from "@telar/engine-client";
import { Badge } from "@/components/ui/badge";
import { fmtAgo } from "@/lib/format";
import { ACTIVITY_TONE, activityBadge, fmtDuration } from "@/lib/session-activity";

/** What the looms APIs report about a thread's live session. */
export interface ThreadLiveness {
  activity?: SessionActivity;
  activityAt?: number | null;
  updatedAt?: number;
}

/** Same 5s cadence and same reasoning as session-row's ticking duration: a
 *  frozen "Working 3m" is a wrong claim about the present. */
function TickingDuration({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 5_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <span className="tabular-nums">{fmtDuration(startedAt, now)}</span>;
}

/**
 * The right-hand slot: the status when there is one, the age otherwise — one
 * slot, never both, exactly as `rowStatusText` renders a session row.
 */
export function ThreadStatusSlot({ live }: { live: ThreadLiveness | null }) {
  if (!live?.activity) {
    return <span className="shrink-0 text-[11px] text-muted-foreground">unreachable</span>;
  }
  const badge = activityBadge(live.activity);
  if (!badge) {
    return (
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {live.updatedAt ? fmtAgo(live.updatedAt) : "idle"}
      </span>
    );
  }
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-[11px] font-medium ${ACTIVITY_TONE[badge.tone]}`}>
      {badge.ticking ? (
        <CircleDashedIcon className="size-3 animate-spin [animation-duration:3s]" />
      ) : badge.tone === "attention" ? (
        <CircleDotIcon className="size-3" />
      ) : null}
      <span role="status">{badge.label}</span>
      {badge.ticking && live.activityAt ? <TickingDuration startedAt={live.activityAt} /> : null}
    </span>
  );
}

export type LoomDisplayStateName = "waiting" | "working" | "idle" | "verifying" | "ready" | "accepted";

/** The loom's state chip on the five-token vocabulary, as a Badge like
 *  everywhere else a state is worn in this app. */
export function LoomStateBadge({ state }: { state: LoomDisplayStateName }) {
  const tone: Record<LoomDisplayStateName, string> = {
    waiting: "text-warning",
    working: "text-info",
    idle: "text-muted-foreground",
    verifying: "text-verify",
    ready: "text-success",
    accepted: "text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={`font-mono text-[10px] uppercase tracking-wide ${tone[state]}`}>
      {state}
    </Badge>
  );
}

/** The tier is the contract's executable half; its absence is a warning, not a
 *  blank. Both render as the system's own Badge. */
export function TierBadge({ tier }: { tier?: string }) {
  return tier ? (
    <Badge variant="outline" className="font-mono text-[10px] uppercase text-verify">
      {tier}
    </Badge>
  ) : (
    <Badge variant="outline" className="font-mono text-[10px] uppercase text-warning" title="No executable tier backs this contract">
      no tier
    </Badge>
  );
}

/** Verification evidence in one badge: which tier, which colour, which commit. */
export function VerificationBadge({
  verification,
}: {
  verification?: { tier: string; ok: boolean; commit?: string };
}) {
  if (!verification) return null;
  return (
    <Badge variant="outline" className={`font-mono text-[10px] ${verification.ok ? "text-success" : "text-destructive"}`}>
      {verification.tier} {verification.ok ? "green" : "red"}
      {verification.commit ? ` @ ${verification.commit.slice(0, 7)}` : ""}
    </Badge>
  );
}

/** The leading-edge hairline a live session row wears, as a class. Same rule:
 *  colour only when something is happening; a resting row is unmarked. */
export function statusHairline(live: ThreadLiveness | null): string {
  const badge = live?.activity ? activityBadge(live.activity) : null;
  if (!badge) return "";
  return `before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full ${
    badge.tone === "attention" ? "before:bg-warning" : "before:bg-primary"
  }`;
}
