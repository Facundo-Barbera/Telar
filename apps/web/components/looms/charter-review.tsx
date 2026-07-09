"use client";

import { useCallback, useState } from "react";
import { Loader2Icon } from "lucide-react";
import type { Loom } from "@telar/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CharterPanel } from "./charter-panel";

// In-flight draft — no polling of its own. The page's SSE loop re-renders
// `loom` and this unmounts itself the moment state moves off "scoping".
export function ScopingCharter() {
  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <Card size="sm">
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Drafting the charter…
        </CardContent>
      </Card>
      <p className="px-1 pt-3 text-sm text-muted-foreground">
        A live agent is scoping this goal — proof strategy, budget, and (for
        larger work) a decomposition into sub-goals. This costs tokens.
      </p>
    </div>
  );
}

export function CharterReview({ loom }: { loom: Loom }) {
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On success, leave `approving=true` — the button stays in its loading
  // state until the page's own SSE stream flips loom.state away from
  // "charter-review", at which point the page's gate unmounts this component.
  const approve = useCallback(async () => {
    setApproving(true);
    setError(null);
    try {
      const res = await fetch(`/api/looms/${loom.id}/charter/approve`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't approve the charter.");
      }
      window.dispatchEvent(new Event("telar:refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setApproving(false);
    }
  }, [loom.id]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
      <div className="space-y-1 px-1">
        <h2 className="text-sm font-medium">Review the charter</h2>
        <p className="text-sm text-muted-foreground">
          Telar scoped this goal into the plan below. Approve to start the
          verified build.
        </p>
      </div>

      <CharterPanel charter={loom.charter} />

      {error && <p className="px-1 text-sm text-destructive">{error}</p>}

      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-xs text-muted-foreground">
          Approving starts the verified build — the Verifier still gates
          completion.
        </p>
        <Button onClick={approve} disabled={approving || !loom.charter}>
          {approving && <Loader2Icon className="animate-spin" />}
          Approve charter
        </Button>
      </div>
    </div>
  );
}
