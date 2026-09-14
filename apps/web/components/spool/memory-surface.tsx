"use client";

/**
 * WHAT THE SPOOL REMEMBERS — and the one gesture that can correct it.
 *
 * ── WHY THIS SURFACE HAD TO EXIST ────────────────────────────────────────────
 * Memory was a blob rewritten wholesale by whichever pass ran last, so nothing
 * in it could be addressed, attributed or retracted. Sitting on disk in the
 * aurora digest, verbatim:
 *
 *   "Aurora has no locally reachable codebase or tracker from this Telar-vnext
 *    workspace — searched thoroughly this time."
 *
 * An agent telling its future self not to look, with no verb that could remove
 * it. The store now has that verb; without a screen it would still be
 * unreachable, and a retraction path nobody can walk is not a retraction path.
 *
 * ── RETIRED FACTS ARE SHOWN, NOT HIDDEN ──────────────────────────────────────
 * "No deletion path. Dismissing drains." A drained fact keeps its reason and
 * stays legible — hiding it here would make retirement indistinguishable from
 * the deletion this store refuses. It is dimmed and struck, and it says why.
 *
 * ── AND THE KINDS ARE THE POINT, NOT DECORATION ──────────────────────────────
 * `person` is the one an agent may never retire, because nobody but the user
 * can confirm who is involved and how. `environment` is a CACHE — the aurora
 * note's kind — and reads differently for exactly that reason.
 */
import { useCallback, useEffect, useState } from "react";
import { BrainIcon, CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import type { SpoolMemoryFact } from "@telar/engine-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type MemoryView = { subjects: Array<{ key: string; facts: SpoolMemoryFact[] }>; self: SpoolMemoryFact[] };

/**
 * HOW LONG A FACT IS GOOD FOR, and who may correct it — said in the user's
 * words rather than the schema's. These four are not invented: they are the
 * four already mixed into one array on disk with one volatility between them.
 */
const KIND: Record<SpoolMemoryFact["kind"], { label: string; hint: string }> = {
  howItWorks: { label: "how it works", hint: "Checkable against the code — goes stale when the code moves." },
  person: { label: "person", hint: "Only you can confirm this. No agent may retire it." },
  decision: { label: "decision", hint: "What was decided, and why." },
  environment: { label: "reachable now", hint: "A cache, not a memory. Expires." },
};

function Fact({ fact, scope, onChanged }: { fact: SpoolMemoryFact; scope?: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState("");
  const [error, setError] = useState<string | null>(null);

  const judge = useCallback(
    async (patch: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/spool/memory/${encodeURIComponent(fact.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(scope ? { subject: scope } : {}), ...patch }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
        }
        setAsking(false);
        setWhy("");
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [fact.id, onChanged, scope],
  );

  return (
    <li className="group/fact rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50">
      <p className={cn("text-xs leading-relaxed", fact.retired ? "text-muted-foreground/50 line-through" : "text-foreground")}>
        {fact.text}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-3xs text-muted-foreground/60">
        <span title={KIND[fact.kind].hint}>{KIND[fact.kind].label}</span>
        {/* PROVENANCE, which the old blob could not carry: every fact wore the
            timestamp of the most recent pass, including one learned long before. */}
        <span className="font-mono">{fact.source.pass}</span>
        {fact.reviewed ? (
          <span className="text-success">confirmed</span>
        ) : (
          !fact.retired && <span className="text-spool">an agent said this</span>
        )}
        {fact.verifiedAt && <span className="font-mono">checked @{fact.verifiedAt.slice(0, 7)}</span>}
      </div>

      {fact.retired && (
        <p className="mt-1 text-3xs leading-relaxed text-muted-foreground/60">
          Drained {fact.retired.at} — {fact.retired.why}
        </p>
      )}

      {!fact.retired && !asking && (
        <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/fact:opacity-100 group-focus-within/fact:opacity-100">
          {!fact.reviewed && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-3xs text-muted-foreground hover:text-foreground"
              disabled={busy}
              onClick={() => void judge({ reviewed: true })}
            >
              <CheckIcon className="size-3" />
              That&rsquo;s right
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-3xs text-muted-foreground hover:text-foreground"
            disabled={busy}
            onClick={() => setAsking(true)}
          >
            <XIcon className="size-3" />
            Not any more
          </Button>
        </div>
      )}

      {/* THE REASON IS REQUIRED, and the field says so rather than the button
          failing. A drained fact keeps its reason forever; a blank one turns
          the record of why something stopped being true into a shrug. */}
      {asking && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Input
            autoFocus
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && why.trim()) void judge({ retire: { why: why.trim() } });
              if (e.key === "Escape") setAsking(false);
            }}
            placeholder="What stopped being true?"
            aria-label="What stopped being true?"
            className="h-7 text-xs md:text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0"
            disabled={busy || !why.trim()}
            onClick={() => void judge({ retire: { why: why.trim() } })}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : "Drain"}
          </Button>
        </div>
      )}

      {error && <p className="mt-1 text-3xs leading-relaxed text-destructive">{error}</p>}
    </li>
  );
}

export function MemorySurface() {
  const [memory, setMemory] = useState<MemoryView | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/spool/memory");
      setMemory(res.ok ? await res.json() : null);
    } catch {
      setMemory(null);
    }
  }, []);

  useEffect(() => {
    // Deferred to a task, like every other read in this app the server could not
    // have performed — a synchronous fetch-and-setState on mount cascades.
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  const groups = [
    ...(memory?.subjects ?? []).map((s) => ({ key: s.key, label: s.key, facts: s.facts, scope: s.key })),
    /** The front door's own. It had NO memory at all until now, which is why
     *  "ask where I stopped" was a tool-calling expedition rather than a read. */
    { key: "__self", label: "Across everything", facts: memory?.self ?? [], scope: undefined },
  ].filter((g) => g.facts.length > 0);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <p className="text-2xs leading-relaxed text-muted-foreground/70">
          What it has learned. Nothing here is deleted — draining keeps the note and the reason, and takes it out of
          what the experts read.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {memory === undefined && <p className="px-2 py-1.5 text-xs text-muted-foreground/60">Reading…</p>}
        {memory === null && <p className="px-2 py-1.5 text-xs text-muted-foreground/60">Memory could not be read.</p>}
        {memory && groups.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <BrainIcon className="size-5 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground/60">Nothing remembered yet.</p>
            <p className="max-w-52 text-2xs leading-relaxed text-muted-foreground/50">
              An expert writes here the first time it reads something on a subject.
            </p>
          </div>
        )}
        {groups.map((group) => (
          <section key={group.key} className="mb-2">
            <p className="px-2 pt-1 pb-1 text-3xs font-medium tracking-wider text-muted-foreground/70 uppercase">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.facts.map((fact) => (
                <Fact key={fact.id} fact={fact} scope={group.scope} onChanged={() => void load()} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
