"use client";

/**
 * WHICH GLYPH MARKS A PROJECT — auto-detect, or one out of a fixed set (#364).
 *
 * AUTO-DETECT IS THE DEFAULT AND IT IS A REAL CHOICE, not the absence of one.
 * It is the first thing in the list, it shows what it currently resolves to
 * (the checkout's own favicon or app icon, else the tinted initial), and picking
 * it WRITES — `null`, which is what removes the stored answer. A reader who
 * marked a project last month and wants the file back should not have to guess
 * that clearing a field is how you say so.
 *
 * A GRID, NOT A SELECT. Forty-odd glyphs in a dropdown list is forty rows to
 * scroll past with one word each; the same set as a grid is one glance, which is
 * how the choice is actually made — by looking, not by reading names. The names
 * are still there as `title`, for anyone arriving by keyboard or pointer-hover.
 */

import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { PROJECT_ICONS, projectGlyph } from "@/lib/project-icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ProjectAvatar } from "./project-avatar";

export function ProjectIconPicker({
  name,
  projectId,
  icon,
  iconName,
  iconEmoji,
  onPick,
}: {
  name?: string;
  projectId?: string;
  /** `Project.icon` — what auto-detect resolves to, when the checkout carries one. */
  icon?: string;
  /** `Project.iconName` — the current pick, or absent for auto-detect. */
  iconName?: string;
  /** `Project.iconEmoji` — a mark typed before this picker existed. */
  iconEmoji?: string;
  /** `null` means auto-detect: remove the stored answer. */
  onPick: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const picked = projectGlyph(iconName);
  const choose = (next: string | null) => {
    setOpen(false);
    onPick(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="w-44 justify-start gap-2" aria-label="Project icon">
            {/* THE TRIGGER SHOWS WHAT THE RAIL WILL SHOW, through the same
                component — so the preview cannot disagree with the thing it is
                previewing when the fallback order changes. */}
            <ProjectAvatar
              {...(name ? { name } : {})}
              {...(projectId ? { projectId } : {})}
              {...(icon ? { icon } : {})}
              {...(iconName ? { iconName } : {})}
              {...(iconEmoji ? { iconEmoji } : {})}
              size={16}
            />
            <span className="flex-1 truncate text-left text-xs">
              {picked ? picked.label : iconEmoji && !iconName ? "Typed mark" : "Auto-detect"}
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-72">
        <button
          type="button"
          onClick={() => choose(null)}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted",
            !iconName && !iconEmoji && "bg-muted",
          )}
        >
          {/* Deliberately WITHOUT `iconName`: this row is what auto-detect
              resolves to, which is a different picture from the current pick. */}
          <ProjectAvatar
            {...(name ? { name } : {})}
            {...(projectId ? { projectId } : {})}
            {...(icon ? { icon } : {})}
            size={16}
          />
          <span className="flex-1">
            Auto-detect
            <span className="block text-[0.6875rem] text-muted-foreground">
              {icon ? "The icon this checkout carries." : "No icon file found, so the project's initial."}
            </span>
          </span>
        </button>
        <div className="grid max-h-56 grid-cols-8 gap-1 overflow-y-auto">
          {PROJECT_ICONS.map(({ id, label, Glyph }) => (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={id === iconName}
              onClick={() => choose(id)}
              className={cn(
                "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                id === iconName && "bg-muted text-foreground ring-1 ring-border",
              )}
            >
              <Glyph className="size-4" />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
