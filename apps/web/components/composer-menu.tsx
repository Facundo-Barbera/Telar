"use client";

/**
 * THE LIST THAT OPENS WHEN YOU TYPE `@` OR `/`.
 *
 * It sits ABOVE the composer, not beside the caret. Anchoring to the caret is
 * what a code editor does because its viewport is the document; here the box is
 * five lines tall at the bottom of the screen, so a caret-anchored panel spends
 * its life either clipped by the window or covering the sentence being written.
 * Above the box it is always the same size in the same place, which is the
 * property that lets somebody use it without looking at it.
 *
 * KEYBOARD ONLY, AS FAR AS THIS COMPONENT IS CONCERNED. Arrow keys and Enter
 * are handled by the composer, because they are the composer's keys — this draws
 * what is highlighted and reports what was clicked. `onMouseDown` is prevented
 * on every row so a click never blurs the editor: losing focus mid-pick would
 * close the menu before the pick landed.
 */

import { Fragment } from "react";
import { BotIcon, FolderIcon, GaugeIcon, GitBranchIcon, Minimize2Icon, NotebookPenIcon, ShieldCheckIcon, SparklesIcon, SquareIcon, WandSparklesIcon } from "lucide-react";
import type { Completion, CompletionGlyph } from "@/lib/composer-completions";
import { FileKindIcon } from "@/components/session/file-icon";
import { cn } from "@/lib/utils";

const COMMAND_GLYPHS: Partial<Record<CompletionGlyph, typeof BotIcon>> = {
  // Not a command, but it reaches the same table: a note row's glyph is the one
  // the strip and the chip already use, so the three spellings of "a note" are
  // recognisable as the same object.
  note: NotebookPenIcon,
  access: ShieldCheckIcon,
  model: SparklesIcon,
  effort: GaugeIcon,
  driver: BotIcon,
  env: GitBranchIcon,
  // The glyph the usage wheel's own Compact button wears — same gesture, two
  // places to reach it.
  compact: Minimize2Icon,
  // The same glyph the chip a skill inserts draws (`glyph-paths.ts`), so the
  // row you picked and the chip it produced are recognisably one thing.
  skill: WandSparklesIcon,
  stop: SquareIcon,
};

function RowIcon({ completion }: { completion: Completion }) {
  if (completion.glyph === "file" && completion.path) return <FileKindIcon path={completion.path} className="size-4" />;
  if (completion.glyph === "directory") return <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
  const Glyph = COMMAND_GLYPHS[completion.glyph] ?? BotIcon;
  return <Glyph aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

export function ComposerMenu({
  completions,
  active,
  heading,
  loading,
  emptyText,
  onActive,
  onPick,
}: {
  completions: readonly Completion[];
  /** Index into `completions`. The composer owns it, because the keys that
   *  move it are typed into the composer. */
  active: number;
  heading: string;
  loading?: boolean;
  emptyText: string;
  onActive: (index: number) => void;
  onPick: (completion: Completion) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label={heading}
      // `shadow-3` — the ladder's overlay rung (globals.css). It used to carry
      // the composer's own arbitrary value, which made a MENU and the bar it
      // opens from cast exactly the same shadow: they read as one slab. This
      // sits directly above that bar and should sit a rung above it too.
      className="absolute inset-x-0 bottom-full z-50 mb-2 overflow-hidden rounded-2xl border border-border/80 bg-popover/95 shadow-3 backdrop-blur-xl"
    >
      <div className="px-3 pt-2 pb-1 text-3xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{heading}</div>
      {completions.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground">{loading ? "Reading…" : emptyText}</p>
      ) : (
        <div className="max-h-72 overflow-y-auto p-1">
          {completions.map((completion, index) => (
            <Fragment key={completion.id}>
            {/* A GROUP HEADING WHERE THE GROUP CHANGES, and nowhere else. The
                provider's commands sit under one; Telar's own verbs are the
                menu's subject and already carry its title, so they do not get
                a second label saying so. */}
            {completion.group && completion.group !== completions[index - 1]?.group && (
              <div className="px-2 pt-2 pb-1 text-3xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {completion.group}
              </div>
            )}
            <button
              type="button"
              role="option"
              aria-selected={index === active}
              // Still focusable by the arrow keys and still highlighted: the
              // row is on screen to be READ, and skipping it would make the
              // reason it carries the one thing you cannot land on.
              aria-disabled={completion.disabled ? true : undefined}
              // Prevented, not stopped: the editor must keep focus through the
              // whole gesture or the pick has nowhere to land. Which is also
              // why this row carries no focus ring: it can never be the focused
              // element, so `:focus-visible` would be dead CSS. `aria-selected`
              // plus the `bg-accent` fill below IS the keyboard affordance.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (index !== active) onActive(index);
              }}
              onClick={() => onPick(completion)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
                index === active ? "bg-accent text-accent-foreground" : "text-foreground",
                completion.disabled && "cursor-not-allowed opacity-50",
              )}
            >
              <RowIcon completion={completion} />
              <span className="shrink-0 truncate font-medium">{completion.label}</span>
              {/* The muted half is allowed to be squeezed to nothing; the name
                  is not. A menu that truncates the thing you are aiming at is
                  worse than one that shows no detail at all. */}
              <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">{completion.detail}</span>
            </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
