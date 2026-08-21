"use client";

/**
 * THE LEDGER — one of the four segments of `/looms/[projectId]`.
 *
 * A TICK HAS NO TRANSCRIPT. It is a fresh instance every time and remembers
 * nothing, which is the entire reason cost does not ramp with uptime — so
 * "what did it do at 3am" has no chat to open, and offering one would be an
 * affordance with nothing behind it. This append-only journal is what an agent
 * that deliberately does not remember leaves behind.
 *
 * One line per thing that happened, newest last, in the words it was written
 * in. Deliberately coarse: read by a person, not a metrics stream.
 */

import { useState } from "react";
import type { LedgerEntry } from "@telar/engine-client";
import { useLoomLedger } from "@/lib/loom-overview";

export function LoomLedger({ projectId }: { projectId?: string }) {
  const { entries, loading } = useLoomLedger(projectId, true);

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-1 px-4 py-3">
        {!projectId ? (
          <p className="text-[11px] text-muted-foreground">No project selected.</p>
        ) : loading && entries.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Reading the ledger…</p>
        ) : entries.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Nothing yet. A tick appends here.</p>
        ) : (
          entries.map((entry, index) => <LedgerRow key={`${entry.at}:${index}`} entry={entry} />)
        )}
      </div>
    </div>
  );
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-border/60 bg-card px-2 py-1">
      <button
        type="button"
        disabled={!entry.detail}
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-2 text-left"
      >
        <span className="w-12 shrink-0 font-mono text-[10px] text-muted-foreground/60">{entry.kind}</span>
        {/* THE ENGINE'S OWN SENTENCE, WHOLE. A summary cut down to a code is
            the one thing this record exists not to be. */}
        <span className="min-w-0 flex-1 text-[11px] leading-relaxed">{entry.summary}</span>
        {entry.item && (
          <span className="max-w-[6rem] shrink-0 truncate font-mono text-[10px] text-muted-foreground/50">
            {entry.item}
          </span>
        )}
      </button>
      {open && entry.detail && (
        <p className="mt-1 border-l border-border/60 pl-2 text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {entry.detail}
        </p>
      )}
    </div>
  );
}
