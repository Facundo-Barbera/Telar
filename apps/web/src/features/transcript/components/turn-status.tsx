"use client";

import { useNow } from "@/ui/hooks/use-now";
import {
HourglassIcon,TriangleAlertIcon
} from "lucide-react";
import { type RateLimitType, type TurnFailureCode } from "@telar/engine-client";
import { Shimmer } from "@/components/ui/shimmer";
import { cn } from "@/lib/utils";


export function Marker({ children, attention }: { children: React.ReactNode; attention?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="h-px flex-1 bg-border" />
      <span
        className={cn(
          "flex max-w-[80%] items-center gap-1.5 rounded-full border border-dashed px-2.5 py-0.5 text-center font-mono text-4xs",
          attention ? "border-warning/40 text-warning" : "border-border text-muted-foreground",
        )}
      >
        {attention && <TriangleAlertIcon className="size-3" />}
        {children}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function TurnFailureRow({
  failure,
  code,
  resumeAt,
  limitType,
  onResume,
  resuming,
}: {
  failure: string;
  code?: TurnFailureCode;
  resumeAt?: number;
  limitType?: RateLimitType;
  onResume?: () => void;
  resuming?: boolean;
}) {
  // A limit with no reset time cannot promise one, so it falls back to the
  // ordinary marker rather than rendering "resets at Invalid Date".
  if (code !== "rate_limited" || resumeAt === undefined) return <Marker attention>{failure}</Marker>;
  const resets = new Date(resumeAt);
  const sameDay = resets.toDateString() === new Date().toDateString();
  const at = sameDay
    ? resets.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : resets.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  // `other` names nothing a person can act on, so it earns no parenthetical —
  // the same rule `titleForProviderWait` follows in the engine.
  const limit = limitType && limitType !== "other" ? `${limitType.replaceAll("_", " ")} ` : "";
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-0.5 text-xs text-muted-foreground">
      <HourglassIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        Waiting for the {limit}limit to reset at {at}
      </span>
      {onResume && (
        <button
          type="button"
          disabled={resuming}
          onClick={onResume}
          className="shrink-0 rounded-md border border-border px-2 py-0.5 text-2xs text-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {resuming ? "Resuming…" : "Resume now"}
        </button>
      )}
    </div>
  );
}

/** Seconds of silence before the indicator flips to its long-silence state. */
const SILENCE_THRESHOLD = 20;

const formatElapsed = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;

export function WorkingIndicator({
  label,
  startedAt,
  lastActivityAt,
  delegated,
  compacting,
}: {
  label: string;
  startedAt?: number;
  /** When anything last happened on this turn. Absent means nothing has yet. */
  lastActivityAt?: number;
  /** Sub-agents are carrying this turn. A quiet main loop is then the CORRECT
   *  state rather than a stalled one. */
  delegated?: boolean;
  /** The provider is squeezing its context. Silence is what a compaction IS —
   *  see `isCompacting`. */
  compacting?: boolean;
}) {
  const now = useNow(1_000);
  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const quiet = lastActivityAt ? Math.max(0, Math.floor((now - lastActivityAt) / 1000)) : elapsed;
  // A fan-out mid-flight is the loudest thing in the session; the main loop is
  // silent because it is waiting on purpose, which is not a warning. A
  // compaction is the same case with nothing to show at all: it emits no items
  // by construction and routinely runs past thirty seconds, so warning on it
  // would mean warning on every compaction — the readout would be noise exactly
  // where it is supposed to mean "stuck".
  const silent = !delegated && !compacting && quiet >= SILENCE_THRESHOLD;

  return (
    <div className={cn("flex items-center gap-2 text-2xs text-muted-foreground/70", silent && "text-warning/80")}>
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full motion-safe:animate-pulse", silent ? "bg-warning" : "bg-muted-foreground/50")}
      />
      <Shimmer as="span" className={cn("text-2xs", silent && "text-warning/80")}>
        {label}
      </Shimmer>
      <span className="shrink-0 font-mono tabular-nums">{formatElapsed(elapsed)}</span>
      {/* A run that has said nothing for 20s is the case a detached session most
          needs surfaced — it is the difference between slow and stuck. */}
      {silent && <span className="shrink-0 font-mono tabular-nums text-warning">· no output {formatElapsed(quiet)}</span>}
    </div>
  );
}
