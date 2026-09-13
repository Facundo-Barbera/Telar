"use client";

/**
 * THE SEARCH IN THE ROOM — `docs/spool-loops.md` §10.2.
 *
 * One deterministic, LEXICAL search over everything the Spool holds — items,
 * threads, notes, observations. No embeddings, honestly: Telar does not
 * support external embedding models, so the engine tokenizes, folds
 * diacritics and weighs fields, and this control renders exactly that hit
 * list. There is no similarity score to dress up as understanding, and no
 * model call anywhere on this path.
 *
 * LIGHT, DELIBERATELY: an input in the toolbar and a quiet dropdown, not a
 * command palette. An EMPTY QUERY IS NOTHING — no zero-state lecture, no
 * "try searching for…" — because an empty box is a person not asking yet.
 * Esc or leaving the control closes it. A hit does what its kind means:
 * an item opens its packet in the tray, a note opens the note face, a
 * thread or observation opens its subject's face — the caller wires those,
 * this control only says which hit was chosen.
 *
 * CLOSED THINGS ARE FOUND AND MARKED, dimmed with the word beside them —
 * the engine ranks them below open ones, and hiding them here would be a
 * delete path wearing a filter's name.
 */
import { useEffect, useState } from "react";
import type { SpoolSearchHit } from "@telar/engine-client";
import { SidebarSearchField } from "@/components/sidebar-search-field";
import { cn } from "@/lib/utils";

/** Render order and headers — the kinds in the store's own vocabulary. */
const KINDS: Array<{ kind: SpoolSearchHit["kind"]; header: string }> = [
  { kind: "item", header: "Items" },
  { kind: "thread", header: "Threads" },
  { kind: "note", header: "Notes" },
  { kind: "observation", header: "Observations" },
];

export function SpoolSearchControl({ onHit }: { onHit: (hit: SpoolSearchHit) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SpoolSearchHit[]>([]);
  const [open, setOpen] = useState(false);

  /**
   * Debounced by a task, never an interval — the room holds no timer that
   * polls anything; this one only spaces out keystrokes already made.
   */
  useEffect(() => {
    const q = query.trim();
    // Empty is handled where it is typed (the change handler clears hits) —
    // a synchronous setState here would be a cascading render, and this app
    // lints it.
    if (!q) return;
    const task = window.setTimeout(() => {
      void fetch(`/api/spool/search?q=${encodeURIComponent(q)}`)
        .then((res) => (res.ok ? res.json() : { hits: [] }))
        .then((data) => setHits((data.hits ?? []) as SpoolSearchHit[]))
        .catch(() => undefined);
    }, 200);
    return () => window.clearTimeout(task);
  }, [query]);

  const showing = open && query.trim() !== "" && hits.length > 0;

  return (
    <div
      className="relative"
      /* Leaving the control closes it — but a click INSIDE the dropdown is
         not leaving, so the check is against where focus went. */
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      {/* THE FIELD'S CHROME IS SHARED WITH TELAR'S OWN — see
          `sidebar-search-field.tsx`. Only the behaviour stays Spool's own:
          it opens on focus/typing rather than on ⌘K, which stays unbound
          here (Telar's binding is Telar's alone). */}
      <SidebarSearchField
        value={query}
        onChange={(event) => {
          const next = event.target.value;
          setQuery(next);
          setOpen(true);
          // An empty query IS nothing — the stale hits go with the words.
          if (!next.trim()) setHits([]);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search the Spool…"
        aria-label="Search the Spool"
      />
      {showing && (
        <div
          /* Anchored to the INPUT'S LEFT EDGE, not its right — that edge is
             always onscreen (it's where the query is typed), where the
             control's own right edge is not: in the narrow warehouse rail
             the old `right-0` aligned the panel's right side to a narrow
             input and let a fixed `w-96` hang off past the viewport's left
             edge. `min-w` no wider than the input needs, `max-w-sm` so nothing
             this wide ever needs a negative offset to stay onscreen. */
          className="absolute top-full left-0 z-20 mt-1 max-h-80 min-w-56 max-w-sm overflow-y-auto rounded-xl bg-card p-1.5 shadow-3 ring-1 ring-foreground/10"
        >
          {KINDS.map(({ kind, header }) => {
            const group = hits.filter((h) => h.kind === kind);
            if (group.length === 0) return null;
            return (
              <div key={kind}>
                <p className="px-2 pt-1.5 pb-0.5 text-[0.625rem] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
                  {header}
                </p>
                <ul>
                  {group.map((hit) => (
                    <li key={`${hit.kind}:${hit.id}`}>
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          setQuery("");
                          onHit(hit);
                        }}
                        className="block w-full min-w-0 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-xs font-medium",
                              hit.closed ? "text-muted-foreground/50" : "text-foreground",
                            )}
                          >
                            {hit.title}
                          </span>
                          {/* Over, in its own vocabulary, and still findable —
                              a word and a dimming, never a hiding. */}
                          {hit.closed && <span className="shrink-0 text-[0.625rem] text-muted-foreground/50">· over</span>}
                          {hit.subject && (
                            <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground/60">{hit.subject}</span>
                          )}
                        </span>
                        <span
                          className={cn(
                            "block min-w-0 truncate text-[0.6875rem] leading-relaxed",
                            hit.closed ? "text-muted-foreground/40" : "text-muted-foreground",
                          )}
                        >
                          {hit.snippet}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
