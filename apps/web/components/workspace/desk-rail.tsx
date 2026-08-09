"use client";

// THE DESK (story 5.7, SPEC-organization-workspace CAP-3; ui-contract.md §2).
//
// The master chat's right rail, filled by the shell's `rail` slot — "one slot,
// many rails", the same seam a project session's sub-agent rail rides. Its
// contents are agent-filed items: core's `deskSlice` projection, read through
// workspace-api's `getQueueView().desk` over GET /api/workspace/queue.
//
// THREE RULES, AND THEY ARE THE WHOLE COMPONENT:
//
//  1. CARDS DO NOT MOVE. The render order is `view.desk` — the store's order —
//     and nothing here sorts, partitions or hoists. Talking about an item edits
//     it IN PLACE, so the highlight is a border on the card where it already
//     sits (`deskTouched`, in lib/desk-rail.ts, returns a SET of ids for
//     exactly this reason: a function that returned a list could reorder one).
//
//  2. DISMISS DRAINS, IT NEVER DELETES. The ✕ PATCHes `{desk: false}` and the
//     item stays in its lane at its rank, findable in the queue. The footer
//     states that where the human can read it, per cross-surface invariant 4.
//     There is no DELETE call in this file and no DELETE route to call.
//
//  3. IT NEVER NOTIFIES. No badge, no ping, no interval. It reads on mount and
//     on `telar:refresh`, which the master chat dispatches when a turn settles
//     — i.e. it answers when arrived at, and when the conversation just changed
//     the thing it is showing.
//
// THE CHIPS ARE IMPORTED, NEVER RE-SPELLED. components/workspace/chips.tsx is
// the ONE definition site of the frozen grammar, and cross-surface invariant 1
// ("deadline, verdict, project and provenance render identically on every
// surface") is satisfied structurally by every surface importing it — so the
// project tag here is `ProjectChip`, which is also where `floating` and the
// mirrored dot-icon come from, and a deadline is `DeadlineChip`, which is where
// a self-deadline gets its dashed outline and its `· self · slid ×N`. An
// inline span that looked the same today is the drift this rule exists to stop.
//
// PORTED, NOT IMPORTED. lib/demo-gallery/workspace/home.tsx's `DeskRail` is the
// design source for the GEOMETRY (fixed rail, count in the header, dashed card
// with an amber question icon, hover ✕, footer line). The STATES are the app's:
// the prototype's `hidden … group-hover:flex` reveal is a `display:none`
// element, which cannot take focus and is not in the accessibility tree, so the
// app's opacity idiom (session-row.tsx, tab-strip.tsx, prompt-input.tsx) is
// what this file uses — the surface's only write must be reachable by keyboard.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { HelpCircleIcon, RotateCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { DeskCard } from "@telar/core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/empty-state";
import { DeadlineChip, ProjectChip } from "@/components/workspace/chips";
import { dispatchTelarRefresh, refreshIncludes, TELAR_REFRESH_EVENT } from "@/lib/telar-refresh";
import {
  applyDeskRead,
  beginDeskRead,
  beginDismiss,
  DESK_DISMISS_PATCH,
  endDismiss,
  failDeskRead,
  failDismiss,
  INITIAL_DESK_STATE,
  type DeskView,
} from "@/lib/desk-rail";
import { cn } from "@/lib/utils";

