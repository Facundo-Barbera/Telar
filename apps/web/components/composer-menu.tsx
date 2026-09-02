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

import { BotIcon, FolderIcon, GaugeIcon, GitBranchIcon, ShieldCheckIcon, SparklesIcon, SquareIcon } from "lucide-react";
import type { Completion, CompletionGlyph } from "@/lib/composer-completions";
import { FileKindIcon } from "@/components/session/file-icon";
import { cn } from "@/lib/utils";

const COMMAND_GLYPHS: Partial<Record<CompletionGlyph, typeof BotIcon>> = {
  access: ShieldCheckIcon,
  model: SparklesIcon,
  effort: GaugeIcon,
  driver: BotIcon,
  env: GitBranchIcon,
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
      className="absolute inset-x-0 bottom-full z-50 mb-2 overflow-hidden rounded-2xl border border-border/80 bg-popover/95 shadow-[0_18px_60px_-30px_rgba(0,0,0,.9)] backdrop-blur-xl"
    >
      <div className="px-3 pt-2 pb-1 text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{heading}</div>
      {completions.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground">{loading ? "Reading…" : emptyText}</p>
      ) : (
        <div className="max-h-72 overflow-y-auto p-1">
          {completions.map((completion, index) => (
            <button
              key={completion.id}
              type="button"
              role="option"
              aria-selected={index === active}
              // Prevented, not stopped: the editor must keep focus through the
              // whole gesture or the pick has nowhere to land.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (index !== active) onActive(index);
              }}
              onClick={() => onPick(completion)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
                index === active ? "bg-accent text-accent-foreground" : "text-foreground",
              )}
            >
              <RowIcon completion={completion} />
              <span className="shrink-0 truncate font-medium">{completion.label}</span>
              {/* The muted half is allowed to be squeezed to nothing; the name
                  is not. A menu that truncates the thing you are aiming at is
                  worse than one that shows no detail at all. */}
              <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">{completion.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
