"use client";

/**
 * THE LIST OF PROMPTS WAITING TO BE SENT — yours, and the ones an agent wrote.
 *
 * The same object as `composer-menu.tsx` in every respect that the eye can see —
 * same panel, same place above the box, same row geometry — because they are the
 * same gesture with different contents, and two lists that open in one slot and
 * do not match read as a bug in whichever one you saw second.
 *
 * ── TWO BANDS, AND THAT IS THE WHOLE POINT (#87) ────────────────────────────
 * A prompt YOU set aside is your own sentence handed back to you. A prompt an
 * AGENT prepared is a PROPOSAL you have not read yet, and pressing it sends it
 * as though you had written it. Those carry different authority, and a single
 * undifferentiated list quietly erases the difference — so the agent's band sits
 * first, under its own heading, with its own glyph and its own tint, and it says
 * whose it is in words rather than only in colour. A person picking the top row
 * by muscle memory should not be able to send something they never read without
 * the list having told them so.
 *
 * THE DISTINCTION IS NOT CARRIED BY COLOUR ALONE — a heading, a glyph and the
 * agent's own one-line reason all say it, which is what keeps it legible in
 * every Look and to anyone who cannot tell the two tints apart.
 *
 * KEYBOARD ONLY, AS FAR AS THIS COMPONENT IS CONCERNED. Arrows, Enter and the
 * delete chord are the composer's, for the reason its sibling gives: they are
 * typed into the composer. `onMouseDown` is prevented on every row so a click
 * never blurs the editor, which would close the menu before the pick landed.
 *
 * THUMBNAILS ARE THE DATA URL ITSELF. Everywhere else in this app an image
 * preview is an object URL that has to be revoked or it holds the whole file;
 * here the string IS the source, already in memory, and there is nothing to
 * release.
 */

import { FileTextIcon, SparklesIcon, XIcon } from "lucide-react";
import type { ShelfRow } from "@/lib/prompt-shelf";
import { fmtAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ComposerStashMenu({
  agents,
  yours,
  active,
  onActive,
  onPick,
  onDrop,
}: {
  /** Agent-written drafts. Drawn first, under their own heading. */
  agents: readonly ShelfRow[];
  /** Your own set-aside prompts. */
  yours: readonly ShelfRow[];
  /** Index into the two bands CONCATENATED — agents first, exactly as drawn.
   *  The composer owns it, because the keys that move it are typed there. */
  active: number;
  onActive: (index: number) => void;
  onPick: (row: ShelfRow) => void;
  onDrop: (row: ShelfRow) => void;
}) {
  const rows = [...agents, ...yours];
  return (
    <div
      role="listbox"
      aria-label="Prompts waiting to be sent"
      className="absolute inset-x-0 bottom-full z-50 mb-2 overflow-hidden rounded-2xl border border-border/80 bg-popover/95 shadow-3 backdrop-blur-xl"
    >
      {rows.length === 0 ? (
        <>
          <div className="px-3 pt-2 pb-1 text-3xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Stash</div>
          {/* THE ONLY PLACE THE GESTURE IS WRITTEN DOWN. The badge is hidden
              while the shelf is empty, so this line is the whole of the
              feature's discoverability and has to name the key rather than
              describe the idea. */}
          <p className="px-3 pb-3 text-xs text-muted-foreground">Nothing stashed. Press ⌘S with something in the box to put it here.</p>
        </>
      ) : (
        <div className="max-h-72 overflow-y-auto p-1">
          {agents.length > 0 && (
            <div className="px-2 pt-1 pb-1 text-3xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {/* NAMED IN WORDS. "Drafted for you" rather than a coloured dot:
                  the band's meaning must survive a screen reader and a Look
                  that flattens the tint. */}
              Drafted for you
            </div>
          )}
          {rows.map((row, index) => {
            // The first row of the second band gets the heading between them.
            const heading = agents.length > 0 && index === agents.length;
            return (
              <div key={row.key}>
                {heading && (
                  <div className="mt-1 border-t border-border/60 px-2 pt-2 pb-1 text-3xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Stashed by you
                  </div>
                )}
                <div
                  role="option"
                  aria-selected={index === active}
                  // Prevented, not stopped: the editor must keep focus through
                  // the whole gesture or the pick has nowhere to land.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => {
                    if (index !== active) onActive(index);
                  }}
                  className={cn(
                    "group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
                    index === active ? "bg-accent text-accent-foreground" : "text-foreground",
                    // The agent band's own tint, UNDER the selection so the
                    // highlight still reads as the highlight.
                    row.author === "session" && index !== active && "bg-primary/5",
                  )}
                >
                  {row.author === "session" ? (
                    <SparklesIcon aria-hidden className="size-4 shrink-0 text-primary" />
                  ) : (
                    <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  {/* The title is the whole hit area. A row you have to aim at
                      is a row you misfire on with the mouse still moving. */}
                  <button type="button" onClick={() => onPick(row)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate">
                      {row.title}
                      {/* SAID IN WORDS, not only in the glyph and the tint. */}
                      {row.author === "session" && <span className="sr-only"> — drafted by an agent</span>}
                    </span>
                    {/* The agent's own line on why it is offering this. What
                        makes the row something you can judge rather than only
                        recognise. */}
                    {row.reason && <span className="block truncate text-xs text-muted-foreground">{row.reason}</span>}
                  </button>
                  {row.images.length > 0 && (
                    <span className="flex shrink-0 items-center gap-1">
                      {row.images.slice(0, 3).map((image, at) => (
                        // eslint-disable-next-line @next/next/no-img-element -- a data URL held in memory; next/image cannot optimise it
                        <img key={`${row.key}-${at}`} src={image.dataUrl} alt="" className="size-6 rounded object-cover ring-1 ring-border" />
                      ))}
                      {row.images.length > 3 && <span className="text-3xs text-muted-foreground">+{row.images.length - 3}</span>}
                    </span>
                  )}
                  {/* Hidden below the width where the title would be squeezed to
                      nothing to make room for it. */}
                  <span className="hidden shrink-0 text-xs text-muted-foreground @md/composer:inline">{fmtAgo(row.at)}</span>
                  <button
                    type="button"
                    aria-label={row.author === "session" ? "Discard this drafted prompt" : "Remove this stashed prompt"}
                    onClick={() => onDrop(row)}
                    className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
