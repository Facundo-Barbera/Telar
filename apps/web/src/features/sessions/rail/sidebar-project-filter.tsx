"use client";

import { CheckIcon, ChevronDownIcon, FolderGit2Icon } from "lucide-react";
import { ProjectAvatar, type NewConversationTarget } from "@/features/projects";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CAPTION } from "@/lib/idiom";
import { projectFilterKey } from "@/lib/project-filter";
import { cn } from "@/lib/utils";

function groupTargetsByHost(
  targets: readonly NewConversationTarget[],
): { id: string; name: string; targets: NewConversationTarget[] }[] {
  const hosts: { id: string; name: string; targets: NewConversationTarget[] }[] = [];
  for (const target of targets) {
    const id = target.hostId ?? "local";
    const found = hosts.find((host) => host.id === id);
    if (found) found.targets.push(target);
    else hosts.push({ id, name: target.hostName ?? "Local", targets: [target] });
  }
  return hosts;
}

export function SidebarProjectFilter({
  targets,
  selected,
  onToggle,
  onClear,
}: {
  targets: readonly NewConversationTarget[];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onClear: () => void;
}) {
  const hosts = groupTargetsByHost(targets);
  const count = selected.size;
  const label = count ? `Filtering by ${count} ${count === 1 ? "project" : "projects"} — change` : "Filter by project";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            title={label}
            className="flex h-6 shrink-0 items-center gap-1 rounded px-1 text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent"
          />
        }
      >
        <FolderGit2Icon className="size-3.5" />
        {count > 0 && (
          <span className="rounded-sm bg-sidebar-accent px-1 text-3xs font-semibold tabular-nums text-sidebar-foreground/80">{count}</span>
        )}
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-0 p-1">
        <div className="max-h-80 overflow-y-auto" role="group" aria-label="Filter by project">
          {hosts.map((host) => (
            <div key={host.id}>
              {hosts.length > 1 && <p className={cn("px-2 pb-1 pt-1.5", CAPTION)}>{host.name}</p>}
              {host.targets.map((target) => {
                const key = projectFilterKey(target.id, target.hostId);
                const on = selected.has(key);
                return (
                  <button
                    key={key}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => onToggle(key)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">{on && <CheckIcon className="size-3.5" />}</span>
                    <ProjectAvatar
                      name={target.name}
                      {...(target.hostId ? {} : { projectId: target.id })}
                      {...(target.icon ? { icon: target.icon } : {})}
                      {...(target.iconName ? { iconName: target.iconName } : {})}
                      size={14}
                    />
                    <span className="truncate">{target.name}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {count > 0 && (
          <>
            <div aria-hidden className="mx-1 my-1 h-px bg-border" />
            <button
              type="button"
              onClick={onClear}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <span className="size-4 shrink-0" />
              Clear
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
