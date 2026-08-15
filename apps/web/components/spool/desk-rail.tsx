"use client";

/**
 * THE DESK — what arrived while you were elsewhere, beside the chat.
 *
 * CAP-4. Items agents filed land here first, and the rail is how you notice
 * them: not a badge, not a notification, not a count in the sidebar. You see it
 * because you are already looking at this screen. That is the whole of
 * pull-never-push made into a layout decision.
 *
 * ── DISMISS DRAINS, IT DOES NOT DELETE ───────────────────────────────────────
 * The only action here sets `desk: false`, which takes the card off the rail and
 * leaves the item in its lane. The label says "drains to the queue" out loud
 * rather than saying "dismiss" and letting the user guess whether they just lost
 * something — the module has no delete path anywhere, and a surface that reads
 * like it does is the same lie told by the UI instead of the store.
 *
 * ── NO COUNT, ANYWHERE ───────────────────────────────────────────────────────
 * The rail shows the cards. It does not tell you how many there are before you
 * look, because a number you can see from elsewhere is a badge with extra steps.
 */
import { useState } from "react";
import Link from "next/link";
import { InboxIcon } from "lucide-react";
import type { SpoolDeskCard } from "@telar/engine-client";
import { cn } from "@/lib/utils";

export function DeskRail({ cards }: { cards: SpoolDeskCard[] }) {
  /** Drained cards leave immediately rather than after a refetch: the write is
   *  the user's own click and the rail should answer it at the speed of the
   *  click. The store is the source of truth on the next read. */
  const [drained, setDrained] = useState<string[]>([]);
  const shown = cards.filter((card) => !drained.includes(card.id));

  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l border-border lg:flex">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-[10px] font-medium tracking-wider text-muted-foreground/70 uppercase">The desk</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/60">
          What agents filed for you. Nothing here has started.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <InboxIcon className="size-5 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground/60">Nothing on the desk.</p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {shown.map((card) => (
              <li key={card.id} className="rounded-lg border border-border bg-card p-2.5">
                <Link
                  href={`/spool/${encodeURIComponent(card.id)}`}
                  className="block text-xs leading-snug text-foreground hover:underline"
                >
                  {card.title}
                </Link>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  {/* `hint` is the card's one line of context, and it is
                      optional — an item filed with nothing to say shows its
                      subject alone rather than a trailing separator. */}
                  <span className={cn("truncate font-mono text-[10px]", "text-muted-foreground/60")}>
                    {card.project ?? "floating"}
                    {card.hint ? ` · ${card.hint}` : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setDrained((previous) => [...previous, card.id]);
                      void fetch(`/api/spool/items/${encodeURIComponent(card.id)}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ desk: false }),
                      }).catch(() => undefined);
                    }}
                    className="shrink-0 text-[10px] text-muted-foreground/70 underline decoration-dotted transition-colors hover:text-foreground"
                    // SAID PLAINLY, because the word "dismiss" alone reads as
                    // deletion to anyone who has used any other tracker.
                    title="Take it off the desk — it stays in the queue"
                  >
                    drain
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