function DeskCardRow({
  card,
  touched,
  busy,
  onDismiss,
}: {
  card: DeskCard;
  touched: boolean;
  busy: boolean;
  onDismiss: () => void;
}) {
  return (
    <div
      className={cn(
        "group/desk rounded-lg border bg-card p-2.5 transition-colors",
        // The just-touched state, spelled the way StatTile spells its selected
        // one — a highlight in the workspace and a highlight on the dashboard
        // are the same visual event.
        touched ? "border-primary ring-1 ring-primary/40" : "border-border",
        card.unplaced && "border-dashed",
        busy && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        {/* Hue on the icon only: an unplaced card is a QUESTION — the one thing
            on this rail the master could not resolve — and the card body stays
            a neutral outline. */}
        {card.unplaced && <HelpCircleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />}
        <p className="min-w-0 flex-1 text-xs font-medium leading-snug">{card.title}</p>
        {/* OPACITY, NOT `hidden`. The control has to survive a Tab: a
            `display:none` button is unfocusable and invisible to a screen
            reader, which would make dismiss — this surface's only write —
            mouse-only. It is transparent until the card is hovered or the
            button itself is focused. */}
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          aria-label={`Dismiss ${card.title} — sends it to the queue, nothing is deleted`}
          title="Dismiss — sends it to the queue, nothing is deleted"
          className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/desk:opacity-100"
        >
          <XIcon className="size-3" />
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {/* THE ONE GRAMMAR. `floating` when the item has no project, the
            dot-icon ref when it is mirrored, the dashed `· self` when the
            deadline is one the human set themselves — all of it from the same
            components the queue row and the packet header render. */}
        <ProjectChip name={card.project} mirrored={card.mirrored} />
        {card.deadline && <DeadlineChip deadline={card.deadline} />}
        {card.hint && (
          <span className="truncate font-mono text-[10px] text-muted-foreground/60">
            {card.hint}
          </span>
        )}
      </div>
    </div>
  );
}

function DeskRailBody() {
  const [state, setState] = useState(INITIAL_DESK_STATE);
  // The read ticket. Reads overlap (mount, a settling turn, a dismiss), so each
  // one carries a number and the reducer decides which answer may land — see
  // applyDeskRead. A ref rather than state: nothing renders it.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setState((s) => beginDeskRead(s, seq));
    try {
      const res = await fetch("/api/workspace/queue");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as DeskView;
      setState((s) => applyDeskRead(s, seq, next));
    } catch (err) {
      setState((s) => failDeskRead(s, seq, err instanceof Error ? err.message : String(err)));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onRefresh = (e: Event) => {
      if (refreshIncludes(e, "workspace")) void load();
    };
    window.addEventListener(TELAR_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(TELAR_REFRESH_EVENT, onRefresh);
  }, [load]);

  const dismiss = useCallback(async (id: string) => {
    setState((s) => beginDismiss(s, id));
    try {
      const res = await fetch(`/api/workspace/items/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(DESK_DISMISS_PATCH),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      // Every workspace surface open right now is showing this item — the
      // queue it just drained into included.
      dispatchTelarRefresh({ domains: ["workspace"] });
    } catch (err) {
      setState((s) => failDismiss(s, err instanceof Error ? err.message : String(err)));
    } finally {
      setState(endDismiss);
    }
  }, []);

  const { view, error } = state;
  const cards = view?.desk ?? [];

  return (
    // BELOW `lg` THE RAIL IS GONE, AND THAT IS A DECISION RATHER THAN THE
    // MOCKUP'S DEFAULT (5.7's review). A fixed 18rem column beside a
    // conversation on a <1024px window leaves the transcript — the thing the
    // human came for — in a gutter. What makes it affordable is that the desk
    // is a PROJECTION, not a place: `desk: true` is one boolean on an item that
    // is simultaneously in its lane at its rank, so every card here is also a
    // row in the Queue tab and a page at /workspace/<id> at any viewport. The
    // only affordance that narrows away is dismissal, which is by construction
    // the one action that changes nothing about the item.
    <aside className="hidden w-72 shrink-0 flex-col border-l border-border bg-muted/10 lg:flex">
      <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Desk
        </span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
          {view ? cards.length : ""}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {view === null && !error && (
          <>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </>
        )}
        {/* A FAILED FIRST LOAD IS NOT AN EMPTY DESK. Without this the rail
            would render nothing but a line of red at the bottom of a scroll
            container and read as "the desk is clear" — the sibling surfaces'
            idiom (queue-view.tsx) is the shared EmptyState plus a retry. */}
        {view === null && error && (
          <EmptyState
            icon={TriangleAlertIcon}
            iconClassName="text-destructive/60"
            title="Couldn't load the desk"
            description={<span className="font-mono text-[10px] break-words">{error}</span>}
            action={
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RotateCwIcon />
                Retry
              </Button>
            }
          />
        )}
        {/* A failure WITH data on screen keeps the data and says so — above the
            cards, because an explanation under a full desk is scrolled out of
            view exactly when it is needed. */}
        {view !== null && error && (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Desk didn&apos;t update</AlertTitle>
            <AlertDescription className="font-mono text-[10px] break-words">
              {error}
            </AlertDescription>
          </Alert>
        )}
        {view !== null && cards.length === 0 && (
          <p className="px-1 pt-1 text-[11px] leading-relaxed text-muted-foreground/60">
            Nothing on the desk. Items the agents file land here.
          </p>
        )}
        {/* STORE ORDER, ALWAYS — see rule 1 in this file's header. */}
        {cards.map((card) => (
          <DeskCardRow
            key={card.id}
            card={card}
            touched={state.touched.has(card.id)}
            busy={state.dismissing === card.id}
            onDismiss={() => void dismiss(card.id)}
          />
        ))}
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <Link
          href="/workspace/queue"
          className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          title="Every filed item, dismissed ones included"
        >
          queue
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
            {view?.totalItems ?? ""}
          </span>
        </Link>
        <p className="mt-1 px-2 text-[10px] leading-relaxed text-muted-foreground/60">
          dismissing a card sends it here — nothing is deleted
        </p>
      </div>
    </aside>
  );
}

// MEMOIZED, BECAUSE THE MASTER STREAMS. The rail is the shell's `rail` slot and
// sits outside the transcript's own memo boundary, so without this every `delta`
// frame of a running turn re-renders the whole desk. It takes no props, so the
// comparison is trivially "nothing changed" and the rail re-renders only on its
// own state — which is the only thing that can change what it shows.
export const DeskRail = memo(DeskRailBody);
DeskRail.displayName = "DeskRail";
