"use client";

import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { TELAR_ICONS, type TelarIcon } from "@telar/engine-client";
import { IdentityIcon } from "@/ui/telar-icons";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { cn } from "@/ui/utils";
import { ProjectAvatar } from "./project-avatar";

function iconLabel(id: string): string {
  const words = id.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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
  icon?: string;
  iconName?: TelarIcon | string;
  iconEmoji?: string;
  onPick: (next: TelarIcon | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const choose = (next: TelarIcon | null) => {
    setOpen(false);
    onPick(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="w-44 justify-start gap-2" aria-label="Project icon">
            <ProjectAvatar
              {...(name ? { name } : {})}
              {...(projectId ? { projectId } : {})}
              {...(icon ? { icon } : {})}
              {...(iconName ? { iconName } : {})}
              {...(iconEmoji ? { iconEmoji } : {})}
              size={16}
            />
            <span className="flex-1 truncate text-left text-xs">
              {iconName ? iconLabel(iconName) : iconEmoji ? "Typed mark" : "Auto-detect"}
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
          <ProjectAvatar
            {...(name ? { name } : {})}
            {...(projectId ? { projectId } : {})}
            {...(icon ? { icon } : {})}
            size={16}
          />
          <span className="flex-1">
            Auto-detect
            <span className="block text-2xs text-muted-foreground">
              {icon ? "The icon this checkout carries." : "No icon file found, so the project's initial."}
            </span>
          </span>
        </button>
        <div className="grid max-h-56 grid-cols-8 gap-1 overflow-y-auto">
          {TELAR_ICONS.map((id) => (
            <button
              key={id}
              type="button"
              title={iconLabel(id)}
              aria-label={iconLabel(id)}
              aria-pressed={id === iconName}
              onClick={() => choose(id)}
              className={cn(
                "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                id === iconName && "bg-muted text-foreground ring-1 ring-border",
              )}
            >
              <IdentityIcon icon={id} className="size-4" />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
