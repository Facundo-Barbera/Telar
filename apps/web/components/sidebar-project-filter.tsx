"use client";

/**
 * THE PROJECT FILTER, AT THE HEAD OF THE FIELD IT NARROWS — issue #470.
 *
 * It began as a row of its own under the search field ("All projects ▾" and a
 * lone `+`), which spent a whole line of a narrow rail on a control most
 * cockpits never change; #395 folded it into the field as a chip; #400 removed
 * it outright. What comes back is deliberately NOT that chip: a chip was one
 * scope at a time, and "these three projects and not the other eleven" — the
 * thing the collapsible groups genuinely cannot express — needs a set.
 *
 * NOTHING CHECKED IS EVERY PROJECT, which is the state the rail starts in and
 * the state "Clear" returns it to. There is no "All projects" row to press,
 * because an empty selection already says it and a row that means "uncheck the
 * other eleven" is a second way to spell the same move.
 *
 * IT REPLACES THE SEARCH GLYPH rather than sitting beside it — `start`'s own
 * contract in `sidebar-search-field.tsx`, and the reason is unchanged from
 * #395: two marks at the head of one field is one too many, and the field's
 * width belongs to what you are typing.
 *
 * ABSENT ON A COCKPIT WITH ONE PROJECT. The caller decides that (it is the same
 * `pickerTargets.length > 1` test the palette uses to skip a question with one
 * answer): with one project registered, "every project" and "that project"
 * select the same rows, so the control would be furniture eating the width of
 * the field.
 *
 * HOST-GROUPED ONLY WHEN THERE ARE HOSTS TO GROUP BY. A cockpit with no paired
 * Mac gets a flat list — a lone "Local" caption over every row in the popover
 * would be a heading that divides nothing.
 */

import { CheckIcon, ChevronDownIcon, FolderGit2Icon } from "lucide-react";
import { ProjectAvatar } from "@/components/projects/project-avatar";
import type { NewConversationTarget } from "@/components/project-palette";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CAPTION } from "@/lib/idiom";
import { projectFilterKey } from "@/lib/project-filter";
import { cn } from "@/lib/utils";

/** The projects under each Mac, this one first — `targets`' own order, which
 *  the rail builds local-first and then in book order. */
export function groupTargetsByHost(
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
  /** The selection AS APPLIED (see `appliedProjectFilter`), so the count on the
   *  trigger and the ticks in the list can never disagree. */
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
        {/* THE COUNT ONLY WHEN THERE IS ONE TO GIVE. Unfiltered the trigger is
            two small glyphs and the field keeps its width for typing; a "0" or
            an "All" spelled out inside a search box is a label competing with a
            placeholder. */}
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
        {/* ONE MOVE BACK TO "EVERY PROJECT", and only while there is something
            to undo. A permanent Clear row is a control that does nothing most
            of the time it is read. */}
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
