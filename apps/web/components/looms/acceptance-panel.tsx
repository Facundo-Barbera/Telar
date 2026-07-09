"use client";

import { useCallback, useState } from "react";
import { CircleCheckIcon, Loader2Icon, PencilIcon, XIcon } from "lucide-react";
import type { Loom } from "@telar/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// §A (docs/loom-model.md): a Loom never marks itself finished — the verified
// loop lands in "ready" and waits for the owner. This is the sign-off
// moment, deliberately louder than a formality: an emerald banner, a primary
// Accept action, and Steer/Reject visibly present but inert (P4).
export function AcceptancePanel({
  loom,
  onAccepted,
}: {
  loom: Loom;
  onAccepted?: (loom: Loom) => void;
}) {
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback(async () => {
    setAccepting(true);
    setError(null);
    try {
      const res = await fetch(`/api/looms/${loom.id}/accept`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? "Couldn't accept the loom.");
      }
      onAccepted?.((data as { loom: Loom }).loom);
      window.dispatchEvent(new Event("telar:refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAccepting(false);
    }
  }, [loom.id, onAccepted]);

  // Self-gated like SpecBundle: safe to mount unconditionally, only ever
  // renders for a loom actually sitting in "ready".
  if (loom.state !== "ready") return null;

  return (
    <Card className="border-l-2 border-l-emerald-500/60 bg-emerald-500/[0.04] ring-emerald-500/20">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-2.5">
          <CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-emerald-400" />
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="font-heading text-sm font-medium text-emerald-300">
                Verified — awaiting your acceptance
              </span>
              <Badge className="bg-emerald-500/15 font-mono text-[10px] text-emerald-400">
                ready
              </Badge>
            </div>
            <p className="max-w-[60ch] text-xs leading-relaxed text-muted-foreground">
              Every required thread is done, hard gates are green, and the
              critic panel&apos;s blocker lenses cleared. The loop finished
              the work while you were gone — it has shipped nothing as done
              without you. Accepting is your call, not a formality.
            </p>
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={accept}
            disabled={accepting}
            className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400 focus-visible:ring-emerald-500/50"
          >
            {accepting && <Loader2Icon className="animate-spin" />}
            Accept
          </Button>
          <Button variant="outline" disabled title="Steering — coming in P4">
            <PencilIcon />
            Steer
          </Button>
          <Button variant="outline" disabled title="Rejection — coming in P4">
            <XIcon />
            Reject
          </Button>
          <span className="text-[11px] text-muted-foreground/70">
            Steer &amp; reject — coming in P4
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
