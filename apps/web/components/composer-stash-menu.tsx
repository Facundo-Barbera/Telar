"use client";

/**
 * THE LIST OF PROMPTS YOU SET ASIDE.
 *
 * The same object as `composer-menu.tsx` in every respect that the eye can see —
 * same panel, same place above the box, same row geometry — because they are the
 * same gesture with different contents, and two lists that open in one slot and
 * do not match read as a bug in whichever one you saw second.
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

import { FileTextIcon, XIcon } from "lucide-react";
import { entrySummary, type StashEntry } from "@/lib/prompt-stash";
import { fmtAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ComposerStashMenu({
  entries,
  active,
  onActive,
  onPick,
  onDrop,
}: {
  entries: readonly StashEntry[];
  /** Index into `entries`. The composer owns it, because the keys that move it
   *  are typed into the composer. */
  active: number;
  onActive: (index: number) => void;
  onPick: (entry: StashEntry) => void;
  onDrop: (entry: StashEntry) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Stashed prompts"
      className="absolute inset-x-0 bottom-full z-50 mb-2 overflow-hidden rounded-2xl border border-border/80 bg-popover/95 shadow-[0_18px_60px_-30px_var(--shadow-tint)] backdrop-blur-xl"
    >
      <div className="px-3 pt-2 pb-1 text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Stash</div>
      {entries.length === 0 ? (
        // THE ONLY PLACE THE GESTURE IS WRITTEN DOWN. The badge is hidden while
        // the stash is empty, so this line is the whole of the feature's
        // discoverability and has to name the key rather than describe the idea.
        <p className="px-3 pb-3 text-xs text-muted-foreground">Nothing stashed. Press ⌘S with something in the box to put it here.</p>
      ) : (
        <div className="max-h-72 overflow-y-auto p-1">
          {entries.map((entry, index) => (
            <div
              key={entry.id}
              role="option"
              aria-selected={index === active}
              // Prevented, not stopped: the editor must keep focus through the
              // whole gesture or the pick has nowhere to land.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (index !== active) onActive(index);
              }}
              className={cn(
                "group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
                index === active ? "bg-accent text-accent-foreground" : "text-foreground",
              )}
            >
              <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              {/* The summary is the whole hit area. A row you have to aim at is
                  a row you misfire on with the mouse still moving. */}
              <button type="button" onClick={() => onPick(entry)} className="min-w-0 flex-1 truncate text-left">
                {entrySummary(entry)}
              </button>
              {entry.images.length > 0 && (
                <span className="flex shrink-0 items-center gap-1">
                  {entry.images.slice(0, 3).map((image, at) => (
                    // eslint-disable-next-line @next/next/no-img-element -- a data URL held in memory; next/image cannot optimise it
                    <img key={`${entry.id}-${at}`} src={image.dataUrl} alt="" className="size-6 rounded object-cover ring-1 ring-border" />
                  ))}
                  {entry.images.length > 3 && <span className="text-[0.625rem] text-muted-foreground">+{entry.images.length - 3}</span>}
                </span>
              )}
              {/* Hidden below the width where the summary would be squeezed to
                  nothing to make room for it. */}
              <span className="hidden shrink-0 text-xs text-muted-foreground @md/composer:inline">{fmtAgo(entry.at)}</span>
              <button
                type="button"
                aria-label="Remove this stashed prompt"
                onClick={() => onDrop(entry)}
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
