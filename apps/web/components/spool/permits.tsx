"use client";

/**
 * WHAT MAY HAPPEN ON THIS SUBJECT UNATTENDED — §7.6, made visible.
 *
 * ── WHY IT NEEDS A CONTROL AT ALL ────────────────────────────────────────────
 * A permission level nobody can see or change is invisible policy. And this one
 * is not a preference waiting for a feature: `read` gates `needsRipening` and
 * `draft` gates `needsDrafting`, so lowering a subject stops the night working
 * it TONIGHT. `docs/spool-definition.md` §7.6 calls it "the mechanism that makes
 * §3.1 enforceable rather than advisory" — without a way to set it, it is a
 * sentence in a document.
 *
 * ── WHY IT IS NOT A BADGE ────────────────────────────────────────────────────
 * It counts nothing and reports no state you must attend to; it is a standing
 * grant you made. So it renders like the queue's other quiet chips — an outline
 * that says a word — and never in a status colour. Nothing here goes red.
 *
 * ── AND WHY `propose` IS OFFERED BUT SAYS SO ─────────────────────────────────
 * The level exists in the vocabulary because §3.1 turns on it, and no code path
 * reaches it yet. Hiding it would mean discovering the vocabulary later as a
 * boolean; offering it silently would promise something that does not happen.
 * So it is offered and labelled as not yet reachable.
 */
import { useCallback, useState } from "react";
import { ChevronDownIcon, Loader2Icon } from "lucide-react";
import type { SpoolSubjectPermits } from "@telar/engine-client";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** The user's words for each grant, and what it actually gates. */
const LEVELS: Array<{ value: SpoolSubjectPermits; label: string; blurb: string }> = [
  { value: "read", label: "may read", blurb: "Turns your shorthand into a brief. Proposes nothing." },
  { value: "draft", label: "may draft", blurb: "Also proposes an approach for what it understands." },
  { value: "propose", label: "may propose", blurb: "Also opens a pull request — nothing reaches this yet." },
];

export function PermitsChip({
  subject,
  permits,
  onChanged,
}: {
  subject: string;
  permits: SpoolSubjectPermits;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = LEVELS.find((l) => l.value === permits) ?? LEVELS[1]!;

  const set = useCallback(
    (next: SpoolSubjectPermits) => {
      if (next === permits) return;
      setBusy(true);
      setError(null);
      void fetch(`/api/spool/subjects/${encodeURIComponent(subject)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permits: next }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
          }
          onChanged();
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false));
    },
    [onChanged, permits, subject],
  );

  return (
    <span className="flex items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              title={`What may happen on ${subject} unattended`}
              className="h-5 gap-1 rounded-sm border border-border px-1.5 text-[10px] font-normal text-muted-foreground hover:text-foreground"
            />
          }
        >
          {busy ? <Loader2Icon className="size-2.5 animate-spin" /> : null}
          {current.label}
          <ChevronDownIcon className="size-2.5 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {LEVELS.map((level) => (
            <DropdownMenuItem key={level.value} onClick={() => set(level.value)}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={level.value === permits ? "font-medium text-foreground" : undefined}>
                  {level.label}
                </span>
                <span className="text-[10px] leading-relaxed text-muted-foreground">{level.blurb}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <span className="text-[10px] text-destructive">{error}</span>}
    </span>
  );
}
